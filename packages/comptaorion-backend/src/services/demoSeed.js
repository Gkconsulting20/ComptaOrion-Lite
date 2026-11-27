// Mode démo public — ComptaOrioLite (27 nov. 2026).
//
// Une entreprise démo par visiteur/session : un vrai tenant (JWT +
// RLS + entrepriseIsolation), marqué is_demo, avec une ligne
// saasClients 'actif' créée DANS LA MÊME transaction que l'entreprise
// (sinon getSaasAccess auto-créerait une ligne 'trial' legacy et la
// démo expirerait en 30 jours). Aucun abonnement n'est créé : la garde
// d'essai Lite ne lit que saasClients. Essai 30 j et 2 mois gratuits NE
// s'appliquent PAS à la démo.
//
// Le seed passe par les services métier existants (écritures
// automatiques) — jamais d'insert direct dans factures/ecritures sans
// l'écriture correspondante. Dates relatives à `now` (30 derniers
// jours), montants FCFA réalistes, noms fictifs togolais.
// PAS d'achats, PAS de fournisseurs, PAS de stock (Lite = services).
//
// Cohérence financière du seed (vérifiée à la main, voir le test
// d'exercice en direct) :
// - Banque 138 000 (ouverture 200 000 + virement F1 177 000 − loyer
//   180 000 − consommables 32 000 − TVA octobre 27 000)
// - Caisse 3 500 (espèces F2 88 500 − électricité 45 000 − transport
//   25 000 − remboursement 15 000) ; TMoney 70 000 (partiel F3)
// - Clients 148 300 (F3 65 700 + F4 29 500 + F5 70 800 − avoir 17 700)
// - TVA collectée nov. 46 800, déductible nov. 6 864, à décaisser 39 936
// - TVA octobre : collectée 27 000, déclarée et payée (déclaration
//   'payée' + écriture D 4434 / C 52) ; mois en cours à déclarer.
// - Résultat 99 864 (produits nets 410 000 − charges 310 136) ;
//   bilan équilibré (actif 393 664 = passif 393 664).
// Écarts connus, fidèles au comportement actuel de l'application :
// - les ventes de prestations sont créditées au 701 par le service
//   partagé createEcritureFactureVente (le 705 n'est pas utilisé) ;
// - Lite n'a pas de route d'avoir client : l'avoir est une ligne
//   ajustements_tiers (type 'credit_client') + écriture OD
//   D 709 / D 443 / C 411, et le solde de la facture devient −17 700 ;
// - le paiement de TVA laisse un solde débiteur au 4434, comme la
//   route POST /declarations/:id/payer le produit aujourd'hui.

import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../db.js';
import {
  entreprises, users, saasClients, sessions, auditConnexions,
  clients, produits, devis, devisItems, factures, factureItems, paiements,
  comptesComptables, comptesBancaires, categoriesDepenses, depenses,
  approvalsDepenses, remboursementsEmployes, employes,
  parametresFiscaux, declarationsFiscales, ajustementsTiers,
} from '../schema.js';
import { hashPassword, generateToken, generateRefreshToken } from '../auth.js';
import { initializeSyscohadaForEnterprise } from './syscohadaService.js';
import {
  createEcritureComptable, createEcritureFactureVente,
  createEcriturePaiementClient, createEcritureDepenseLite,
  createEcritureChargeNoteFraisLite, resolveCompteChargeLite,
} from './comptabiliteService.js';
import {
  enregistrerEncaissementTresorerie, enregistrerDecaissementTresorerie,
} from './tresorerieService.js';
import { checkDemoRateLimit, recordDemoCreation, deleteEnterpriseData } from './trialLifecycle.js';

export const DEMO_EMAIL_DOMAIN = 'demo.comptaorion.com';
const TVA_RATE = 0.18;
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (base, days) => { const d = new Date(base); d.setDate(d.getDate() + days); return d; };

// Identifiants globalement uniques, préfixés DEMO-<entrepriseId>-…
// (R1 : jamais CLI-001 / EMP-001 / PRD-001 nus, sinon la 2e démo
// échoue en 23505 sur les unicités globales).
export function buildDemoIdentifiers(entrepriseId) {
  const p = `DEMO-${entrepriseId}`;
  return {
    clientNumber: (n) => `${p}-CLI-${String(n).padStart(3, '0')}`,
    productReference: (n) => `${p}-PRD-${String(n).padStart(3, '0')}`,
    employeeMatricule: `${p}-EMP-01`,
    invoiceNumber: (year, n) => `FACT-${year}-${entrepriseId}-${String(n).padStart(4, '0')}`,
    quoteNumber: (year, n) => `DEV-${year}-${entrepriseId}-${String(n).padStart(4, '0')}`,
  };
}

async function getCompteExact(entrepriseId, numero, executor) {
  const [compte] = await executor.select().from(comptesComptables).where(and(
    eq(comptesComptables.entrepriseId, entrepriseId),
    eq(comptesComptables.numero, numero),
  )).limit(1);
  if (!compte) throw new Error(`Compte comptable ${numero} introuvable pour l'entreprise démo ${entrepriseId}.`);
  return compte;
}

function totalsHT(lines) {
  const totalHT = round2(lines.reduce((s, l) => s + l.quantite * l.prixUnitaire * (1 - (l.remise || 0) / 100), 0));
  const totalTVA = round2(totalHT * TVA_RATE);
  return { totalHT, totalTVA, totalTTC: round2(totalHT + totalTVA) };
}

async function createInvoice(tx, ctx, { numero, client, date, echeance, statut, lines, notes }) {
  const { totalHT, totalTVA, totalTTC } = totalsHT(lines);
  const [invoice] = await tx.insert(factures).values({
    entrepriseId: ctx.entrepriseId, numeroFacture: numero, clientId: client.id,
    statut, dateFacture: date, dateEcheance: echeance || null,
    totalHT: totalHT.toFixed(2), totalTVA: totalTVA.toFixed(2), totalTTC: totalTTC.toFixed(2),
    montantPaye: '0', soldeRestant: totalTTC.toFixed(2),
    notes: notes || null, userId: ctx.userId,
  }).returning();
  await tx.insert(factureItems).values(lines.map((l) => ({
    entrepriseId: ctx.entrepriseId, factureId: invoice.id, produitId: l.produitId || null,
    description: l.description, quantite: String(l.quantite), prixUnitaire: Number(l.prixUnitaire).toFixed(2),
    remise: String(l.remise || 0), totalLigne: round2(l.quantite * l.prixUnitaire * (1 - (l.remise || 0) / 100)).toFixed(2),
  })));
  await createEcritureFactureVente({
    entrepriseId: ctx.entrepriseId, numeroFacture: numero, dateFacture: date,
    clientNom: client.nom, clientCompteId: client.compteComptableId || null,
    totalHT, totalTVA, totalTTC, valide: true, executor: tx,
  });
  return { ...invoice, totalHT, totalTVA, totalTTC };
}

async function payInvoice(tx, ctx, invoice, { montant, modePaiement, date, compteBancaireId, reference }) {
  const [payment] = await tx.insert(paiements).values({
    entrepriseId: ctx.entrepriseId, factureId: invoice.id, clientId: invoice.clientId,
    montant: round2(montant).toFixed(2), modePaiement, reference: reference || null,
    datePaiement: date, userId: ctx.userId,
  }).returning();
  const nouveauPaye = round2(Number(invoice.montantPaye || 0) + montant);
  const nouveauSolde = round2(Number(invoice.totalTTC) - nouveauPaye);
  await tx.update(factures).set({
    montantPaye: nouveauPaye.toFixed(2),
    soldeRestant: Math.max(0, nouveauSolde).toFixed(2),
    statut: nouveauSolde <= 0.01 ? 'payee' : 'envoyee',
  }).where(eq(factures.id, invoice.id));
  await createEcriturePaiementClient({
    entrepriseId: ctx.entrepriseId, reference: reference || `PAI-${payment.id}`,
    datePaiement: date, clientNom: ctx.clientNomById[invoice.clientId] || 'Client',
    clientCompteId: null, montant, modePaiement: modePaiement === 'especes' ? 'especes' : 'banque',
    compteBancaireId: compteBancaireId || null, executor: tx,
  });
  await enregistrerEncaissementTresorerie({
    entrepriseId: ctx.entrepriseId, montant, dateTransaction: date,
    reference: reference || `PAI-${payment.id}`, numeroPiece: reference || `PAI-${payment.id}`,
    modePaiement, compteBancaireId: compteBancaireId || null,
    description: `Encaissement facture ${invoice.numeroFacture} (démo)`,
    categorie: 'Vente', tiersNom: ctx.clientNomById[invoice.clientId] || null,
    userId: ctx.userId, executor: tx,
  });
  return payment;
}

async function createDirectExpense(tx, ctx, { categorie, montant, date, description, modePaiement, compteBancaireId }) {
  const [depense] = await tx.insert(depenses).values({
    entrepriseId: ctx.entrepriseId, employeId: ctx.userId, categorieId: categorie.id,
    montant: round2(montant).toFixed(2), dateDepense: date, description,
    statut: 'approuvée', montantApprouve: round2(montant).toFixed(2),
  }).returning();
  await createEcritureDepenseLite({
    entrepriseId: ctx.entrepriseId, reference: `LITE-EXP-${depense.id}`,
    dateDepense: date, description, montant, modePaiement,
    categorieNom: categorie.nom, executor: tx,
  });
  await enregistrerDecaissementTresorerie({
    entrepriseId: ctx.entrepriseId, montant, dateTransaction: date,
    reference: `LITE-EXP-${depense.id}`, numeroPiece: `LITE-EXP-${depense.id}`,
    modePaiement: modePaiement === 'banque' ? 'virement' : modePaiement,
    compteBancaireId: compteBancaireId || null,
    description: `Dépense Lite - ${description} (démo)`,
    categorie: 'Dépense', userId: ctx.userId, executor: tx,
  });
  return depense;
}

// ---------------------------------------------------------------------------
// Seed métier de la démo (dans la transaction fournie).
// ---------------------------------------------------------------------------
export async function seedDemoEnterprise(entrepriseId, userId, tx, { token, refreshToken, ipAddress, userAgent, now = new Date() } = {}) {
  const year = now.getFullYear();
  const ids = buildDemoIdentifiers(entrepriseId);
  const ctx = { entrepriseId, userId, clientNomById: {} };

  // Mois précédent (TVA déclarée et payée) : le 28 du mois précédent.
  const prevMonth = new Date(year, now.getMonth() - 1, 28);
  const prevPeriode = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
  const declarationDate = new Date(year, now.getMonth(), Math.min(5, now.getDate()));
  const paiementTvaDate = declarationDate < now ? addDays(declarationDate, 1) : declarationDate;
  if (paiementTvaDate > now) paiementTvaDate.setTime(now.getTime());

  // Comptes de trésorerie (soldes gérés par les mouvements ci-dessous).
  const compte5121 = await getCompteExact(entrepriseId, '5121', tx);
  const compte57 = await getCompteExact(entrepriseId, '57', tx);
  const [banque] = await tx.insert(comptesBancaires).values({
    entrepriseId, nomCompte: 'Banque principale — Démo', banque: 'Banque Atlantique (démo)',
    type: 'banque', compteComptableId: compte5121.id,
    soldeInitial: '200000', soldeActuel: '200000', actif: true,
  }).returning();
  const [caisse] = await tx.insert(comptesBancaires).values({
    entrepriseId, nomCompte: 'Caisse', type: 'caisse', compteComptableId: compte57.id,
    soldeInitial: '0', soldeActuel: '0', actif: true,
  }).returning();
  const [tmoney] = await tx.insert(comptesBancaires).values({
    entrepriseId, nomCompte: 'TMoney — Démo', type: 'mobile money', compteComptableId: null,
    soldeInitial: '0', soldeActuel: '0', actif: true,
  }).returning();

  // Capital initial : D 52 / C 101, 200 000 (journal à nouveaux).
  const compte52 = await getCompteExact(entrepriseId, '52', tx);
  const compte101 = await getCompteExact(entrepriseId, '101', tx);
  await createEcritureComptable({
    entrepriseId, journalCode: 'AN', journalNom: 'Journal à Nouveaux', journalType: 'od',
    dateEcriture: isoDate(prevMonth), libelle: 'Capital initial — ouverture (démo)',
    numeroPiece: 'OUVERTURE-DEMO',
    lignes: [
      { compteComptableId: compte52.id, debit: 200000, credit: 0, libelle: 'Capital initial — banque' },
      { compteComptableId: compte101.id, debit: 0, credit: 200000, libelle: 'Capital social — ouverture' },
    ],
    valide: true, executor: tx,
  });

  // Paramètres fiscaux (connexion OTR simulée active : la démo peut
  // déposer sa déclaration TVA du mois en cours via la route).
  await tx.insert(parametresFiscaux).values({
    entrepriseId, pays: 'togo', administrationNom: 'OTR',
    centreImpots: 'Lomé (démo)', regimeImposition: 'reel-simplifie',
    connexionActive: true, actif: true,
  });

  // 4 prestations de services.
  const prestationsData = [
    { nom: 'Tenue de comptabilité mensuelle', prix: 75000, unite: 'mois' },
    { nom: 'Établissement des états financiers', prix: 150000, unite: 'forfait' },
    { nom: 'Déclaration TVA mensuelle', prix: 25000, unite: 'mois' },
    { nom: 'Conseil fiscal — heure', prix: 20000, unite: 'heure' },
  ];
  const prestations = [];
  for (let i = 0; i < prestationsData.length; i += 1) {
    const p = prestationsData[i];
    const [row] = await tx.insert(produits).values({
      entrepriseId, reference: ids.productReference(i + 1), nom: p.nom,
      description: `${p.nom} (démo)`, uniteMesure: p.unite,
      prixVente: String(p.prix), prixAchat: '0', quantite: '0', actif: true,
    }).returning();
    prestations.push(row);
  }
  const [P1, P2, P3, P4] = prestations;

  // 4 clients fictifs togolais.
  const clientsData = [
    { nom: 'Coopérative Agri-Sud — Kpalimé (démo)', tel: '+228 90 11 22 33', ville: 'Kpalimé', email: 'contact.agrisud@demo.invalid' },
    { nom: 'Ferme des Plateaux — Atakpamé (démo)', tel: '+228 90 22 33 44', ville: 'Atakpamé', email: 'ferme.plateaux@demo.invalid' },
    { nom: 'Établissements Améyo — Lomé (démo)', tel: '+228 90 33 44 55', ville: 'Lomé', email: 'ameyo.ets@demo.invalid' },
    { nom: 'Quincaillerie Moderne — Sokodé (démo)', tel: '+228 90 44 55 66', ville: 'Sokodé', email: 'quincaillerie.moderne@demo.invalid' },
  ];
  const clientsRows = [];
  for (let i = 0; i < clientsData.length; i += 1) {
    const c = clientsData[i];
    const [row] = await tx.insert(clients).values({
      entrepriseId, numeroClient: ids.clientNumber(i + 1), nom: c.nom,
      type: 'entreprise', email: c.email, telephone: c.tel,
      adresse: `${c.ville}, Togo (démo)`, ville: c.ville, pays: 'Togo',
    }).returning();
    clientsRows.push(row);
    ctx.clientNomById[row.id] = row.nom;
  }
  const [C1, C2, C3, C4] = clientsRows;

  // 2 devis : 1 brouillon, 1 accepté → facturé (F2).
  async function createDevis(numero, client, date, statut, lines, notes) {
    const { totalHT, totalTVA, totalTTC } = totalsHT(lines);
    const [row] = await tx.insert(devis).values({
      entrepriseId, numeroDevis: numero, clientId: client.id, statut,
      dateDevis: date, dateExpiration: isoDate(addDays(new Date(date), 30)),
      totalHT: totalHT.toFixed(2), totalTVA: totalTVA.toFixed(2), totalTTC: totalTTC.toFixed(2),
      notes: notes || null, userId,
    }).returning();
    await tx.insert(devisItems).values(lines.map((l) => ({
      entrepriseId, devisId: row.id, produitId: l.produitId || null, description: l.description,
      quantite: String(l.quantite), prixUnitaire: Number(l.prixUnitaire).toFixed(2),
      remise: String(l.remise || 0),
      totalLigne: round2(l.quantite * l.prixUnitaire * (1 - (l.remise || 0) / 100)).toFixed(2),
    })));
    return row;
  }
  await createDevis(ids.quoteNumber(year, 1), C2, isoDate(addDays(now, -20)), 'brouillon', [
    { produitId: P1.id, description: P1.nom, quantite: 1, prixUnitaire: 75000 },
    { produitId: P3.id, description: P3.nom, quantite: 1, prixUnitaire: 25000 },
  ], 'Devis en attente de validation (démo).');
  const devisAccepte = await createDevis(ids.quoteNumber(year, 2), C1, isoDate(addDays(now, -25)), 'acceptee', [
    { produitId: P1.id, description: P1.nom, quantite: 1, prixUnitaire: 75000 },
  ], 'Devis accepté puis facturé (démo).');

  // 5 factures : F1 mois précédent (TVA octobre), F2 payée, F3
  // partielle, F4 envoyée (échéance dépassée), F5 brouillon.
  const F1 = await createInvoice(tx, ctx, {
    numero: ids.invoiceNumber(year, 1), client: C3, date: isoDate(prevMonth),
    echeance: isoDate(addDays(prevMonth, 15)), statut: 'payee',
    lines: [{ produitId: P2.id, description: P2.nom, quantite: 1, prixUnitaire: 150000 }],
    notes: 'Facture du mois précédent (démo) — TVA déclarée et payée.',
  });
  await payInvoice(tx, ctx, F1, {
    montant: 177000, modePaiement: 'virement', date: isoDate(addDays(prevMonth, 2)),
    compteBancaireId: banque.id, reference: `VIR-${ids.invoiceNumber(year, 1)}`,
  });
  const F2 = await createInvoice(tx, ctx, {
    numero: ids.invoiceNumber(year, 2), client: C1, date: isoDate(addDays(now, -25)),
    echeance: isoDate(addDays(now, -10)), statut: 'payee',
    lines: [{ produitId: P1.id, description: P1.nom, quantite: 1, prixUnitaire: 75000 }],
    notes: `Devis ${devisAccepte.numeroDevis} accepté puis facturé (démo).`,
  });
  await payInvoice(tx, ctx, F2, {
    montant: 88500, modePaiement: 'especes', date: isoDate(addDays(now, -24)),
    reference: `ESP-${ids.invoiceNumber(year, 2)}`,
  });
  const F3 = await createInvoice(tx, ctx, {
    numero: ids.invoiceNumber(year, 3), client: C2, date: isoDate(addDays(now, -18)),
    echeance: isoDate(addDays(now, -3)), statut: 'envoyee',
    lines: [
      { produitId: P1.id, description: P1.nom, quantite: 1, prixUnitaire: 75000 },
      { produitId: P4.id, description: P4.nom, quantite: 2, prixUnitaire: 20000 },
    ],
    notes: 'Facture partiellement payée (démo).',
  });
  await payInvoice(tx, ctx, F3, {
    montant: 70000, modePaiement: 'tmoney', date: isoDate(addDays(now, -12)),
    compteBancaireId: tmoney.id, reference: `TM-${ids.invoiceNumber(year, 3)}`,
  });
  const F4 = await createInvoice(tx, ctx, {
    numero: ids.invoiceNumber(year, 4), client: C4, date: isoDate(addDays(now, -10)),
    echeance: isoDate(addDays(now, -2)), statut: 'envoyee',
    lines: [{ produitId: P3.id, description: P3.nom, quantite: 1, prixUnitaire: 25000 }],
    notes: 'Facture envoyée, échéance dépassée — à relancer (démo).',
  });
  const F5 = await createInvoice(tx, ctx, {
    numero: ids.invoiceNumber(year, 5), client: C3, date: isoDate(addDays(now, -3)),
    echeance: isoDate(addDays(now, 12)), statut: 'brouillon',
    lines: [{ produitId: P4.id, description: P4.nom, quantite: 3, prixUnitaire: 20000 }],
    notes: 'Facture brouillon (démo).',
  });

  // Avoir client sur la facture payée F2 : HT 15 000, TVA 2 700,
  // TTC 17 700 (D 709 / D 443 / C 411 ; solde F2 = −17 700).
  const compte709 = await getCompteExact(entrepriseId, '709', tx);
  const compte443 = await getCompteExact(entrepriseId, '443', tx);
  const compte411 = await getCompteExact(entrepriseId, '411', tx);
  const [avoir] = await tx.insert(ajustementsTiers).values({
    entrepriseId, type: 'credit_client', numero: `AVC-${year}-${entrepriseId}-0001`,
    factureId: F2.id, clientId: C1.id, dateNote: isoDate(addDays(now, -2)),
    totalHT: '15000.00', totalTVA: '2700.00', totalTTC: '17700.00',
    compteAjustementId: compte709.id,
    motif: 'Avoir client — geste commercial sur la facture payée (démo).', userId,
  }).returning();
  await createEcritureComptable({
    entrepriseId, journalCode: 'OD', journalNom: 'Journal des Opérations Diverses', journalType: 'od',
    dateEcriture: isoDate(addDays(now, -2)), libelle: `Avoir client ${avoir.numero} — ${C1.nom}`,
    numeroPiece: avoir.numero,
    lignes: [
      { compteComptableId: compte709.id, debit: 15000, credit: 0, libelle: 'Avoir client — remise accordée' },
      { compteComptableId: compte443.id, debit: 2700, credit: 0, libelle: 'TVA sur avoir client' },
      { compteComptableId: compte411.id, debit: 0, credit: 17700, libelle: `Avoir client ${C1.nom}` },
    ],
    valide: true, executor: tx,
  });
  await tx.update(factures).set({ soldeRestant: '-17700.00' }).where(eq(factures.id, F2.id));

  // TVA du mois précédent : déclarée et payée (27 000 = TVA collectée
  // d'octobre, F1). Écriture D 4434 / C 52 + décaissement banque.
  const compte4434 = await getCompteExact(entrepriseId, '4434', tx);
  await tx.insert(declarationsFiscales).values({
    entrepriseId, type: 'tva', periode: prevPeriode, montant: '27000.00',
    statut: 'payée', numeroDeclaration: `TVA-${prevPeriode}-${entrepriseId}`,
    // dateSoumission / datePaiement sont des TIMESTAMP : il faut des
    // objets Date (une chaîne 'YYYY-MM-DD' fait échouer drizzle avec
    // « value.toISOString is not a function » — 500 en production).
    dateDeclaration: isoDate(declarationDate), dateSoumission: declarationDate,
    datePaiement: paiementTvaDate, referencePaiement: `PAY-TVA-${prevPeriode}-DEMO-${entrepriseId}`,
    reponseAdministration: JSON.stringify({ success: true, message: 'Déclaration simulée acceptée', administration: 'OTR', pays: 'Togo' }),
    notes: 'Déclaration TVA du mois précédent, déclarée et payée (démo).',
  });
  await createEcritureComptable({
    entrepriseId, journalCode: 'BQ', journalNom: 'Journal de Banque', journalType: 'banque',
    dateEcriture: isoDate(paiementTvaDate), libelle: `Paiement TVA - ${prevPeriode}`,
    numeroPiece: `PAY-TVA-${prevPeriode}-DEMO-${entrepriseId}`,
    lignes: [
      { compteComptableId: compte4434.id, debit: 27000, credit: 0, libelle: `Paiement TVA ${prevPeriode}` },
      { compteComptableId: compte52.id, debit: 0, credit: 27000, libelle: 'Règlement impôt TVA' },
    ],
    valide: true, executor: tx,
  });
  await enregistrerDecaissementTresorerie({
    entrepriseId, montant: 27000, dateTransaction: isoDate(paiementTvaDate),
    reference: `PAY-TVA-${prevPeriode}-DEMO-${entrepriseId}`,
    numeroPiece: `PAY-TVA-${prevPeriode}-DEMO-${entrepriseId}`,
    modePaiement: 'virement', compteBancaireId: banque.id,
    description: `Paiement TVA ${prevPeriode} (démo)`, categorie: 'Impôts et taxes',
    userId, executor: tx,
  });

  // 4 dépenses directes Lite (approuvées à la création).
  const categoriesData = ['Loyer', 'Électricité', 'Fournitures de bureau', 'Transport'];
  const categories = {};
  for (const nom of categoriesData) {
    const [row] = await tx.insert(categoriesDepenses).values({
      entrepriseId, nom, description: `Catégorie ${nom} (démo)`,
    }).returning();
    categories[nom] = row;
  }
  await createDirectExpense(tx, ctx, {
    categorie: categories.Loyer, montant: 180000, date: isoDate(addDays(now, -12)),
    description: 'Loyer boutique — novembre (démo)', modePaiement: 'banque', compteBancaireId: banque.id,
  });
  await createDirectExpense(tx, ctx, {
    categorie: categories['Électricité'], montant: 45000, date: isoDate(addDays(now, -8)),
    description: 'Électricité — novembre (démo)', modePaiement: 'especes',
  });
  await createDirectExpense(tx, ctx, {
    categorie: categories['Fournitures de bureau'], montant: 32000, date: isoDate(addDays(now, -6)),
    description: 'Consommables de bureau (démo)', modePaiement: 'banque', compteBancaireId: banque.id,
  });
  await createDirectExpense(tx, ctx, {
    categorie: categories.Transport, montant: 25000, date: isoDate(addDays(now, -4)),
    description: 'Transport / carburant (démo)', modePaiement: 'especes',
  });

  // OD — TVA déductible sur l'électricité (TTC 45 000 = HT 38 136 +
  // TVA 6 864) : D 445 / C 6051, la charge nette devient 38 136.
  const compte445 = await getCompteExact(entrepriseId, '445', tx);
  const compte6051 = await getCompteExact(entrepriseId, '6051', tx);
  await createEcritureComptable({
    entrepriseId, journalCode: 'OD', journalNom: 'Journal des Opérations Diverses', journalType: 'od',
    dateEcriture: isoDate(addDays(now, -8)), libelle: 'TVA déductible — électricité novembre (démo)',
    numeroPiece: 'OD-TVA-DEDUCTIBLE-DEMO',
    lignes: [
      { compteComptableId: compte445.id, debit: 6864, credit: 0, libelle: 'TVA déductible — électricité' },
      { compteComptableId: compte6051.id, debit: 0, credit: 6864, libelle: 'TVA déductible — électricité' },
    ],
    valide: true, executor: tx,
  });

  // OD — provision pour charges : D 681 / C 428, 20 000.
  const compte681 = await getCompteExact(entrepriseId, '681', tx);
  const compte428 = await getCompteExact(entrepriseId, '428', tx);
  await createEcritureComptable({
    entrepriseId, journalCode: 'OD', journalNom: 'Journal des Opérations Diverses', journalType: 'od',
    dateEcriture: isoDate(addDays(now, -3)), libelle: 'Provision pour charges (démo)',
    numeroPiece: 'OD-PROVISION-DEMO',
    lignes: [
      { compteComptableId: compte681.id, debit: 20000, credit: 0, libelle: 'Provision pour charges' },
      { compteComptableId: compte428.id, debit: 0, credit: 20000, libelle: 'Provision pour charges à payer' },
    ],
    valide: true, executor: tx,
  });

  // Employé (annuaire, lié au compte admin démo) + note de frais
  // approuvée + remboursement — circuit complet.
  const [employe] = await tx.insert(employes).values({
    entrepriseId, userId, matricule: ids.employeeMatricule,
    nom: 'Kouassi', prenom: 'Aya', telephone: '+228 90 11 22 33',
    email: 'aya.kouassi@demo.invalid', poste: 'Comptable (démo)',
    departement: 'Comptabilité', typeContrat: 'CDI', dateEmbauche: isoDate(addDays(now, -60)),
  }).returning();
  const [noteFrais] = await tx.insert(depenses).values({
    entrepriseId, employeId: userId, categorieId: categories.Transport.id,
    montant: '15000.00', dateDepense: isoDate(addDays(now, -5)),
    description: 'Avance frais mission — Lomé (démo)',
    statut: 'en_attente', montantApprouve: '0', montantRembourse: '0',
  }).returning();
  const [approvalManager] = await tx.insert(approvalsDepenses).values({
    entrepriseId, depenseId: noteFrais.id, etape: 'manager', statut: 'en_attente',
  }).returning();
  await tx.update(approvalsDepenses).set({
    statut: 'approuvée', dateApprobation: new Date(), approbateurId: userId,
  }).where(eq(approvalsDepenses.id, approvalManager.id));
  const [approvalComptable] = await tx.insert(approvalsDepenses).values({
    entrepriseId, depenseId: noteFrais.id, etape: 'comptable', statut: 'en_attente',
  }).returning();
  await tx.update(approvalsDepenses).set({
    statut: 'approuvée', dateApprobation: new Date(), approbateurId: userId,
  }).where(eq(approvalsDepenses.id, approvalComptable.id));
  await createEcritureChargeNoteFraisLite({
    entrepriseId, depenseId: noteFrais.id, dateDepense: noteFrais.dateDepense,
    description: noteFrais.description, montant: 15000,
    numeroCompteCharge: resolveCompteChargeLite(categories.Transport.nom, noteFrais.description),
    executor: tx,
  });
  await tx.update(depenses).set({ statut: 'approuvée', montantApprouve: '15000.00' })
    .where(eq(depenses.id, noteFrais.id));
  const [remboursement] = await tx.insert(remboursementsEmployes).values({
    entrepriseId, depenseId: noteFrais.id, montantRembourse: '15000.00',
    dateRemboursement: isoDate(addDays(now, -1)), methodePaiement: 'especes', statut: 'complété',
  }).returning();
  await tx.update(depenses).set({ montantRembourse: '15000.00', statut: 'remboursée' })
    .where(eq(depenses.id, noteFrais.id));
  const compte421 = await getCompteExact(entrepriseId, '421', tx);
  await createEcritureComptable({
    entrepriseId, journalCode: 'CA', journalNom: 'Journal de Caisse', journalType: 'caisse',
    dateEcriture: isoDate(addDays(now, -1)),
    libelle: `Remboursement dépense Aya Kouassi - ${noteFrais.description}`,
    numeroPiece: `RMB-${remboursement.id}`,
    lignes: [
      { compteComptableId: compte421.id, debit: 15000, credit: 0, libelle: 'Remboursement avance Aya Kouassi' },
      { compteComptableId: compte57.id, debit: 0, credit: 15000, libelle: 'Décaissement remboursement Aya Kouassi' },
    ],
    valide: true, executor: tx,
  });
  await enregistrerDecaissementTresorerie({
    entrepriseId, montant: 15000, dateTransaction: isoDate(addDays(now, -1)),
    reference: `RMB-${remboursement.id}`, numeroPiece: `RMB-${remboursement.id}`,
    modePaiement: 'especes', description: `Remboursement dépense Aya Kouassi - ${noteFrais.description}`,
    categorie: 'Remboursement dépense', tiersNom: 'Aya Kouassi', userId, executor: tx,
  });

  // Session (comme au login) + audit de connexion.
  if (token && refreshToken) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await tx.insert(sessions).values({
      userId, enterpriseId: entrepriseId,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      refreshTokenHash: crypto.createHash('sha256').update(refreshToken).digest('hex'),
      ipAddress: ipAddress || 'inconnue', userAgent: userAgent || null, expiresAt,
    });
    await tx.insert(auditConnexions).values({
      userId, enterpriseId: entrepriseId, type: 'login',
      ipAddress: ipAddress || 'inconnue', userAgent: userAgent || null, statut: 'success',
    });
    await tx.update(users).set({ lastLogin: new Date() }).where(eq(users.id, userId));
  }

  return {
    entrepriseId, userId, employeId: employe.id,
    factures: [F1, F2, F3, F4, F5].map((f) => f.numeroFacture),
    comptesBancaires: { banque: banque.id, caisse: caisse.id, tmoney: tmoney.id },
  };
}

// ---------------------------------------------------------------------------
// Création complète d'une entreprise démo (route POST /api/auth/demo).
// ---------------------------------------------------------------------------
export async function createDemoEnterprise({ ipAddress, userAgent, countTowardLimit = true } = {}) {
  if (countTowardLimit) await checkDemoRateLimit(ipAddress);
  const h = crypto.randomBytes(6).toString('hex');
  const demoEmail = `demo-${h}@${DEMO_EMAIL_DOMAIN}`;
  const passwordHash = await hashPassword(crypto.randomBytes(32).toString('hex'));
  const now = new Date();
  const year = now.getFullYear();

  const { newEntreprise, newUser } = await db.transaction(async (tx) => {
    const [createdEntreprise] = await tx.insert(entreprises).values({
      nom: 'Entreprise de démonstration (services)',
      adresse: 'Lomé, Togo (démo)',
      ville: 'Lomé',
      pays: 'Togo',
      telephone: '+228 90 00 00 00',
      email: demoEmail,
      tauxTva: '18.00',
      systemeComptable: 'SYSCOHADA',
      // Année fiscale explicite = année civile en cours (le défaut de
      // schéma Lite est fixe 2026 — R9).
      debutAnneeFiscale: `${year}-01-01`,
      finAnneeFiscale: `${year}-12-31`,
      devise: 'XOF',
      actif: true,
      isDemo: true,
    }).returning();
    const [createdUser] = await tx.insert(users).values({
      entrepriseId: createdEntreprise.id,
      username: `demo_${h}`,
      email: demoEmail,
      passwordHash,
      nom: 'Démonstration',
      prenom: '',
      role: 'admin',
      actif: true,
    }).returning();
    // Ligne 'actif' DANS LA MÊME transaction : sans elle, le premier
    // appel authentifié auto-créerait une ligne 'trial' (legacy) et la
    // démo expirerait en 30 jours. Pas d'abonnement Lite.
    await tx.insert(saasClients).values({
      entrepriseId: createdEntreprise.id,
      statut: 'actif',
      source: 'demo',
      notes: 'Démonstration publique — entreprise jetable, purge automatique.',
    });
    if (countTowardLimit) await recordDemoCreation(ipAddress, tx);
    return { newEntreprise: createdEntreprise, newUser: createdUser };
  });

  try {
    await initializeSyscohadaForEnterprise(newEntreprise.id);
    const token = generateToken(newUser);
    const refreshToken = generateRefreshToken(newUser);
    await db.transaction(async (tx) => {
      await seedDemoEnterprise(newEntreprise.id, newUser.id, tx, {
        token, refreshToken, ipAddress, userAgent, now,
      });
    });
    return {
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        nom: newUser.nom,
        prenom: newUser.prenom,
        role: newUser.role,
        entrepriseId: newUser.entrepriseId,
        trialEndsAt: null,
        isDemo: true,
      },
      entreprise: newEntreprise,
      token,
      refreshToken,
      isDemo: true,
    };
  } catch (error) {
    // Nettoyage compensatoire : une démo à moitié seedée ne doit pas rester.
    try {
      await db.transaction(async (tx) => {
        await deleteEnterpriseData(tx, newEntreprise.id, demoEmail);
      });
    } catch (cleanupError) {
      console.error('Nettoyage démo incomplète impossible:', cleanupError?.message || cleanupError);
    }
    throw error;
  }
}
