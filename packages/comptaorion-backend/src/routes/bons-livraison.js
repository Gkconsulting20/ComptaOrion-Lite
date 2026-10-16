import { Router } from 'express';
import { db } from '../db.js';
import { bonsLivraison, bonLivraisonItems, factures, factureItems, clients } from '../schema.js';
import { eq, and, desc } from 'drizzle-orm';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const bonsList = await db.select().from(bonsLivraison)
      .where(eq(bonsLivraison.entrepriseId, req.entrepriseId))
      .orderBy(desc(bonsLivraison.createdAt));

    const bonsAvecDetails = await Promise.all(bonsList.map(async (bon) => {
      const client = await db.select().from(clients)
        .where(eq(clients.id, bon.clientId))
        .limit(1);
      
      const items = await db.select().from(bonLivraisonItems)
        .where(eq(bonLivraisonItems.bonLivraisonId, bon.id));

      return {
        ...bon,
        client: client[0] || null,
        items: items
      };
    }));

    res.json(bonsAvecDetails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const bon = await db.select().from(bonsLivraison)
      .where(and(
        eq(bonsLivraison.id, parseInt(id)),
        eq(bonsLivraison.entrepriseId, req.entrepriseId)
      ))
      .limit(1);

    if (bon.length === 0) {
      return res.status(404).json({ error: 'Bon de livraison introuvable' });
    }

    const items = await db.select().from(bonLivraisonItems)
      .where(eq(bonLivraisonItems.bonLivraisonId, parseInt(id)));

    const client = await db.select().from(clients)
      .where(eq(clients.id, bon[0].clientId))
      .limit(1);

    res.json({
      ...bon[0],
      items,
      client: client[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/generer-depuis-facture/:factureId', async (req, res) => {
  try {
    const { factureId } = req.params;

    const facture = await db.select().from(factures)
      .where(and(
        eq(factures.id, parseInt(factureId)),
        eq(factures.entrepriseId, req.entrepriseId)
      ))
      .limit(1);

    if (facture.length === 0) {
      return res.status(404).json({ error: 'Facture introuvable' });
    }

    const factureData = facture[0];

    const bonsExistants = await db.select().from(bonsLivraison)
      .where(eq(bonsLivraison.entrepriseId, req.entrepriseId))
      .orderBy(desc(bonsLivraison.id))
      .limit(1);

    let nouveauNumero = 1;
    if (bonsExistants.length > 0 && bonsExistants[0].numeroBL) {
      const lastNumero = parseInt(bonsExistants[0].numeroBL.replace(/\D/g, '')) || 0;
      nouveauNumero = lastNumero + 1;
    }

    const numeroBL = `BL-${String(nouveauNumero).padStart(6, '0')}`;

    const nouveauBon = await db.insert(bonsLivraison).values({
      entrepriseId: req.entrepriseId,
      numeroBL,
      commandeId: factureData.commandeId,
      clientId: factureData.clientId,
      dateLivraison: new Date().toISOString().split('T')[0],
      notes: `Bon de livraison généré automatiquement pour la facture ${factureData.numeroFacture}`,
      userId: req.user?.id
    }).returning();

    const items = await db.select().from(factureItems)
      .where(eq(factureItems.factureId, parseInt(factureId)));

    if (items.length > 0) {
      const bonItems = items
        .filter(item => item.produitId)
        .map(item => ({
          entrepriseId: req.entrepriseId,
          bonLivraisonId: nouveauBon[0].id,
          produitId: item.produitId,
          quantite: item.quantite
        }));

      if (bonItems.length > 0) {
        await db.insert(bonLivraisonItems).values(bonItems);
      }
    }

    const bonComplet = await db.select().from(bonsLivraison)
      .where(eq(bonsLivraison.id, nouveauBon[0].id))
      .limit(1);

    res.json({
      message: 'Bon de livraison généré avec succès',
      bonLivraison: bonComplet[0]
    });
  } catch (err) {
    console.error('Erreur génération BL:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { clientId, commandeId, dateLivraison, notes, items } = req.body;

    const bonsExistants = await db.select().from(bonsLivraison)
      .where(eq(bonsLivraison.entrepriseId, req.entrepriseId))
      .orderBy(desc(bonsLivraison.id))
      .limit(1);

    let nouveauNumero = 1;
    if (bonsExistants.length > 0 && bonsExistants[0].numeroBL) {
      const lastNumero = parseInt(bonsExistants[0].numeroBL.replace(/\D/g, '')) || 0;
      nouveauNumero = lastNumero + 1;
    }

    const numeroBL = `BL-${String(nouveauNumero).padStart(6, '0')}`;

    const nouveauBon = await db.insert(bonsLivraison).values({
      entrepriseId: req.entrepriseId,
      numeroBL,
      commandeId: commandeId || null,
      clientId: parseInt(clientId),
      dateLivraison: dateLivraison || new Date().toISOString().split('T')[0],
      notes,
      userId: req.user?.id
    }).returning();

    if (items && items.length > 0) {
      const bonItems = items.map(item => ({
        entrepriseId: req.entrepriseId,
        bonLivraisonId: nouveauBon[0].id,
        produitId: parseInt(item.produitId),
        quantite: item.quantite
      }));

      await db.insert(bonLivraisonItems).values(bonItems);
    }

    res.json(nouveauBon[0]);
  } catch (err) {
    console.error('Erreur création BL:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { dateLivraison, notes, signatureClient } = req.body;

    const updated = await db.update(bonsLivraison)
      .set({
        dateLivraison,
        notes,
        signatureClient
      })
      .where(and(
        eq(bonsLivraison.id, parseInt(id)),
        eq(bonsLivraison.entrepriseId, req.entrepriseId)
      ))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ error: 'Bon de livraison introuvable' });
    }

    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const bon = await db.select().from(bonsLivraison)
      .where(and(
        eq(bonsLivraison.id, parseInt(id)),
        eq(bonsLivraison.entrepriseId, req.entrepriseId)
      ))
      .limit(1);

    if (bon.length === 0) {
      return res.status(404).json({ error: 'Bon de livraison introuvable' });
    }

    await db.delete(bonLivraisonItems)
      .where(and(
        eq(bonLivraisonItems.bonLivraisonId, parseInt(id)),
        eq(bonLivraisonItems.entrepriseId, req.entrepriseId)
      ));

    await db.delete(bonsLivraison)
      .where(and(
        eq(bonsLivraison.id, parseInt(id)),
        eq(bonsLivraison.entrepriseId, req.entrepriseId)
      ));

    res.json({ message: 'Bon de livraison supprimé avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
