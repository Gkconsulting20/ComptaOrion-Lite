import express from 'express';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db.js';
import {
  clients,
  comptesBancaires,
  factures,
  factureItems,
  factureAchatItems,
  facturesAchat,
  fournisseurs,
  lignesEcritures,
  mouvementsStock,
  paiements,
  paiementsFournisseurs,
  produits,
  retoursMarchandises,
  retoursMarchandisesItems,
  transactionsTresorerie,
} from '../schema.js';
import { createEcritureComptable, getCompteByNumero } from '../services/comptabiliteService.js';
import {
  buildChequeDepositLines,
  buildCustomerReturnLines,
  buildSupplierReturnLines,
} from '../services/liteAccountingRules.js';
import { buildThirdPartyLedger } from '../services/accountLedger.js';

const router = express.Router();
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
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

function normalizeReturnItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
    throw fail('Sélectionnez au moins un article à retourner');
  }
  const normalized = items.map((item) => ({
    itemId: Number(item?.itemId),
    quantite: Number(item?.quantite),
    reintegrerStock: item?.reintegrerStock !== false,
  }));
  if (normalized.some((item) => !Number.isInteger(item.itemId) || item.itemId < 1
    || !Number.isFinite(item.quantite) || item.quantite <= 0 || item.quantite > 1000000)) {
    throw fail('Les articles ou quantités de retour sont invalides');
  }
  if (new Set(normalized.map((item) => item.itemId)).size !== normalized.length) {
    throw fail('Un même article ne peut apparaître qu’une fois par retour');
  }
  return normalized;
}

async function createReturn({ req, type, sourceId, body }) {
  const itemsRequest = normalizeReturnItems(body?.items);
  const dateRetour = body?.dateRetour || new Date().toISOString().slice(0, 10);
  if (!validDate(dateRetour)) throw fail('La date du retour est invalide');

  return db.transaction(async (tx) => {
    const sourceTable = type === 'client' ? factures : facturesAchat;
    const sourceIdColumn = type === 'client' ? factures.id : facturesAchat.id;
    const sourceItemsTable = type === 'client' ? factureItems : factureAchatItems;
    const sourceItemsInvoiceColumn = type === 'client' ? factureItems.factureId : factureAchatItems.factureId;
    await tx.execute(sql`SELECT id FROM ${sourceTable}
      WHERE id = ${sourceId} AND entreprise_id = ${req.entrepriseId}
      FOR UPDATE`);
    const [invoice] = await tx.select().from(sourceTable)
      .where(and(eq(sourceIdColumn, sourceId), eq(sourceTable.entrepriseId, req.entrepriseId)))
      .limit(1);
    if (!invoice) throw fail('Facture introuvable', 404);

    const sourceItems = await tx.select().from(sourceItemsTable)
      .where(and(
        eq(sourceItemsInvoiceColumn, sourceId),
        eq(sourceItemsTable.entrepriseId, req.entrepriseId),
      ));
    const sourceById = new Map(sourceItems.map((item) => [item.id, item]));
    const previousReturns = await tx.select({ id: retoursMarchandises.id })
      .from(retoursMarchandises)
      .where(and(
        eq(retoursMarchandises.entrepriseId, req.entrepriseId),
        type === 'client'
          ? eq(retoursMarchandises.factureId, sourceId)
          : eq(retoursMarchandises.factureAchatId, sourceId),
      ));
    const previousReturnItems = previousReturns.length
      ? await tx.select().from(retoursMarchandisesItems)
        .where(and(
          eq(retoursMarchandisesItems.entrepriseId, req.entrepriseId),
          inArray(retoursMarchandisesItems.retourId, previousReturns.map((row) => row.id)),
        ))
      : [];
    const returnedByItem = new Map();
    for (const item of previousReturnItems) {
      const itemId = type === 'client' ? item.factureItemId : item.factureAchatItemId;
      returnedByItem.set(itemId, (returnedByItem.get(itemId) || 0) + Number(item.quantite));
    }

    const normalizedLines = itemsRequest.map((requested) => {
      const sourceItem = sourceById.get(requested.itemId);
      if (!sourceItem) throw fail('Un article sélectionné ne correspond pas à cette facture');
      const available = Number(sourceItem.quantite) - (returnedByItem.get(sourceItem.id) || 0);
      if (requested.quantite > available + 0.0001) {
        throw fail(`La quantité retournée dépasse la quantité disponible pour « ${sourceItem.description} »`);
      }
      const lineHT = round2((Number(sourceItem.totalLigne) / Number(sourceItem.quantite)) * requested.quantite);
      return { requested, sourceItem, lineHT };
    });

    const totalHT = round2(normalizedLines.reduce((sum, line) => sum + line.lineHT, 0));
    const invoiceHT = Number(invoice.totalHT || 0);
    const taxRate = invoiceHT > 0 ? Number(invoice.totalTVA || 0) / invoiceHT : 0;
    const totalTVA = round2(totalHT * taxRate);
    const totalTTC = round2(totalHT + totalTVA);
    if (totalTTC <= 0) throw fail('Le montant de retour doit être supérieur à zéro');

    const entityId = type === 'client' ? invoice.clientId : invoice.fournisseurId;
    const number = `${type === 'client' ? 'AVC' : 'AVF'}-${new Date().getFullYear()}-${req.entrepriseId}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [creditNote] = await tx.insert(retoursMarchandises).values({
      entrepriseId: req.entrepriseId,
      type,
      numero: number,
      ...(type === 'client' ? { factureId: sourceId, clientId: entityId } : { factureAchatId: sourceId, fournisseurId: entityId }),
      dateRetour,
      totalHT: totalHT.toFixed(2),
      totalTVA: totalTVA.toFixed(2),
      totalTTC: totalTTC.toFixed(2),
      notes: body?.notes ? String(body.notes).slice(0, 2000) : null,
      userId: req.user.id,
    }).returning();

    const productIds = normalizedLines
      .map(({ sourceItem }) => sourceItem.produitId)
      .filter(Boolean);
    const productRows = productIds.length
      ? await tx.select().from(produits).where(and(
        inArray(produits.id, productIds),
        eq(produits.entrepriseId, req.entrepriseId),
      ))
      : [];
    const productById = new Map(productRows.map((product) => [product.id, product]));
    const returnItemRows = [];
    let restockedCost = 0;

    for (const line of normalizedLines) {
      const productId = line.sourceItem.produitId ? Number(line.sourceItem.produitId) : null;
      const product = productId ? productById.get(productId) : null;
      const reintegrerStock = type === 'client' && Boolean(product)
        && line.requested.reintegrerStock;
      returnItemRows.push({
        entrepriseId: req.entrepriseId,
        retourId: creditNote.id,
        ...(type === 'client'
          ? { factureItemId: line.sourceItem.id }
          : { factureAchatItemId: line.sourceItem.id }),
        produitId: productId,
        description: line.sourceItem.description,
        quantite: String(line.requested.quantite),
        prixUnitaire: Number(line.sourceItem.prixUnitaire || 0).toFixed(2),
        remise: Number(line.sourceItem.remise || 0).toFixed(2),
        totalLigne: line.lineHT.toFixed(2),
        reintegrerStock,
      });
      if (!product) continue;

      if (type === 'client' && reintegrerStock) {
        const unitCost = Number(product.coutMoyen || 0) || Number(product.prixAchat || 0);
        restockedCost += unitCost * line.requested.quantite;
        await tx.update(produits).set({
          quantite: sql`${produits.quantite} + ${line.requested.quantite}`,
          updatedAt: new Date(),
        }).where(and(
          eq(produits.id, productId),
          eq(produits.entrepriseId, req.entrepriseId),
        ));
        await tx.insert(mouvementsStock).values({
          entrepriseId: req.entrepriseId,
          produitId: productId,
          type: 'entree',
          quantite: String(line.requested.quantite),
          prixUnitaire: unitCost.toFixed(2),
          reference: number,
          notes: 'Retour client remis en stock',
          userId: req.user.id,
        });
      } else if (type === 'fournisseur') {
        const [updated] = await tx.update(produits).set({
          quantite: sql`${produits.quantite} - ${line.requested.quantite}`,
          updatedAt: new Date(),
        }).where(and(
          eq(produits.id, productId),
          eq(produits.entrepriseId, req.entrepriseId),
          sql`${produits.quantite} >= ${line.requested.quantite}`,
        )).returning({ id: produits.id });
        if (!updated) throw fail(`Stock insuffisant pour retourner « ${line.sourceItem.description} »`, 409);
        await tx.insert(mouvementsStock).values({
          entrepriseId: req.entrepriseId,
          produitId: productId,
          type: 'sortie',
          quantite: String(line.requested.quantite),
          prixUnitaire: Number(line.sourceItem.prixUnitaire || 0).toFixed(2),
          reference: number,
          notes: 'Retour de marchandise au fournisseur',
          userId: req.user.id,
        });
      }
    }

    await tx.insert(retoursMarchandisesItems).values(returnItemRows);

    const openBalance = Number(invoice.soldeRestant || 0);
    const newBalance = Math.max(0, round2(openBalance - totalTTC));
    if (type === 'client') {
      await tx.update(factures).set({
        soldeRestant: newBalance.toFixed(2),
        statut: newBalance <= 0.01 ? 'payee' : invoice.statut,
        updatedAt: new Date(),
      }).where(and(eq(factures.id, sourceId), eq(factures.entrepriseId, req.entrepriseId)));

      const clientAccount = await requiredAccount(req.entrepriseId, '411', tx);
      const salesAccount = await requiredAccount(req.entrepriseId, '701', tx);
      const vatAccount = totalTVA > 0 ? await requiredAccount(req.entrepriseId, '443', tx) : null;
      const stockAccount = restockedCost > 0 ? await requiredAccount(req.entrepriseId, '31', tx) : null;
      const costAccount = restockedCost > 0 ? await requiredAccount(req.entrepriseId, '601', tx) : null;
      const lines = buildCustomerReturnLines({
        salesAccountId: salesAccount.id,
        vatAccountId: vatAccount?.id,
        customerAccountId: clientAccount.id,
        stockAccountId: stockAccount?.id,
        costAccountId: costAccount?.id,
        totalHT,
        totalTVA,
        totalTTC,
        restockedCost,
        reference: number,
      });
      await createEcritureComptable({
        entrepriseId: req.entrepriseId,
        journalCode: 'VT',
        journalNom: 'Journal des Ventes',
        journalType: 'ventes',
        dateEcriture: dateRetour,
        libelle: `Avoir client ${number}`,
        numeroPiece: number,
        lignes,
        valide: true,
        executor: tx,
      });
    } else {
      await tx.update(facturesAchat).set({
        soldeRestant: newBalance.toFixed(2),
        updatedAt: new Date(),
      }).where(and(eq(facturesAchat.id, sourceId), eq(facturesAchat.entrepriseId, req.entrepriseId)));
      await tx.update(fournisseurs).set({
        soldeDu: sql`COALESCE(${fournisseurs.soldeDu}, 0) - ${totalTTC.toFixed(2)}`,
        updatedAt: new Date(),
      }).where(and(
        eq(fournisseurs.id, entityId),
        eq(fournisseurs.entrepriseId, req.entrepriseId),
      ));

      const supplierAccount = await requiredAccount(req.entrepriseId, '401', tx);
      const stockAccount = await requiredAccount(req.entrepriseId, '31', tx);
      const vatAccount = totalTVA > 0 ? await requiredAccount(req.entrepriseId, '445', tx) : null;
      const lines = buildSupplierReturnLines({
        supplierAccountId: supplierAccount.id,
        stockAccountId: stockAccount.id,
        vatAccountId: vatAccount?.id,
        totalHT,
        totalTVA,
        totalTTC,
        reference: number,
      });
      await createEcritureComptable({
        entrepriseId: req.entrepriseId,
        journalCode: 'AC',
        journalNom: 'Journal des Achats',
        journalType: 'achats',
        dateEcriture: dateRetour,
        libelle: `Avoir fournisseur ${number}`,
        numeroPiece: number,
        lignes,
        valide: true,
        executor: tx,
      });
    }

    return {
      ...creditNote,
      items: returnItemRows,
      totalHT,
      totalTVA,
      totalTTC,
      soldeRestantFacture: newBalance,
    };
  });
}

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

    const [invoices, receipts, credits] = await Promise.all([
      db.select().from(factures).where(and(
        eq(factures.entrepriseId, req.entrepriseId),
        eq(factures.clientId, clientId),
      )),
      db.select().from(paiements).where(and(
        eq(paiements.entrepriseId, req.entrepriseId),
        eq(paiements.clientId, clientId),
      )),
      db.select().from(retoursMarchandises).where(and(
        eq(retoursMarchandises.entrepriseId, req.entrepriseId),
        eq(retoursMarchandises.clientId, clientId),
        eq(retoursMarchandises.type, 'client'),
      )),
    ]);
    const ledger = buildThirdPartyLedger({
      partyType: 'client',
      invoices,
      payments: receipts,
      returns: credits,
    });
    return res.json({
      success: true,
      data: { tiers: { id: client.id, nom: client.nom }, ...ledger },
    });
  } catch {
    return res.status(500).json({ success: false, message: 'Impossible de charger le compte client' });
  }
});

router.get('/fournisseurs/:id/compte', async (req, res) => {
  try {
    const supplierId = Number(req.params.id);
    const [supplier] = await db.select().from(fournisseurs).where(and(
      eq(fournisseurs.id, supplierId),
      eq(fournisseurs.entrepriseId, req.entrepriseId),
    )).limit(1);
    if (!supplier) return res.status(404).json({ success: false, message: 'Fournisseur introuvable' });

    const [invoices, payments, returns] = await Promise.all([
      db.select().from(facturesAchat).where(and(
        eq(facturesAchat.entrepriseId, req.entrepriseId),
        eq(facturesAchat.fournisseurId, supplierId),
      )),
      db.select().from(paiementsFournisseurs).where(and(
        eq(paiementsFournisseurs.entrepriseId, req.entrepriseId),
        eq(paiementsFournisseurs.fournisseurId, supplierId),
      )),
      db.select().from(retoursMarchandises).where(and(
        eq(retoursMarchandises.entrepriseId, req.entrepriseId),
        eq(retoursMarchandises.fournisseurId, supplierId),
        eq(retoursMarchandises.type, 'fournisseur'),
      )),
    ]);
    const ledger = buildThirdPartyLedger({
      partyType: 'fournisseur',
      invoices,
      payments,
      returns,
    });
    return res.json({
      success: true,
      data: { tiers: { id: supplier.id, nom: supplier.raisonSociale }, ...ledger },
    });
  } catch {
    return res.status(500).json({ success: false, message: 'Impossible de charger le compte fournisseur' });
  }
});

router.post('/factures/:id/retours', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, message: 'Facture invalide' });
    const data = await createReturn({ req, type: 'client', sourceId: id, body: req.body });
    return res.status(201).json({ success: true, message: 'Note de crédit client créée', data });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Impossible de créer la note de crédit' });
  }
});

router.post('/achats/:id/retours', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, message: 'Facture fournisseur invalide' });
    const data = await createReturn({ req, type: 'fournisseur', sourceId: id, body: req.body });
    return res.status(201).json({ success: true, message: 'Note de débit fournisseur créée', data });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Impossible de créer la note de débit' });
  }
});

export default router;
