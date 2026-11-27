import express from 'express';
import { db } from '../db.js';
import { produits } from '../schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';

const router = express.Router();

/**
 * GET /api/produits
 * Récupère la liste de tous les produits de l'entreprise (avec pagination)
 */
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const produitsList = await db
      .select()
      .from(produits)
      .where(eq(produits.entrepriseId, req.entrepriseId))
      .orderBy(desc(produits.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: sql`COUNT(*)::int` })
      .from(produits)
      .where(eq(produits.entrepriseId, req.entrepriseId));

    res.json({
      success: true,
      count: produitsList.length,
      total: count,
      page,
      totalPages: Math.ceil(count / limit),
      data: produitsList,
    });
  } catch (error) {
    console.error('Erreur GET /api/produits:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des produits',
      error: error.message,
    });
  }
});

/**
 * GET /api/produits/stock-faible
 * RETIRÉ (Lite services uniquement) : plus d'alertes de stock.
 * 410 Gone, pour que les anciens clients sachent que la fonction a été
 * supprimée volontairement et non qu'elle est en panne.
 */
router.get('/stock-faible', (_req, res) => {
  res.status(410).json({
    success: false,
    message: 'Les alertes de stock ont été retirées : ComptaOrion Lite est réservé aux services, sans gestion de stock.',
  });
});

/**
 * GET /api/produits/:id
 * Récupère un produit spécifique
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const produit = await db
      .select()
      .from(produits)
      .where(and(
        eq(produits.id, parseInt(id)),
        eq(produits.entrepriseId, req.entrepriseId)
      ))
      .limit(1);

    if (!produit || produit.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Produit non trouvé',
      });
    }

    res.json({
      success: true,
      data: produit[0],
    });
  } catch (error) {
    console.error('Erreur GET /api/produits/:id:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du produit',
      error: error.message,
    });
  }
});

/**
 * POST /api/produits
 * Crée une nouvelle prestation (catalogue de services). Les champs de
 * stock (quantité, stock minimum, prix d'achat, coût moyen, fournisseur,
 * emplacement) sont ignorés : Lite ne gère plus ni stock ni achats.
 * Les colonnes restent en base (données historiques préservées, aucune
 * migration destructive) mais ne sont plus alimentées.
 */
router.post('/', async (req, res) => {
  try {
    const {
      reference,
      nom,
      description,
      categorie,
      uniteMesure,
      prixVente,
      actif,
    } = req.body;

    // Validation des champs obligatoires
    if (!nom || nom.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Le nom du produit est obligatoire',
      });
    }

    if (prixVente !== undefined && (isNaN(prixVente) || prixVente < 0)) {
      return res.status(400).json({
        success: false,
        message: 'Le prix de vente doit être un nombre positif',
      });
    }

    // Créer la prestation avec l'entrepriseId automatique
    const newProduit = await db
      .insert(produits)
      .values({
        entrepriseId: req.entrepriseId,
        reference: reference || null,
        nom: nom.trim(),
        description: description || null,
        categorie: categorie || null,
        uniteMesure: uniteMesure || 'pièce',
        prixVente: prixVente || '0',
        actif: actif !== undefined ? actif : true,
      })
      .returning();

    res.status(201).json({
      success: true,
      message: 'Produit créé avec succès',
      data: newProduit[0],
    });
  } catch (error) {
    console.error('Erreur POST /api/produits:', error);

    // Gestion des erreurs de contraintes
    if (error.code === '23505') {
      return res.status(400).json({
        success: false,
        message: 'Cette référence produit existe déjà',
      });
    }

    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création du produit',
      error: error.message,
    });
  }
});

/**
 * PUT /api/produits/:id
 * Met à jour un produit existant
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      reference,
      nom,
      description,
      categorie,
      uniteMesure,
      prixVente,
      actif,
    } = req.body;

    // Vérifier que le produit existe et appartient à l'entreprise
    const existingProduit = await db
      .select()
      .from(produits)
      .where(and(
        eq(produits.id, parseInt(id)),
        eq(produits.entrepriseId, req.entrepriseId)
      ))
      .limit(1);

    if (!existingProduit || existingProduit.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Produit non trouvé ou accès non autorisé',
      });
    }

    // Validations (prix de vente uniquement : les champs de stock ne
    // sont plus acceptés en mise à jour).
    if (prixVente !== undefined && (isNaN(prixVente) || prixVente < 0)) {
      return res.status(400).json({
        success: false,
        message: 'Le prix de vente doit être un nombre positif',
      });
    }

    // Construire l'objet de mise à jour
    const updateData = {
      updatedAt: new Date(),
    };

    if (reference !== undefined) updateData.reference = reference;
    if (nom !== undefined) updateData.nom = nom.trim();
    if (description !== undefined) updateData.description = description;
    if (categorie !== undefined) updateData.categorie = categorie;
    if (uniteMesure !== undefined) updateData.uniteMesure = uniteMesure;
    if (prixVente !== undefined) updateData.prixVente = prixVente;
    if (actif !== undefined) updateData.actif = actif;

    // Mettre à jour le produit
    const updatedProduit = await db
      .update(produits)
      .set(updateData)
      .where(and(
        eq(produits.id, parseInt(id)),
        eq(produits.entrepriseId, req.entrepriseId)
      ))
      .returning();

    res.json({
      success: true,
      message: 'Produit mis à jour avec succès',
      data: updatedProduit[0],
    });
  } catch (error) {
    console.error('Erreur PUT /api/produits/:id:', error);

    if (error.code === '23505') {
      return res.status(400).json({
        success: false,
        message: 'Cette référence produit existe déjà',
      });
    }

    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour du produit',
      error: error.message,
    });
  }
});

/**
 * DELETE /api/produits/:id
 * Supprime un produit
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Vérifier que le produit existe et appartient à l'entreprise
    const existingProduit = await db
      .select()
      .from(produits)
      .where(and(
        eq(produits.id, parseInt(id)),
        eq(produits.entrepriseId, req.entrepriseId)
      ))
      .limit(1);

    if (!existingProduit || existingProduit.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Produit non trouvé ou accès non autorisé',
      });
    }

    // Supprimer le produit
    await db
      .delete(produits)
      .where(and(
        eq(produits.id, parseInt(id)),
        eq(produits.entrepriseId, req.entrepriseId)
      ));

    res.json({
      success: true,
      message: 'Produit supprimé avec succès',
    });
  } catch (error) {
    console.error('Erreur DELETE /api/produits/:id:', error);

    // Gestion des erreurs de contraintes (ex: produit utilisé dans commandes/factures)
    if (error.code === '23503') {
      return res.status(400).json({
        success: false,
        message: 'Impossible de supprimer ce produit car il est utilisé dans d\'autres enregistrements',
      });
    }

    res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression du produit',
      error: error.message,
    });
  }
});

/**
 * POST /api/produits/:id/ajuster-stock
 * RETIRÉ (Lite services uniquement) : plus d'ajustement de stock.
 * 410 Gone, comme /stock-faible.
 */
router.post('/:id/ajuster-stock', (_req, res) => {
  res.status(410).json({
    success: false,
    message: 'Les ajustements de stock ont été retirés : ComptaOrion Lite est réservé aux services, sans gestion de stock.',
  });
});

export default router;
