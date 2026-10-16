import express from 'express';
import { db } from '../db.js';
import { commandesAchat, commandesAchatItems, produits, mouvementsStock, fournisseurs } from '../schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { createEcritureReception } from '../services/comptabiliteService.js';

const router = express.Router();

// POST /api/receptions - Enregistrer une réception de marchandises
router.post('/', async (req, res) => {
  try {
    const {
      commandeId,
      dateReception,
      items, // [{ commandeItemId, quantiteRecue }]
      notes,
      numeroLivraison
    } = req.body;

    // Validation
    if (!commandeId) {
      return res.status(400).json({
        success: false,
        message: 'La commande est obligatoire'
      });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Au moins un article est obligatoire'
      });
    }

    // Vérifier que la commande existe et est confirmée
    const [commande] = await db
      .select()
      .from(commandesAchat)
      .where(
        and(
          eq(commandesAchat.id, parseInt(commandeId)),
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

    if (commande.statut !== 'confirmee' && commande.statut !== 'preparee') {
      return res.status(400).json({
        success: false,
        message: 'Seules les commandes confirmées ou en préparation peuvent être reçues'
      });
    }

    // Traiter chaque ligne de réception
    const mouvements = [];
    let toutRecu = true;

    for (const item of items) {
      const quantiteRecue = parseFloat(item.quantiteRecue);
      
      if (quantiteRecue <= 0) {
        continue; // Ignorer les quantités nulles
      }

      // Récupérer la ligne de commande avec isolation tenant ET commande
      const [commandeItem] = await db
        .select()
        .from(commandesAchatItems)
        .where(
          and(
            eq(commandesAchatItems.id, parseInt(item.commandeItemId)),
            eq(commandesAchatItems.commandeId, parseInt(commandeId)),
            eq(commandesAchatItems.entrepriseId, req.entrepriseId)
          )
        )
        .limit(1);

      if (!commandeItem) {
        return res.status(404).json({
          success: false,
          message: `Ligne de commande ${item.commandeItemId} non trouvée`
        });
      }

      const quantiteCommandee = parseFloat(commandeItem.quantite);
      const quantiteDejaRecue = parseFloat(commandeItem.quantiteRecue || '0');
      const nouvelleQuantiteRecue = quantiteDejaRecue + quantiteRecue;

      // Vérifier qu'on ne dépasse pas la quantité commandée
      if (nouvelleQuantiteRecue > quantiteCommandee) {
        return res.status(400).json({
          success: false,
          message: `La quantité reçue (${nouvelleQuantiteRecue}) dépasse la quantité commandée (${quantiteCommandee}) pour l'article ${commandeItem.description}`
        });
      }

      // Mettre à jour la ligne de commande
      await db
        .update(commandesAchatItems)
        .set({
          quantiteRecue: nouvelleQuantiteRecue.toString()
        })
        .where(eq(commandesAchatItems.id, commandeItem.id));

      // Si pas tout reçu pour cette ligne, la commande n'est pas complète
      if (nouvelleQuantiteRecue < quantiteCommandee) {
        toutRecu = false;
      }

      // Créer le mouvement de stock (entrée)
      if (commandeItem.produitId) {
        mouvements.push({
          entrepriseId: req.entrepriseId,
          produitId: commandeItem.produitId,
          type: 'entree',
          quantite: quantiteRecue.toString(),
          dateMouvement: dateReception || new Date().toISOString().split('T')[0],
          reference: `Réception ${commande.numeroCommande}`,
          notes: notes || `Réception commande ${commande.numeroCommande}${numeroLivraison ? ` - BL ${numeroLivraison}` : ''}`,
          userId: req.user.id,
        });

        // Mettre à jour le stock du produit
        const [produit] = await db
          .select()
          .from(produits)
          .where(
            and(
              eq(produits.id, commandeItem.produitId),
              eq(produits.entrepriseId, req.entrepriseId)
            )
          )
          .limit(1);

        if (produit) {
          const nouvelleQuantite = parseFloat(produit.quantite) + quantiteRecue;
          await db
            .update(produits)
            .set({
              quantite: nouvelleQuantite.toString(),
              updatedAt: new Date()
            })
            .where(eq(produits.id, commandeItem.produitId));
        }
      }
    }

    // Enregistrer les mouvements de stock
    if (mouvements.length > 0) {
      await db.insert(mouvementsStock).values(mouvements);
    }

    // Mettre à jour le statut de la commande
    const nouveauStatut = toutRecu ? 'livree' : 'preparee';
    await db
      .update(commandesAchat)
      .set({
        statut: nouveauStatut,
        updatedAt: new Date()
      })
      .where(eq(commandesAchat.id, parseInt(commandeId)));

    // Générer l'écriture comptable pour la réception (uniquement pour les quantités effectivement reçues)
    let ecritureComptable = null;
    if (mouvements.length > 0) {
      try {
        // Récupérer le fournisseur avec filtre entrepriseId
        let fournisseurNom = 'Fournisseur';
        if (commande.fournisseurId) {
          const [fourn] = await db.select().from(fournisseurs)
            .where(and(
              eq(fournisseurs.id, commande.fournisseurId),
              eq(fournisseurs.entrepriseId, req.entrepriseId)
            ));
          if (fourn) fournisseurNom = fourn.raisonSociale;
        }

        // Calculer le total HT basé uniquement sur les quantités reçues dans cette opération
        let totalHTReception = 0;
        for (const item of items) {
          const quantiteRecue = parseFloat(item.quantiteRecue);
          if (quantiteRecue > 0) {
            // Récupérer le prix unitaire avec isolation tenant ET commande
            const [commandeItem] = await db
              .select()
              .from(commandesAchatItems)
              .where(and(
                eq(commandesAchatItems.id, parseInt(item.commandeItemId)),
                eq(commandesAchatItems.commandeId, parseInt(commandeId)),
                eq(commandesAchatItems.entrepriseId, req.entrepriseId)
              ))
              .limit(1);
            
            if (commandeItem) {
              const prixUnitaire = parseFloat(commandeItem.prixUnitaire || 0);
              totalHTReception += quantiteRecue * prixUnitaire;
            }
          }
        }

        // Ne créer l'écriture que si le montant est positif
        if (totalHTReception > 0) {
          ecritureComptable = await createEcritureReception({
            entrepriseId: req.entrepriseId,
            receptionNumero: `REC-${commande.numeroCommande}-${Date.now()}`,
            dateReception: dateReception || new Date().toISOString().split('T')[0],
            fournisseurNom,
            totalHT: totalHTReception
          });
        }
      } catch (err) {
        console.warn('Écriture comptable non générée:', err.message);
      }
    }

    return res.json({
      success: true,
      message: toutRecu ? 'Réception complète enregistrée' : 'Réception partielle enregistrée',
      data: {
        commandeId: parseInt(commandeId),
        statut: nouveauStatut,
        mouvementsStock: mouvements.length,
        toutRecu,
        ecritureComptableId: ecritureComptable?.id || null
      }
    });
  } catch (error) {
    console.error('Erreur lors de l\'enregistrement de la réception:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'enregistrement de la réception',
      error: error.message
    });
  }
});

// GET /api/receptions/commande/:commandeId - Historique des réceptions pour une commande
router.get('/commande/:commandeId', async (req, res) => {
  try {
    const { commandeId } = req.params;

    // Récupérer les mouvements de stock liés à cette commande
    const [commande] = await db
      .select()
      .from(commandesAchat)
      .where(
        and(
          eq(commandesAchat.id, parseInt(commandeId)),
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

    // Récupérer les mouvements de stock
    const mouvements = await db
      .select({
        mouvement: mouvementsStock,
        produit: produits,
      })
      .from(mouvementsStock)
      .leftJoin(produits, eq(mouvementsStock.produitId, produits.id))
      .where(
        and(
          eq(mouvementsStock.entrepriseId, req.entrepriseId),
          sql`${mouvementsStock.reference} LIKE ${`%${commande.numeroCommande}%`}`
        )
      );

    // Récupérer l'état des lignes de commande
    const items = await db
      .select({
        item: commandesAchatItems,
        produit: produits,
      })
      .from(commandesAchatItems)
      .leftJoin(produits, eq(commandesAchatItems.produitId, produits.id))
      .where(eq(commandesAchatItems.commandeId, parseInt(commandeId)));

    return res.json({
      success: true,
      data: {
        commande,
        items: items.map(i => ({
          ...i.item,
          produit: i.produit,
          quantiteRestante: parseFloat(i.item.quantite) - parseFloat(i.item.quantiteRecue || '0')
        })),
        mouvements: mouvements.map(m => ({ ...m.mouvement, produit: m.produit }))
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des réceptions:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des réceptions',
      error: error.message
    });
  }
});

export default router;
