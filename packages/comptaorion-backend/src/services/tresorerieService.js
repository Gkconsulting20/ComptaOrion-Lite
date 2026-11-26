// Trésorerie — alimentation par les encaissements (ComptaOrioLite).
//
// Problème (exercice 2026, entreprise test 13) : 1 781 800 FCFA
// encaissés (ventes comptant + paiements de factures à crédit) mais
// AUCUNE ligne dans transactions_tresorerie — le module Trésorerie
// était vide. Deux causes :
//   1. POST /factures/:id/paiement n'écrivait dans
//      transactions_tresorerie que si un compteBancaireId était fourni
//      (et jamais pour les espèces sans compte bancaire) ;
//   2. POST /factures/lite-sale (vente comptant) n'écrivait jamais
//      dans transactions_tresorerie.
// Or transactions_tresorerie.compte_bancaire_id est NOT NULL : un
// encaissement en espèces sans compte bancaire ne pouvait pas y être
// inscrit tel quel.
//
// Correction : tout encaissement de facture passe par
// enregistrerEncaissementTresorerie, qui retrouve ou crée le compte de
// trésorerie « Caisse » de l'entreprise (type 'caisse', lié au compte
// comptable 57 quand il existe) pour les espèces. Les chèques restent
// exclus : ils n'alimentent la trésorerie qu'au dépôt
// (POST /cheques-clients/:id/depot). Un virement sans compte bancaire
// désigné n'écrit toujours rien (aucun compte inventé) : l'entreprise
// doit rattacher son compte bancaire.

import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db.js';
import { comptesBancaires, transactionsTresorerie } from '../schema.js';
import { getCompteByNumero } from './comptabiliteService.js';

const NOM_COMPTE_CAISSE = 'Caisse';

/**
 * Compte de trésorerie « Caisse » de l'entreprise (type 'caisse').
 * Créé à la demande, lié au compte comptable 57 quand il existe — ce
 * n'est pas un compte comptable inventé, juste le compte de trésorerie
 * qui permet au module Trésorerie d'afficher les espèces.
 */
export async function getOrCreateCaisseAccount({ entrepriseId, executor = db }) {
  const [existing] = await executor.select().from(comptesBancaires).where(and(
    eq(comptesBancaires.entrepriseId, entrepriseId),
    eq(comptesBancaires.type, 'caisse'),
    eq(comptesBancaires.actif, true),
  )).orderBy(asc(comptesBancaires.id)).limit(1);
  if (existing) return existing;

  const compteCaisse = await getCompteByNumero(entrepriseId, '57', executor);
  const [created] = await executor.insert(comptesBancaires).values({
    entrepriseId,
    nomCompte: NOM_COMPTE_CAISSE,
    type: 'caisse',
    compteComptableId: compteCaisse?.id || null,
    soldeInitial: '0',
    soldeActuel: '0',
    actif: true,
  }).returning();
  return created;
}

/**
 * Enregistre un encaissement de facture dans transactions_tresorerie et
 * met à jour le solde du compte. Retourne la transaction créée, ou null
 * quand aucun mouvement n'est enregistré (chèque : dépôt ultérieur ;
 * virement sans compte bancaire désigné).
 */
export async function enregistrerEncaissementTresorerie({
  entrepriseId,
  montant,
  dateTransaction,
  reference,
  numeroPiece,
  modePaiement,
  compteBancaireId = null,
  description,
  categorie = 'Vente',
  tiersNom = null,
  userId = null,
  executor = db,
}) {
  const amount = Math.round(Number(montant) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error("Le montant de l'encaissement doit être positif."), { status: 400 });
  }
  // Un chèque reçu crédite le client mais n'augmente la trésorerie
  // qu'au dépôt (route /cheques-clients/:id/depot).
  if (modePaiement === 'cheque') return null;

  let compte;
  if (compteBancaireId) {
    [compte] = await executor.select().from(comptesBancaires).where(and(
      eq(comptesBancaires.id, Number(compteBancaireId)),
      eq(comptesBancaires.entrepriseId, entrepriseId),
      eq(comptesBancaires.actif, true),
    )).limit(1);
    if (!compte) {
      throw Object.assign(new Error('Compte bancaire introuvable'), { status: 400 });
    }
  } else if (modePaiement === 'especes') {
    compte = await getOrCreateCaisseAccount({ entrepriseId, executor });
  } else {
    // Virement, mobile money, carte sans compte désigné : on n'invente
    // pas de compte bancaire — l'entreprise doit rattacher le sien.
    return null;
  }

  const [transaction] = await executor.insert(transactionsTresorerie).values({
    entrepriseId,
    compteBancaireId: compte.id,
    type: 'encaissement',
    montant: amount.toFixed(2),
    dateTransaction: dateTransaction || new Date().toISOString().slice(0, 10),
    categorie,
    description: description || `Encaissement ${reference || ''}`.trim(),
    tiersNom,
    numeroPiece: numeroPiece || reference || null,
    modePaiement,
    userId,
  }).returning();

  await executor.update(comptesBancaires).set({
    soldeActuel: sql`${comptesBancaires.soldeActuel} + ${amount.toFixed(2)}`,
    updatedAt: new Date(),
  }).where(and(
    eq(comptesBancaires.id, compte.id),
    eq(comptesBancaires.entrepriseId, entrepriseId),
  ));

  return transaction;
}
