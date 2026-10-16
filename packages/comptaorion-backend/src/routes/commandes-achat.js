import express from 'express';
import { db } from '../db.js';
import { commandesAchat, commandesAchatItems, produits, fournisseurs, mouvementsStock, coutsLogistiquesCommande } from '../schema.js';
import { eq, and, sql, desc } from 'drizzle-orm';

const router = express.Router();

// Génération automatique du numéro de commande
async function genererNumeroCommande(entrepriseId) {
  const annee = new Date().getFullYear();
  const [lastCommande] = await db
    .select()
    .from(commandesAchat)
    .where(eq(commandesAchat.entrepriseId, entrepriseId))
    .orderBy(desc(commandesAchat.id))
    .limit(1);

  let numero = 1;
  if (lastCommande && lastCommande.numeroCommande) {
    const match = lastCommande.numeroCommande.match(/CMD-(\d{4})-(\d+)/);
    if (match && parseInt(match[1]) === annee) {
      numero = parseInt(match[2]) + 1;
    }
  }

  return `CMD-${annee}-${numero.toString().padStart(4, '0')}`;
}

// GET /api/commandes-achat - Liste des commandes d'achat
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 50, statut, fournisseurId } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereConditions = [eq(commandesAchat.entrepriseId, req.entrepriseId)];

    if (statut) {
      whereConditions.push(eq(commandesAchat.statut, statut));
    }

    if (fournisseurId) {
      whereConditions.push(eq(commandesAchat.fournisseurId, parseInt(fournisseurId)));
    }

    const results = await db
      .select({
        commande: commandesAchat,
        fournisseur: fournisseurs,
      })
      .from(commandesAchat)
      .leftJoin(fournisseurs, eq(commandesAchat.fournisseurId, fournisseurs.id))
      .where(and(...whereConditions))
      .orderBy(desc(commandesAchat.createdAt))
      .limit(parseInt(limit))
      .offset(offset);

    // Compter le total
    const [{ count }] = await db
      .select({ count: sql`count(*)::int` })
      .from(commandesAchat)
      .where(and(...whereConditions));

    const formattedResults = results.map(r => ({
      ...r.commande,
      fournisseur: r.fournisseur
    }));

    return res.json({
      success: true,
      data: formattedResults,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des commandes:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des commandes',
      error: error.message
    });
  }
});

// GET /api/commandes-achat/:id - Récupérer une commande avec détails
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [commande] = await db
      .select({
        commande: commandesAchat,
        fournisseur: fournisseurs,
      })
      .from(commandesAchat)
      .leftJoin(fournisseurs, eq(commandesAchat.fournisseurId, fournisseurs.id))
      .where(
        and(
          eq(commandesAchat.id, parseInt(id)),
          eq(commandesAchat.entrepriseId, req.entrepriseId)
        )
      )
      .limit(1);

    if (!commande) {
      return res.status(404).json({
        success: false,
        message: 'Commande non trouvée'
      });
    }

    // Récupérer les lignes de commande
    const items = await db
      .select({
        item: commandesAchatItems,
        produit: produits,
      })
      .from(commandesAchatItems)
      .leftJoin(produits, eq(commandesAchatItems.produitId, produits.id))
      .where(eq(commandesAchatItems.commandeId, parseInt(id)));

    // Récupérer les coûts logistiques
    const couts = await db
      .select()
      .from(coutsLogistiquesCommande)
      .where(eq(coutsLogistiquesCommande.commandeAchatId, parseInt(id)));

    return res.json({
      success: true,
      data: {
        ...commande.commande,
        fournisseur: commande.fournisseur,
        items: items.map(i => ({ ...i.item, produit: i.produit })),
        coutsLogistiques: couts
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération de la commande:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de la commande',
      error: error.message
    });
  }
});

// POST /api/commandes-achat - Créer une commande d'achat
router.post('/', async (req, res) => {
  try {
    const {
      fournisseurId,
      dateCommande,
      dateLivraisonPrevue,
      items,
      coutsLogistiques,
      notes,
      conditionsLivraison,
      modeLivraison
    } = req.body;

    // Validation
    if (!fournisseurId) {
      return res.status(400).json({
        success: false,
        message: 'Le fournisseur est obligatoire'
      });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Au moins un article est obligatoire'
      });
    }

    // Vérifier que le fournisseur existe
    const [fournisseur] = await db
      .select()
      .from(fournisseurs)
      .where(
        and(
          eq(fournisseurs.id, parseInt(fournisseurId)),
          eq(fournisseurs.entrepriseId, req.entrepriseId)
        )
      )
      .limit(1);

    if (!fournisseur) {
      return res.status(404).json({
        success: false,
        message: 'Fournisseur non trouvé'
      });
    }

    // Générer numéro de commande
    const numeroCommande = await genererNumeroCommande(req.entrepriseId);

    // Calculer les totaux articles
    let totalArticlesHT = 0;
    for (const item of items) {
      const quantite = parseFloat(item.quantite);
      const prixUnitaire = parseFloat(item.prixUnitaire);
      const remise = parseFloat(item.remise || 0);
      const totalLigne = quantite * prixUnitaire * (1 - remise / 100);
      totalArticlesHT += totalLigne;
    }

    // Calculer les coûts logistiques
    let totalLogistique = 0;
    if (coutsLogistiques && Array.isArray(coutsLogistiques)) {
      for (const cout of coutsLogistiques) {
        totalLogistique += parseFloat(cout.montant || 0);
      }
    }

    const totalHT = totalArticlesHT + totalLogistique;
    const totalTVA = totalArticlesHT * 0.18; // TVA à récupérer depuis les paramètres entreprise
    const totalTTC = totalHT + totalTVA;

    // Créer la commande
    const [newCommande] = await db
      .insert(commandesAchat)
      .values({
        entrepriseId: req.entrepriseId,
        numeroCommande,
        fournisseurId: parseInt(fournisseurId),
        statut: 'brouillon',
        dateCommande: dateCommande || new Date().toISOString().split('T')[0],
        dateLivraisonPrevue: dateLivraisonPrevue || null,
        totalArticlesHT: totalArticlesHT.toFixed(2),
        totalLogistique: totalLogistique.toFixed(2),
        totalHT: totalHT.toFixed(2),
        totalTVA: totalTVA.toFixed(2),
        totalTTC: totalTTC.toFixed(2),
        notes: notes || null,
        conditionsLivraison: conditionsLivraison || null,
        modeLivraison: modeLivraison || null,
        userId: req.user.id,
      })
      .returning();

    // Créer les lignes de commande
    const itemsToInsert = items.map(item => {
      const quantite = parseFloat(item.quantite);
      const prixUnitaire = parseFloat(item.prixUnitaire);
      const remise = parseFloat(item.remise || 0);
      const totalLigne = quantite * prixUnitaire * (1 - remise / 100);

      return {
        entrepriseId: req.entrepriseId,
        commandeId: newCommande.id,
        produitId: item.produitId ? parseInt(item.produitId) : null,
        description: item.description,
        quantite: quantite.toString(),
        quantiteRecue: '0',
        prixUnitaire: prixUnitaire.toFixed(2),
        remise: remise.toFixed(2),
        totalLigne: totalLigne.toFixed(2),
      };
    });

    const insertedItems = await db
      .insert(commandesAchatItems)
      .values(itemsToInsert)
      .returning();

    // Créer les coûts logistiques
    let insertedCouts = [];
    if (coutsLogistiques && Array.isArray(coutsLogistiques) && coutsLogistiques.length > 0) {
      const coutsToInsert = coutsLogistiques.map(cout => ({
        entrepriseId: req.entrepriseId,
        commandeAchatId: newCommande.id,
        type: cout.type,
        description: cout.description || null,
        montant: parseFloat(cout.montant).toFixed(2),
      }));

      insertedCouts = await db
        .insert(coutsLogistiquesCommande)
        .values(coutsToInsert)
        .returning();
    }

    return res.status(201).json({
      success: true,
      message: 'Commande créée avec succès',
      data: {
        ...newCommande,
        items: insertedItems,
        coutsLogistiques: insertedCouts
      }
    });
  } catch (error) {
    console.error('Erreur lors de la création de la commande:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de la commande',
      error: error.message
    });
  }
});

// PUT /api/commandes-achat/:id/confirmer - Confirmer une commande (valider)
router.put('/:id/confirmer', async (req, res) => {
  try {
    const { id } = req.params;

    const [commande] = await db
      .select()
      .from(commandesAchat)
      .where(
        and(
          eq(commandesAchat.id, parseInt(id)),
          eq(commandesAchat.entrepriseId, req.entrepriseId)
        )
      )
      .limit(1);

    if (!commande) {
      return res.status(404).json({
        success: false,
        message: 'Commande non trouvée'
      });
    }

    if (commande.statut !== 'brouillon') {
      return res.status(400).json({
        success: false,
        message: 'Seules les commandes en brouillon peuvent être confirmées'
      });
    }

    const [updated] = await db
      .update(commandesAchat)
      .set({
        statut: 'confirmee',
        updatedAt: new Date()
      })
      .where(eq(commandesAchat.id, parseInt(id)))
      .returning();

    return res.json({
      success: true,
      message: 'Commande confirmée avec succès',
      data: updated
    });
  } catch (error) {
    console.error('Erreur lors de la confirmation de la commande:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la confirmation de la commande',
      error: error.message
    });
  }
});

// PUT /api/commandes-achat/:id/annuler - Annuler une commande
router.put('/:id/annuler', async (req, res) => {
  try {
    const { id } = req.params;
    const { motifAnnulation } = req.body;

    const [commande] = await db
      .select()
      .from(commandesAchat)
      .where(
        and(
          eq(commandesAchat.id, parseInt(id)),
          eq(commandesAchat.entrepriseId, req.entrepriseId)
        )
      )
      .limit(1);

    if (!commande) {
      return res.status(404).json({
        success: false,
        message: 'Commande non trouvée'
      });
    }

    if (commande.statut === 'livree') {
      return res.status(400).json({
        success: false,
        message: 'Une commande livrée ne peut pas être annulée'
      });
    }

    const [updated] = await db
      .update(commandesAchat)
      .set({
        statut: 'annulee',
        notes: motifAnnulation ? `${commande.notes || ''}\n\nAnnulation: ${motifAnnulation}` : commande.notes,
        updatedAt: new Date()
      })
      .where(eq(commandesAchat.id, parseInt(id)))
      .returning();

    return res.json({
      success: true,
      message: 'Commande annulée avec succès',
      data: updated
    });
  } catch (error) {
    console.error('Erreur lors de l\'annulation de la commande:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'annulation de la commande',
      error: error.message
    });
  }
});

export default router;
