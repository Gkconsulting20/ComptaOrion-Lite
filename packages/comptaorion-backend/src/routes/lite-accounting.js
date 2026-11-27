import express from 'express';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import { db } from '../db.js';
import {
  clients,
  comptesBancaires,
  comptesComptables,
  ajustementsTiers,
  factures,
  factureItems,
  paiements,
  retoursMarchandises,
  transactionsTresorerie,
} from '../schema.js';
import { createEcritureComptable, getCompteByNumero } from '../services/comptabiliteService.js';
import {
  buildCustomerDebitNoteLines,
  buildChequeDepositLines,
  calculateEarlyPaymentDiscount,
} from '../services/liteAccountingRules.js';
import { buildThirdPartyLedger } from '../services/accountLedger.js';

const router = express.Router();
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// Lecture tolérante pour les tables optionnelles (retours, ajustements) : sur les
// bases créées avant la migration 20261103, ces tables n'existent pas encore —
// leur absence ne doit pas faire échouer tout le relevé (elles sont vides par
// définition dans ce cas). La migration reste nécessaire pour les fonctionnalités
// de retours/ajustements (création d'avoirs et de notes).
const optionalSelect = async (query) => {
  try {
    return await query;
  } catch (error) {
    console.warn('Relevé tiers : table optionnelle indisponible, ignorée :', error?.cause?.message || error?.message);
    return [];
  }
};
const validDate = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function requiredAccount(entrepriseId, number, tx) {
  const account = await getCompteByNumero(entrepriseId, number, tx);
  if (!account) throw fail(`Le compte comptable ${number} doit être configuré`, 409);
  return account;
}

async function createAdjustmentNote({ req, type, sourceId, body }) {
  // Note de débit client uniquement (Lite services uniquement) : la
  // branche « crédit fournisseur » est retirée avec les achats.
  const dateNote = body?.dateNote || new Date().toISOString().slice(0, 10);
  const totalHT = round2(Number(body?.totalHT));
  const totalTVA = round2(Number(body?.totalTVA || 0));
  const compteAjustementId = Number(body?.compteAjustementId);
  const motif = String(body?.motif || '').trim().slice(0, 500);
  if (!validDate(dateNote) || !Number.isFinite(totalHT) || totalHT <= 0
    || !Number.isFinite(totalTVA) || totalTVA < 0
    || !Number.isInteger(compteAjustementId) || compteAjustementId < 1
    || motif.length < 3) {
    throw fail('Date, montants, compte d’ajustement et motif valides requis');
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM factures
      WHERE id = ${sourceId} AND entreprise_id = ${req.entrepriseId}
      FOR UPDATE`);
    const [invoice] = await tx.select().from(factures).where(and(
      eq(factures.id, sourceId),
      eq(factures.entrepriseId, req.entrepriseId),
    )).limit(1);
    if (!invoice) throw fail('Facture introuvable', 404);
    if (dateNote < String(invoice.dateFacture || '')) throw fail('La date de la note ne peut pas précéder la facture');

    const [adjustmentAccount] = await tx.select().from(comptesComptables).where(and(
      eq(comptesComptables.id, compteAjustementId),
      eq(comptesComptables.entrepriseId, req.entrepriseId),
      eq(comptesComptables.actif, true),
      like(comptesComptables.numero, '7%'),
      sql`length(${comptesComptables.numero}) >= 3`,
    )).limit(1);
    if (!adjustmentAccount) throw fail('Compte d’ajustement invalide pour ce type de note', 400);

    const [thirdParty] = await tx.select().from(clients).where(and(
      eq(clients.id, invoice.clientId),
      eq(clients.entrepriseId, req.entrepriseId),
    )).limit(1);
    if (!thirdParty) throw fail('Compte client introuvable', 404);

    const totalTTC = round2(totalHT + totalTVA);
    const number = `NDCL-${dateNote.replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [note] = await tx.insert(ajustementsTiers).values({
      entrepriseId: req.entrepriseId,
      type,
      numero: number,
      factureId: sourceId,
      factureAchatId: null,
      clientId: thirdParty.id,
      fournisseurId: null,
      dateNote,
      totalHT: totalHT.toFixed(2),
      totalTVA: totalTVA.toFixed(2),
      totalTTC: totalTTC.toFixed(2),
      compteAjustementId,
      motif,
      userId: req.user.id,
    }).returning();

    const newBalance = round2(Number(invoice.soldeRestant || 0) + totalTTC);
    await tx.update(factures).set({
      soldeRestant: newBalance.toFixed(2),
      statut: invoice.statut === 'payee' ? 'envoyee' : invoice.statut,
      updatedAt: new Date(),
    }).where(and(eq(factures.id, sourceId), eq(factures.entrepriseId, req.entrepriseId)));
    const customerAccount = await requiredAccount(req.entrepriseId, '411', tx);
    const vatAccount = totalTVA > 0 ? await requiredAccount(req.entrepriseId, '443', tx) : null;
    const lines = buildCustomerDebitNoteLines({
      customerAccountId: customerAccount.id,
      adjustmentAccountId: adjustmentAccount.id,
      vatAccountId: vatAccount?.id,
      totalHT,
      totalTVA,
      totalTTC,
      reference: number,
    });
    const entry = await createEcritureComptable({
      entrepriseId: req.entrepriseId,
      journalCode: 'VT',
      journalNom: 'Journal des Ventes',
      journalType: 'ventes',
      dateEcriture: dateNote,
      libelle: `Note de débit client ${number}`,
      numeroPiece: number,
      lignes: lines,
      valide: true,
      executor: tx,
    });
    if (!entry) throw new Error('Écriture de la note de débit client non générée');
    return { note, soldeRestant: newBalance };
  });
}

router.get('/comptes-comptables-ajustement', async (req, res) => {
  // Client uniquement (Lite services uniquement) : le type fournisseur
  // est retiré avec les achats.
  const prefix = req.query.type === 'client' ? '7%' : null;
  if (!prefix) return res.status(400).json({ success: false, message: 'Type client requis' });
  try {
    const accounts = await db.select({
      id: comptesComptables.id,
      numero: comptesComptables.numero,
      nom: comptesComptables.nom,
    }).from(comptesComptables).where(and(
      eq(comptesComptables.entrepriseId, req.entrepriseId),
      eq(comptesComptables.actif, true),
      like(comptesComptables.numero, prefix),
      sql`length(${comptesComptables.numero}) >= 3`,
    )).orderBy(asc(comptesComptables.numero));
    return res.json({ success: true, data: accounts });
  } catch {
    return res.status(500).json({ success: false, message: 'Impossible de charger les comptes d’ajustement' });
  }
});

router.put('/clients/:id/conditions-escompte', async (req, res) => {
  const clientId = Number(req.params.id);
  if (!Number.isInteger(clientId) || clientId < 1) return res.status(400).json({ success: false, message: 'Client invalide' });
  try {
    const terms = validateDiscountTerms(req.body);
    const [updated] = await db.update(clients).set({ ...terms, updatedAt: new Date() }).where(and(
      eq(clients.id, clientId),
      eq(clients.entrepriseId, req.entrepriseId),
    )).returning();
    if (!updated) return res.status(404).json({ success: false, message: 'Client introuvable' });
    return res.json({ success: true, data: {
      id: updated.id,
      nom: updated.nom,
      escomptePourcentage: Number(updated.escomptePourcentage),
      escompteDelaiJours: updated.escompteDelaiJours,
      delaiPaiement: updated.delaiPaiement,
    } });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Impossible de mettre à jour les conditions d’escompte' });
  }
});

router.post('/factures/:id/notes-debit', async (req, res) => {
  const invoiceId = Number(req.params.id);
  if (!Number.isInteger(invoiceId) || invoiceId < 1) return res.status(400).json({ success: false, message: 'Facture invalide' });
  try {
    const data = await createAdjustmentNote({ req, type: 'debit_client', sourceId: invoiceId, body: req.body });
    return res.status(201).json({ success: true, message: 'Note de débit client créée sans mouvement de stock', data });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Impossible de créer la note de débit client' });
  }
});

router.get('/cheques-clients', async (req, res) => {
  try {
    const rows = await db.select({
      paiement: paiements,
      client: { id: clients.id, nom: clients.nom },
      facture: { id: factures.id, numeroFacture: factures.numeroFacture },
    }).from(paiements)
      .leftJoin(clients, and(
        eq(paiements.clientId, clients.id),
        eq(clients.entrepriseId, req.entrepriseId),
      ))
      .leftJoin(factures, and(
        eq(paiements.factureId, factures.id),
        eq(factures.entrepriseId, req.entrepriseId),
      ))
      .where(and(
        eq(paiements.entrepriseId, req.entrepriseId),
        eq(paiements.modePaiement, 'cheque'),
        eq(paiements.statutCheque, 'a_deposer'),
      ))
      .orderBy(asc(paiements.datePaiement), asc(paiements.id));
    return res.json({ success: true, data: rows });
  } catch {
    return res.status(500).json({ success: false, message: 'Impossible de charger les chèques à déposer' });
  }
});

router.get('/comptes-bancaires-lite', async (req, res) => {
  try {
    const accounts = await db.select({
      id: comptesBancaires.id,
      nomCompte: comptesBancaires.nomCompte,
      banque: comptesBancaires.banque,
      soldeActuel: comptesBancaires.soldeActuel,
      actif: comptesBancaires.actif,
    }).from(comptesBancaires)
      .where(and(
        eq(comptesBancaires.entrepriseId, req.entrepriseId),
        eq(comptesBancaires.actif, true),
      ))
      .orderBy(asc(comptesBancaires.nomCompte));
    return res.json({ success: true, data: accounts });
  } catch {
    return res.status(500).json({ success: false, message: 'Impossible de charger les comptes bancaires' });
  }
});

router.post('/cheques-clients/:id/depot', async (req, res) => {
  try {
    const paymentId = Number(req.params.id);
    const bankId = Number(req.body?.compteBancaireId);
    const dateDepot = req.body?.dateDepot || new Date().toISOString().slice(0, 10);
    if (!Number.isInteger(paymentId) || paymentId < 1 || !Number.isInteger(bankId) || bankId < 1 || !validDate(dateDepot)) {
      return res.status(400).json({ success: false, message: 'Chèque, compte bancaire et date de dépôt valides requis' });
    }
    const data = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM paiements WHERE id = ${paymentId}
        AND entreprise_id = ${req.entrepriseId} FOR UPDATE`);
      const [payment] = await tx.select().from(paiements)
        .where(and(
          eq(paiements.id, paymentId),
          eq(paiements.entrepriseId, req.entrepriseId),
          eq(paiements.modePaiement, 'cheque'),
          eq(paiements.statutCheque, 'a_deposer'),
        )).limit(1);
      if (!payment) throw fail('Chèque introuvable ou déjà déposé', 409);
      const [bank] = await tx.select().from(comptesBancaires).where(and(
        eq(comptesBancaires.id, bankId),
        eq(comptesBancaires.entrepriseId, req.entrepriseId),
        eq(comptesBancaires.actif, true),
      )).limit(1);
      if (!bank) throw fail('Compte bancaire introuvable', 404);
      const amount = Number(payment.montant);
      const [updatedPayment] = await tx.update(paiements).set({
        statutCheque: 'depose',
        dateDepotCheque: dateDepot,
        compteBancaireDepotId: bankId,
      }).where(and(
        eq(paiements.id, paymentId),
        eq(paiements.entrepriseId, req.entrepriseId),
        eq(paiements.statutCheque, 'a_deposer'),
      )).returning();
      if (!updatedPayment) throw fail('Ce chèque a déjà été déposé', 409);

      await tx.insert(transactionsTresorerie).values({
        entrepriseId: req.entrepriseId,
        compteBancaireId: bankId,
        type: 'encaissement',
        montant: amount.toFixed(2),
        dateTransaction: dateDepot,
        categorie: 'Dépôt de chèque client',
        description: `Dépôt du chèque ${payment.numeroCheque || payment.id}`,
        numeroPiece: payment.reference || `PAI-${payment.id}`,
        modePaiement: 'cheque',
        userId: req.user.id,
      });
      await tx.update(comptesBancaires).set({
        soldeActuel: sql`${comptesBancaires.soldeActuel} + ${amount.toFixed(2)}`,
        updatedAt: new Date(),
      }).where(and(
        eq(comptesBancaires.id, bankId),
        eq(comptesBancaires.entrepriseId, req.entrepriseId),
      ));

      const bankAccount = bank.compteComptableId
        ? { id: bank.compteComptableId }
        : await requiredAccount(req.entrepriseId, '52', tx);
      const chequeAccount = await requiredAccount(req.entrepriseId, '513', tx);
      await createEcritureComptable({
        entrepriseId: req.entrepriseId,
        journalCode: 'BQ',
        journalNom: 'Journal de Banque',
        journalType: 'banque',
        dateEcriture: dateDepot,
        libelle: `Dépôt du chèque ${payment.numeroCheque || payment.id}`,
        numeroPiece: payment.reference || `PAI-${payment.id}`,
        lignes: buildChequeDepositLines({
          bankAccountId: bankAccount.id,
          chequeAccountId: chequeAccount.id,
          amount,
          reference: payment.numeroCheque || payment.id,
        }),
        valide: true,
        executor: tx,
      });
      return { payment: updatedPayment, bank: { id: bank.id, nomCompte: bank.nomCompte } };
    });
    return res.json({ success: true, message: 'Dépôt enregistré; le compte client n’a pas été modifié une seconde fois', data });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Impossible d’enregistrer le dépôt' });
  }
});

router.get('/clients/:id/compte', async (req, res) => {
  try {
    const clientId = Number(req.params.id);
    const [client] = await db.select().from(clients).where(and(
      eq(clients.id, clientId),
      eq(clients.entrepriseId, req.entrepriseId),
    )).limit(1);
    if (!client) return res.status(404).json({ success: false, message: 'Client introuvable' });

    const [invoices, receipts, credits, adjustments] = await Promise.all([
      db.select().from(factures).where(and(
        eq(factures.entrepriseId, req.entrepriseId),
        eq(factures.clientId, clientId),
      )),
      db.select().from(paiements).where(and(
        eq(paiements.entrepriseId, req.entrepriseId),
        eq(paiements.clientId, clientId),
      )),
      optionalSelect(db.select().from(retoursMarchandises).where(and(
        eq(retoursMarchandises.entrepriseId, req.entrepriseId),
        eq(retoursMarchandises.clientId, clientId),
        eq(retoursMarchandises.type, 'client'),
      ))),
      optionalSelect(db.select().from(ajustementsTiers).where(and(
        eq(ajustementsTiers.entrepriseId, req.entrepriseId),
        eq(ajustementsTiers.clientId, clientId),
        eq(ajustementsTiers.type, 'debit_client'),
      ))),
    ]);
    const ledger = buildThirdPartyLedger({
      partyType: 'client',
      invoices,
      payments: receipts,
      returns: credits,
      adjustments,
    });
    return res.json({
      success: true,
      data: { tiers: { id: client.id, nom: client.nom }, ...ledger },
    });
  } catch {
    return res.status(500).json({ success: false, message: 'Impossible de charger le compte client' });
  }
});

export default router;
