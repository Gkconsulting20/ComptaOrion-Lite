import express from 'express';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db.js';
import {
  comptesComptables,
  entreprises,
  factureAchatItems,
  facturesAchat,
  fournisseurs,
  mouvementsStock,
  produits,
} from '../schema.js';
import { createEcritureComptable, getCompteByNumero } from '../services/comptabiliteService.js';

const router = express.Router();
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const validDate = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

function presentSupplier(supplier) {
  return {
    id: supplier.id,
    raisonSociale: supplier.raisonSociale,
    numeroFournisseur: supplier.numeroFournisseur,
    contactPrincipal: supplier.contactPrincipal,
    telephone: supplier.telephone,
    email: supplier.email,
    adresse: supplier.adresse,
    soldeDu: Number(supplier.soldeDu || 0),
    actif: supplier.actif !== false,
  };
}

function presentItem(item) {
  return {
    id: item.id,
    produitId: Number(item.produitId),
    description: item.description,
    quantite: Number(item.quantite),
    prixUnitaire: Number(item.prixUnitaire),
    totalLigne: Number(item.totalLigne),
  };
}

function presentPurchase(invoice, supplier, items) {
  return {
    id: invoice.id,
    numeroFacture: invoice.numeroFacture,
    numeroFactureFournisseur: invoice.numeroFactureFournisseur,
    dateFacture: invoice.dateFacture,
    dateEcheance: invoice.dateEcheance,
    statut: invoice.statut,
    notes: invoice.notes,
    totalHT: Number(invoice.totalHT || 0),
    totalTVA: Number(invoice.totalTVA || 0),
    totalTTC: Number(invoice.totalTTC || 0),
    montantPaye: Number(invoice.montantPaye || 0),
    soldeRestant: Number(invoice.soldeRestant || 0),
    fournisseur: presentSupplier(supplier),
    items: items.map(presentItem),
  };
}

router.get('/fournisseurs', async (req, res) => {
  try {
    const records = await db.select().from(fournisseurs)
      .where(eq(fournisseurs.entrepriseId, req.entrepriseId))
      .orderBy(asc(fournisseurs.raisonSociale));
    return res.json({
      success: true,
      count: records.length,
      data: records.map(presentSupplier),
    });
  } catch {
    return res.status(500).json({ success: false, message: 'Impossible de charger les fournisseurs' });
  }
});

router.post('/fournisseurs', async (req, res) => {
  const raisonSociale = String(req.body?.raisonSociale || '').trim();
  const email = req.body?.email ? String(req.body.email).trim() : null;
  if (!raisonSociale || raisonSociale.length > 255) {
    return res.status(400).json({ success: false, message: 'Le nom du fournisseur est obligatoire' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: 'Adresse e-mail invalide' });
  }

  const optionalText = (value, maxLength) => {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const text = String(value).trim();
    return text.length <= maxLength ? text : null;
  };

  try {
    const [supplier] = await db.insert(fournisseurs).values({
      entrepriseId: req.entrepriseId,
      raisonSociale,
      numeroFournisseur: optionalText(req.body.numeroFournisseur, 50),
      contactPrincipal: optionalText(req.body.contactPrincipal, 255),
      telephone: optionalText(req.body.telephone, 50),
      email,
      adresse: optionalText(req.body.adresse, 2000),
      categorie: 'Marchandises',
      actif: true,
    }).returning();

    return res.status(201).json({ success: true, data: presentSupplier(supplier) });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ success: false, message: 'Ce numéro de fournisseur existe déjà' });
    }
    return res.status(500).json({ success: false, message: 'Impossible de créer le fournisseur' });
  }
});

router.get('/achats', async (req, res) => {
  try {
    const rows = await db.select({
      invoice: facturesAchat,
      supplier: fournisseurs,
    }).from(facturesAchat)
      .innerJoin(fournisseurs, and(
        eq(facturesAchat.fournisseurId, fournisseurs.id),
        eq(fournisseurs.entrepriseId, req.entrepriseId),
      ))
      .where(eq(facturesAchat.entrepriseId, req.entrepriseId))
      .orderBy(desc(facturesAchat.dateFacture), desc(facturesAchat.id));

    const invoiceIds = rows.map(({ invoice }) => invoice.id);
    const items = invoiceIds.length
      ? await db.select().from(factureAchatItems)
        .where(and(
          eq(factureAchatItems.entrepriseId, req.entrepriseId),
          inArray(factureAchatItems.factureId, invoiceIds),
        ))
        .orderBy(asc(factureAchatItems.id))
      : [];
    const itemsByInvoice = new Map();
    for (const item of items) {
      const list = itemsByInvoice.get(item.factureId) || [];
      list.push(item);
      itemsByInvoice.set(item.factureId, list);
    }

    return res.json({
      success: true,
      count: rows.length,
      data: rows.map(({ invoice, supplier }) => presentPurchase(
        invoice,
        supplier,
        itemsByInvoice.get(invoice.id) || [],
      )),
    });
  } catch {
    return res.status(500).json({ success: false, message: 'Impossible de charger les achats' });
  }
});

router.post('/achats/lite-create', async (req, res) => {
  const { fournisseurId, numeroFactureFournisseur, dateFacture, dateEcheance, notes, items } = req.body || {};
  const supplierId = Number(fournisseurId);
  const supplierInvoiceNumber = numeroFactureFournisseur
    ? String(numeroFactureFournisseur).trim() || null
    : null;
  if (!req.idempotencyKey) {
    return res.status(400).json({ success: false, message: 'Une clé d’idempotence est requise pour enregistrer un achat' });
  }
  if (!Number.isInteger(supplierId) || supplierId < 1 || !validDate(dateFacture)
    || (dateEcheance != null && !validDate(dateEcheance))
    || (supplierInvoiceNumber && supplierInvoiceNumber.length > 100)
    || !Array.isArray(items) || items.length < 1 || items.length > 50) {
    return res.status(400).json({ success: false, message: 'Fournisseur, date et articles valides requis' });
  }
  if (dateEcheance && dateEcheance < dateFacture) {
    return res.status(400).json({ success: false, message: 'La date d’échéance doit suivre la date de facture' });
  }

  const normalizedItems = items.map((item) => ({
    produitId: Number(item?.produitId),
    quantite: Number(item?.quantite),
    prixUnitaire: Number(item?.prixUnitaire),
  }));
  if (normalizedItems.some((item) => !Number.isInteger(item.produitId) || item.produitId < 1
    || !Number.isFinite(item.quantite) || item.quantite <= 0 || item.quantite > 1000000
    || !Number.isFinite(item.prixUnitaire) || item.prixUnitaire < 0 || item.prixUnitaire > 1000000000)) {
    return res.status(400).json({ success: false, message: 'Quantités et prix d’articles invalides' });
  }

  try {
    const invoice = await db.transaction(async (tx) => {
      const [supplier] = await tx.select().from(fournisseurs)
        .where(and(
          eq(fournisseurs.id, supplierId),
          eq(fournisseurs.entrepriseId, req.entrepriseId),
          eq(fournisseurs.actif, true),
        ))
        .limit(1);
      if (!supplier) throw Object.assign(new Error('Fournisseur introuvable'), { status: 404 });

      if (supplierInvoiceNumber) {
        const [duplicate] = await tx.select({ id: facturesAchat.id }).from(facturesAchat)
          .where(and(
            eq(facturesAchat.entrepriseId, req.entrepriseId),
            eq(facturesAchat.fournisseurId, supplierId),
            eq(facturesAchat.numeroFactureFournisseur, supplierInvoiceNumber),
          ))
          .limit(1);
        if (duplicate) throw Object.assign(new Error('Cette facture fournisseur a déjà été saisie'), { status: 409 });
      }

      const productIds = [...new Set(normalizedItems.map((item) => item.produitId))].sort((a, b) => a - b);
      const productRows = [];
      for (const id of productIds) {
        await tx.execute(sql`SELECT id FROM produits WHERE id = ${id} AND entreprise_id = ${req.entrepriseId} FOR UPDATE`);
        const [product] = await tx.select().from(produits)
          .where(and(eq(produits.id, id), eq(produits.entrepriseId, req.entrepriseId)))
          .limit(1);
        if (!product || product.actif === false) {
          throw Object.assign(new Error('Un produit sélectionné est introuvable ou inactif'), { status: 404 });
        }
        productRows.push(product);
      }

      const [company] = await tx.select({ tauxTva: entreprises.tauxTva }).from(entreprises)
        .where(eq(entreprises.id, req.entrepriseId)).limit(1);
      const tvaRate = Number(company?.tauxTva ?? 18);
      const itemRows = normalizedItems.map((item) => {
        const product = productRows.find((row) => row.id === item.produitId);
        return {
          entrepriseId: req.entrepriseId,
          produitId: item.produitId,
          description: product.nom,
          quantite: item.quantite,
          prixUnitaire: item.prixUnitaire,
          totalLigne: round2(item.quantite * item.prixUnitaire),
        };
      });
      const totalHT = round2(itemRows.reduce((sum, item) => sum + item.totalLigne, 0));
      const totalTVA = round2(totalHT * tvaRate / 100);
      const totalTTC = round2(totalHT + totalTVA);
      const year = dateFacture.slice(0, 4);
      const [lastInvoice] = await tx.select({ numeroFacture: facturesAchat.numeroFacture })
        .from(facturesAchat)
        .where(and(
          eq(facturesAchat.entrepriseId, req.entrepriseId),
          sql`${facturesAchat.numeroFacture} LIKE ${`FACT-ACH-${year}-%`}`,
        ))
        .orderBy(desc(facturesAchat.id))
        .limit(1);
      const match = lastInvoice?.numeroFacture?.match(new RegExp(`^FACT-ACH-${year}-(\\d+)$`));
      const nextNumber = String(match ? Number(match[1]) + 1 : 1).padStart(4, '0');
      const numeroFacture = `FACT-ACH-${year}-${nextNumber}`;

      const [createdInvoice] = await tx.insert(facturesAchat).values({
        entrepriseId: req.entrepriseId,
        numeroFacture,
        numeroFactureFournisseur: supplierInvoiceNumber,
        fournisseurId: supplierId,
        statut: 'validee',
        dateFacture,
        dateEcheance: dateEcheance || null,
        totalHT: totalHT.toFixed(2),
        totalTVA: totalTVA.toFixed(2),
        totalTTC: totalTTC.toFixed(2),
        montantPaye: '0.00',
        soldeRestant: totalTTC.toFixed(2),
        notes: notes ? String(notes).slice(0, 2000) : null,
        userId: req.user.id,
      }).returning();

      const insertedItems = await tx.insert(factureAchatItems).values(
        itemRows.map((item) => ({
          ...item,
          factureId: createdInvoice.id,
          quantite: String(item.quantite),
          prixUnitaire: Number(item.prixUnitaire).toFixed(2),
          remise: '0.00',
          totalLigne: item.totalLigne.toFixed(2),
        })),
      ).returning();

      const quantityByProduct = new Map();
      const costByProduct = new Map();
      for (const item of itemRows) {
        quantityByProduct.set(item.produitId, (quantityByProduct.get(item.produitId) || 0) + Number(item.quantite));
        costByProduct.set(item.produitId, (costByProduct.get(item.produitId) || 0) + item.totalLigne);
      }
      for (const product of productRows) {
        const incomingQuantity = quantityByProduct.get(product.id) || 0;
        const incomingValue = costByProduct.get(product.id) || 0;
        const previousQuantity = Number(product.quantite || 0);
        const previousUnitCost = Number(product.coutMoyen || product.prixAchat || 0);
        const averageCost = round2(
          (previousQuantity * previousUnitCost + incomingValue) / (previousQuantity + incomingQuantity),
        );
        await tx.update(produits).set({
          quantite: String(round2(previousQuantity + incomingQuantity)),
          prixAchat: averageCost.toFixed(2),
          coutMoyen: averageCost.toFixed(2),
          fournisseurId: supplierId,
          updatedAt: new Date(),
        }).where(and(eq(produits.id, product.id), eq(produits.entrepriseId, req.entrepriseId)));
        await tx.insert(mouvementsStock).values({
          entrepriseId: req.entrepriseId,
          produitId: product.id,
          type: 'entree',
          quantite: String(incomingQuantity),
          prixUnitaire: (incomingValue / incomingQuantity).toFixed(2),
          reference: numeroFacture,
          notes: 'Réception de marchandises liée à une facture Lite',
          userId: req.user.id,
        });
      }

      const stockAccount = await getCompteByNumero(req.entrepriseId, '31', tx);
      let supplierAccount = null;
      if (supplier.compteComptableId) {
        [supplierAccount] = await tx.select().from(comptesComptables).where(and(
          eq(comptesComptables.id, supplier.compteComptableId),
          eq(comptesComptables.entrepriseId, req.entrepriseId),
        )).limit(1);
      }
      if (!supplierAccount) supplierAccount = await getCompteByNumero(req.entrepriseId, '401', tx);
      const vatAccount = totalTVA > 0 ? await getCompteByNumero(req.entrepriseId, '445', tx) : null;
      if (!stockAccount || !supplierAccount || (totalTVA > 0 && !vatAccount)) {
        throw Object.assign(new Error('Les comptes de stock, fournisseur ou TVA ne sont pas configurés'), { status: 409 });
      }

      const entryLines = [
        { compteComptableId: stockAccount.id, debit: totalHT, credit: 0, libelle: `Stock reçu - ${numeroFacture}` },
      ];
      if (vatAccount) entryLines.push({
        compteComptableId: vatAccount.id,
        debit: totalTVA,
        credit: 0,
        libelle: `TVA récupérable - ${numeroFacture}`,
      });
      entryLines.push({
        compteComptableId: supplierAccount.id,
        debit: 0,
        credit: totalTTC,
        libelle: `Fournisseur ${supplier.raisonSociale} - ${numeroFacture}`,
      });
      await createEcritureComptable({
        entrepriseId: req.entrepriseId,
        journalCode: 'AC',
        journalNom: 'Journal des Achats',
        journalType: 'achats',
        dateEcriture: dateFacture,
        libelle: `Facture ${numeroFacture} - ${supplier.raisonSociale}`,
        numeroPiece: numeroFacture,
        lignes: entryLines,
        valide: true,
        sourceType: 'facture_achat_lite',
        sourceId: createdInvoice.id,
        executor: tx,
      });

      await tx.update(fournisseurs).set({
        soldeDu: sql`${fournisseurs.soldeDu} + ${totalTTC.toFixed(2)}`,
        updatedAt: new Date(),
      }).where(and(
        eq(fournisseurs.id, supplierId),
        eq(fournisseurs.entrepriseId, req.entrepriseId),
      ));

      return presentPurchase(createdInvoice, supplier, insertedItems);
    });

    return res.status(201).json({ success: true, data: invoice });
  } catch (error) {
    const status = error?.status || (error?.code === '23505' ? 409 : 500);
    return res.status(status).json({
      success: false,
      message: status < 500 ? error.message : 'Impossible d’enregistrer cet achat',
    });
  }
});

export default router;
