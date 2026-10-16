import express from 'express';
import { db } from '../db.js';
import { 
  facturesAchat, 
  factureAchatItems,
  paiementsFournisseurs,
  fournisseurs,
  commandesAchat,
  commandesAchatItems,
  transactionsTresorerie,
  comptesBancaires,
  mouvementsStock,
  produits
} from '../schema.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import { createEcritureFactureAchat, createEcriturePaiementFournisseur } from '../services/comptabiliteService.js';

const router = express.Router();

// Génération automatique du numéro de facture achat
async function genererNumeroFactureAchat(entrepriseId) {
  const annee = new Date().getFullYear();
  const [lastFacture] = await db
    .select()
    .from(facturesAchat)
    .where(eq(facturesAchat.entrepriseId, entrepriseId))
    .orderBy(desc(facturesAchat.id))
    .limit(1);

  let numero = 1;
  if (lastFacture && lastFacture.numeroFacture) {
    const match = lastFacture.numeroFacture.match(/FACT-ACH-(\d{4})-(\d+)/);
    if (match && parseInt(match[1]) === annee) {
      numero = parseInt(match[2]) + 1;
    }
  }

  return `FACT-ACH-${annee}-${numero.toString().padStart(4, '0')}`;
}

// =========================================
// FACTURES FOURNISSEURS
// =========================================

// GET /api/achats/factures - Liste des factures fournisseurs
router.get('/factures', async (req, res) => {
  try {
    const { page = 1, limit = 50, statut, fournisseurId } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereConditions = [eq(facturesAchat.entrepriseId, req.entrepriseId)];

    if (statut) {
      whereConditions.push(eq(facturesAchat.statut, statut));
    }

    if (fournisseurId) {
      whereConditions.push(eq(facturesAchat.fournisseurId, parseInt(fournisseurId)));
    }

    const results = await db
      .select({
        facture: facturesAchat,
        fournisseur: fournisseurs,
      })
      .from(facturesAchat)
      .leftJoin(fournisseurs, eq(facturesAchat.fournisseurId, fournisseurs.id))
      .where(and(...whereConditions))
      .orderBy(desc(facturesAchat.createdAt))
      .limit(parseInt(limit))
      .offset(offset);

    const [{ count }] = await db
      .select({ count: sql`count(*)::int` })
      .from(facturesAchat)
      .where(and(...whereConditions));

    const formattedResults = results.map(r => ({
      ...r.facture,
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
    console.error('Erreur lors de la récupération des factures:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des factures',
      error: error.message
    });
  }
});

// GET /api/achats/factures/:id - Détails d'une facture fournisseur
router.get('/factures/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [facture] = await db
      .select({
        facture: facturesAchat,
        fournisseur: fournisseurs,
      })
      .from(facturesAchat)
      .leftJoin(fournisseurs, eq(facturesAchat.fournisseurId, fournisseurs.id))
      .where(
        and(
          eq(facturesAchat.id, parseInt(id)),
          eq(facturesAchat.entrepriseId, req.entrepriseId)
        )
      )
      .limit(1);

    if (!facture) {
      return res.status(404).json({
        success: false,
        message: 'Facture non trouvée'
      });
    }

    // Récupérer les lignes de facture
    const items = await db
      .select()
      .from(factureAchatItems)
      .where(eq(factureAchatItems.factureId, parseInt(id)));

    // Récupérer les paiements
    const paiements = await db
      .select()
      .from(paiementsFournisseurs)
      .where(eq(paiementsFournisseurs.factureId, parseInt(id)));

    return res.json({
      success: true,
      data: {
        ...facture.facture,
        fournisseur: facture.fournisseur,
        items,
        paiements
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération de la facture:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de la facture',
      error: error.message
    });
  }
});

// POST /api/achats/factures - Créer une facture fournisseur
router.post('/factures', async (req, res) => {
  try {
    const {
      fournisseurId,
      commandeId, // Optionnel - si depuis une commande
      numeroFactureFournisseur, // Numéro de facture du fournisseur
      dateFacture,
      dateEcheance,
      items,
      notes
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

    // Générer numéro de facture
    const numeroFacture = await genererNumeroFactureAchat(req.entrepriseId);

    // Calculer les totaux
    let totalHT = 0;
    for (const item of items) {
      const quantite = parseFloat(item.quantite);
      const prixUnitaire = parseFloat(item.prixUnitaire);
      const remise = parseFloat(item.remise || 0);
      const totalLigne = quantite * prixUnitaire * (1 - remise / 100);
      totalHT += totalLigne;
    }

    const totalTVA = totalHT * 0.18;
    const totalTTC = totalHT + totalTVA;

    // Créer la facture
    const [newFacture] = await db
      .insert(facturesAchat)
      .values({
        entrepriseId: req.entrepriseId,
        numeroFacture,
        numeroFactureFournisseur: numeroFactureFournisseur || null,
        fournisseurId: parseInt(fournisseurId),
        commandeId: commandeId ? parseInt(commandeId) : null,
        statut: 'brouillon',
        dateFacture: dateFacture || new Date().toISOString().split('T')[0],
        dateEcheance: dateEcheance || null,
        totalHT: totalHT.toFixed(2),
        totalTVA: totalTVA.toFixed(2),
        totalTTC: totalTTC.toFixed(2),
        montantPaye: '0',
        soldeRestant: totalTTC.toFixed(2),
        notes: notes || null,
        userId: req.user.id,
      })
      .returning();

    // Créer les lignes de facture
    const itemsToInsert = items.map(item => {
      const quantite = parseFloat(item.quantite);
      const prixUnitaire = parseFloat(item.prixUnitaire);
      const remise = parseFloat(item.remise || 0);
      const totalLigne = quantite * prixUnitaire * (1 - remise / 100);

      return {
        entrepriseId: req.entrepriseId,
        factureId: newFacture.id,
        produitId: item.produitId ? parseInt(item.produitId) : null,
        description: item.description,
        quantite: quantite.toString(),
        prixUnitaire: prixUnitaire.toFixed(2),
        remise: remise.toFixed(2),
        totalLigne: totalLigne.toFixed(2),
      };
    });

    const insertedItems = await db
      .insert(factureAchatItems)
      .values(itemsToInsert)
      .returning();

    return res.status(201).json({
      success: true,
      message: 'Facture créée avec succès',
      data: {
        ...newFacture,
        items: insertedItems
      }
    });
  } catch (error) {
    console.error('Erreur lors de la création de la facture:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de la facture',
      error: error.message
    });
  }
});

// PUT /api/achats/factures/:id/valider - Valider une facture fournisseur
router.put('/factures/:id/valider', async (req, res) => {
  try {
    const { id } = req.params;

    const [facture] = await db
      .select()
      .from(facturesAchat)
      .where(
        and(
          eq(facturesAchat.id, parseInt(id)),
          eq(facturesAchat.entrepriseId, req.entrepriseId)
        )
      )
      .limit(1);

    if (!facture) {
      return res.status(404).json({
        success: false,
        message: 'Facture non trouvée'
      });
    }

    if (facture.statut !== 'brouillon') {
      return res.status(400).json({
        success: false,
        message: 'Seules les factures en brouillon peuvent être validées'
      });
    }

    const [updated] = await db
      .update(facturesAchat)
      .set({
        statut: 'validee',
        updatedAt: new Date()
      })
      .where(eq(facturesAchat.id, parseInt(id)))
      .returning();

    // Mettre à jour le solde dû du fournisseur
    await db
      .update(fournisseurs)
      .set({
        soldeDu: sql`${fournisseurs.soldeDu} + ${updated.totalTTC}`,
        updatedAt: new Date()
      })
      .where(eq(fournisseurs.id, facture.fournisseurId));

    // ✅ NOUVEAU: Génération automatique des mouvements de stock ENTRÉE
    const factureItems = await db
      .select()
      .from(factureAchatItems)
      .where(eq(factureAchatItems.factureId, parseInt(id)));

    for (const item of factureItems) {
      if (item.produitId) {
        // Créer mouvement de stock ENTRÉE
        await db.insert(mouvementsStock).values({
          entrepriseId: req.entrepriseId,
          produitId: item.produitId,
          type: 'entree',
          quantite: item.quantite,
          prixUnitaire: item.prixUnitaire,
          reference: `Facture ${updated.numeroFacture}`,
          notes: `Réception depuis facture fournisseur ${updated.numeroFactureFournisseur || updated.numeroFacture}`,
          userId: req.user.id
        });

        // Mettre à jour le stock du produit
        await db
          .update(produits)
          .set({
            quantite: sql`${produits.quantite} + ${item.quantite}`,
            updatedAt: new Date()
          })
          .where(eq(produits.id, item.produitId));
      }
    }

    console.log(`✅ Facture ${updated.numeroFacture} validée - ${factureItems.length} mouvements de stock créés`);

    return res.json({
      success: true,
      message: 'Facture validée avec succès et stock mis à jour',
      data: updated
    });
  } catch (error) {
    console.error('Erreur lors de la validation de la facture:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la validation de la facture',
      error: error.message
    });
  }
});

// =========================================
// PAIEMENTS FOURNISSEURS
// =========================================

// POST /api/achats/factures/:id/paiement - Enregistrer un paiement fournisseur
router.post('/factures/:id/paiement', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      montant,
      modePaiement,
      reference,
      datePaiement,
      compteBancaireId,
      notes
    } = req.body;

    // Validation
    if (!montant || parseFloat(montant) <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Le montant est obligatoire et doit être supérieur à 0'
      });
    }

    const montantPaiement = parseFloat(montant);

    // Récupérer la facture
    const [factureData] = await db
      .select()
      .from(facturesAchat)
      .where(
        and(
          eq(facturesAchat.id, parseInt(id)),
          eq(facturesAchat.entrepriseId, req.entrepriseId)
        )
      )
      .limit(1);

    if (!factureData) {
      return res.status(404).json({
        success: false,
        message: 'Facture non trouvée'
      });
    }

    const soldeRestant = parseFloat(factureData.soldeRestant);

    if (montantPaiement > soldeRestant) {
      return res.status(400).json({
        success: false,
        message: `Le montant du paiement (${montantPaiement}) dépasse le solde restant (${soldeRestant})`
      });
    }

    // Enregistrer le paiement
    const [paiement] = await db
      .insert(paiementsFournisseurs)
      .values({
        entrepriseId: req.entrepriseId,
        factureId: parseInt(id),
        fournisseurId: factureData.fournisseurId,
        montant: montantPaiement.toFixed(2),
        modePaiement: modePaiement || null,
        reference: reference || null,
        datePaiement: datePaiement || new Date().toISOString().split('T')[0],
        notes: notes || null,
        userId: req.user.id,
      })
      .returning();

    // Mettre à jour la facture
    const nouveauMontantPaye = parseFloat(factureData.montantPaye) + montantPaiement;
    const nouveauSolde = parseFloat(factureData.totalTTC) - nouveauMontantPaye;
    const nouveauStatut = nouveauSolde <= 0.01 ? 'payee' : 'partiellement_payee';

    const [factureUpdated] = await db
      .update(facturesAchat)
      .set({
        montantPaye: nouveauMontantPaye.toFixed(2),
        soldeRestant: nouveauSolde.toFixed(2),
        statut: nouveauStatut,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(facturesAchat.id, parseInt(id)),
          eq(facturesAchat.entrepriseId, req.entrepriseId)
        )
      )
      .returning();

    // Impact sur le solde dû du fournisseur
    await db
      .update(fournisseurs)
      .set({
        soldeDu: sql`${fournisseurs.soldeDu} - ${montantPaiement}`,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(fournisseurs.id, factureData.fournisseurId),
          eq(fournisseurs.entrepriseId, req.entrepriseId)
        )
      );

    // Impact sur la trésorerie si un compte bancaire est spécifié
    if (compteBancaireId) {
      // Créer la transaction de trésorerie (décaissement)
      await db.insert(transactionsTresorerie).values({
        entrepriseId: req.entrepriseId,
        compteBancaireId: parseInt(compteBancaireId),
        type: 'decaissement',
        montant: montantPaiement.toFixed(2),
        dateTransaction: datePaiement || new Date().toISOString().split('T')[0],
        categorie: 'Achat',
        description: `Paiement facture ${factureData.numeroFacture}`,
        tiersNom: null,
        numeroPiece: factureData.numeroFacture,
        modePaiement: modePaiement || null,
        userId: req.user.id,
      });

      // Mettre à jour le solde du compte bancaire
      await db
        .update(comptesBancaires)
        .set({
          soldeActuel: sql`${comptesBancaires.soldeActuel} - ${montantPaiement}`,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(comptesBancaires.id, parseInt(compteBancaireId)),
            eq(comptesBancaires.entrepriseId, req.entrepriseId)
          )
        );
    }

    // Impact automatique sur COMPTABILITÉ
    // Débit: Fournisseur (401) - Crédit: Banque/Caisse
    try {
      const fournisseurData = await db.select().from(fournisseurs).where(eq(fournisseurs.id, factureData.fournisseurId)).limit(1);
      const fournisseurInfo = fournisseurData[0] || {};
      
      await createEcriturePaiementFournisseur({
        entrepriseId: req.entrepriseId,
        reference: reference || `PAI-F-${paiement.id}`,
        datePaiement: datePaiement || new Date().toISOString().split('T')[0],
        fournisseurNom: fournisseurInfo.raisonSociale || fournisseurInfo.nom || 'Fournisseur',
        fournisseurCompteId: fournisseurInfo.compteComptableId,
        montant: montantPaiement,
        modePaiement: modePaiement === 'especes' ? 'especes' : 'banque',
        compteBancaireId: compteBancaireId ? parseInt(compteBancaireId) : null
      });
    } catch (comptaError) {
      console.warn('Avertissement: Écriture comptable paiement fournisseur non générée:', comptaError.message);
    }

    return res.json({
      success: true,
      message: 'Paiement enregistré avec succès',
      data: {
        paiement,
        facture: {
          montantPaye: factureUpdated.montantPaye,
          soldeRestant: factureUpdated.soldeRestant,
          statut: factureUpdated.statut
        }
      }
    });
  } catch (error) {
    console.error('Erreur lors de l\'enregistrement du paiement:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'enregistrement du paiement',
      error: error.message
    });
  }
});

// GET /api/achats/echeances - Échéancier des factures fournisseurs
router.get('/echeances', async (req, res) => {
  try {
    const { debutPeriode, finPeriode } = req.query;

    let whereConditions = [
      eq(facturesAchat.entrepriseId, req.entrepriseId),
      sql`${facturesAchat.statut} != 'payee'`,
      sql`${facturesAchat.dateEcheance} IS NOT NULL`
    ];

    if (debutPeriode) {
      whereConditions.push(sql`${facturesAchat.dateEcheance} >= ${debutPeriode}`);
    }

    if (finPeriode) {
      whereConditions.push(sql`${facturesAchat.dateEcheance} <= ${finPeriode}`);
    }

    const results = await db
      .select({
        facture: facturesAchat,
        fournisseur: fournisseurs,
      })
      .from(facturesAchat)
      .leftJoin(fournisseurs, eq(facturesAchat.fournisseurId, fournisseurs.id))
      .where(and(...whereConditions))
      .orderBy(facturesAchat.dateEcheance);

    const formattedResults = results.map(r => ({
      ...r.facture,
      fournisseur: r.fournisseur,
      retard: new Date(r.facture.dateEcheance) < new Date() ? true : false
    }));

    return res.json({
      success: true,
      data: formattedResults
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des échéances:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des échéances',
      error: error.message
    });
  }
});

// =========================================
// COSTING - RAPPROCHEMENT RECEPTIONS/FACTURES
// =========================================

// GET /api/achats/receptions-en-attente - Réceptions en attente de facturation pour un fournisseur
router.get('/receptions-en-attente', async (req, res) => {
  try {
    const fournisseurId = req.query.fournisseurId ? parseInt(req.query.fournisseurId, 10) : null;
    const entrepriseId = parseInt(req.entrepriseId, 10);
    
    // Construire la requête avec sql template literals (sécurisé)
    let query = sql`
      SELECT br.*, f.raison_sociale as fournisseur_nom,
             (SELECT json_agg(lr.*) FROM lignes_reception lr WHERE lr.bon_reception_id = br.id) as lignes
      FROM bons_reception br
      LEFT JOIN fournisseurs f ON br.fournisseur_id = f.id
      WHERE br.entreprise_id = ${entrepriseId} AND br.statut = 'validee' AND br.facture_achat_id IS NULL
    `;
    
    if (fournisseurId && !isNaN(fournisseurId)) {
      query = sql`${query} AND br.fournisseur_id = ${fournisseurId}`;
    }
    
    query = sql`${query} ORDER BY br.date_reception ASC`;
    
    const result = await db.execute(query);
    
    res.json({ success: true, data: result.rows || [] });
  } catch (error) {
    console.error('Erreur récupération réceptions en attente:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/achats/logistique-pending/:receptionId - Coûts logistiques pending pour une réception
router.get('/logistique-pending/:receptionId', async (req, res) => {
  try {
    const receptionId = parseInt(req.params.receptionId);
    
    const result = await db.execute(sql`
      SELECT * FROM logistique_pending 
      WHERE entreprise_id = ${req.entrepriseId} 
        AND bon_reception_id = ${receptionId}
        AND statut = 'pending'
    `);
    
    res.json({ success: true, data: result.rows || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/achats/factures-avec-rapprochement - Créer facture avec rapprochement des réceptions
router.post('/factures-avec-rapprochement', async (req, res) => {
  try {
    const {
      fournisseurId,
      numeroFactureFournisseur,
      dateFacture,
      dateEcheance,
      receptionsIds, // Array des IDs de bons de réception à rapprocher
      lignes, // Lignes avec coûts réels: { produitId, quantite, prixUnitaireReel, description }
      coutsLogistiques, // Coûts logistiques réels: { type, montantReel, description }
      notes
    } = req.body;

    // Validation
    if (!fournisseurId) {
      return res.status(400).json({ success: false, message: 'Le fournisseur est obligatoire' });
    }
    if (!receptionsIds || receptionsIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Au moins une réception à rapprocher est obligatoire' });
    }

    // Vérifier que le fournisseur existe
    const fournisseurResult = await db.execute(sql`
      SELECT * FROM fournisseurs WHERE id = ${parseInt(fournisseurId)} AND entreprise_id = ${req.entrepriseId}
    `);
    if (!fournisseurResult.rows?.length) {
      return res.status(404).json({ success: false, message: 'Fournisseur non trouvé' });
    }
    const fournisseur = fournisseurResult.rows[0];

    // Vérifier que les réceptions existent et appartiennent au fournisseur
    for (const recId of receptionsIds) {
      const recResult = await db.execute(sql`
        SELECT * FROM bons_reception 
        WHERE id = ${parseInt(recId)} 
          AND entreprise_id = ${req.entrepriseId}
          AND fournisseur_id = ${parseInt(fournisseurId)}
          AND statut = 'validee'
          AND facture_achat_id IS NULL
      `);
      if (!recResult.rows?.length) {
        return res.status(400).json({ success: false, message: `Réception ${recId} invalide ou déjà facturée` });
      }
    }

    // Générer numéro de facture
    const numeroFacture = await genererNumeroFactureAchat(req.entrepriseId);

    // Calculer totaux articles
    let totalArticlesHT = 0;
    const lignesProcessed = lignes.map(l => {
      const qt = parseFloat(l.quantite);
      const pu = parseFloat(l.prixUnitaireReel);
      const total = qt * pu;
      totalArticlesHT += total;
      return { ...l, totalLigne: total };
    });

    // Calculer totaux coûts logistiques
    let totalLogistique = 0;
    const coutsProcessed = (coutsLogistiques || []).map(c => {
      const montant = parseFloat(c.montantReel);
      totalLogistique += montant;
      return { ...c, montant };
    });

    const totalHT = totalArticlesHT + totalLogistique;
    const totalTVA = totalHT * 0.18;
    const totalTTC = totalHT + totalTVA;

    // Créer la facture
    const factureResult = await db.execute(sql`
      INSERT INTO factures_achat (entreprise_id, numero_facture, numero_facture_fournisseur, fournisseur_id, statut, date_facture, date_echeance, total_ht, total_tva, total_ttc, montant_paye, solde_restant, notes, user_id)
      VALUES (${req.entrepriseId}, ${numeroFacture}, ${numeroFactureFournisseur || null}, ${parseInt(fournisseurId)}, 'brouillon', ${dateFacture || new Date().toISOString().split('T')[0]}, ${dateEcheance || null}, ${totalHT.toFixed(2)}, ${totalTVA.toFixed(2)}, ${totalTTC.toFixed(2)}, '0', ${totalTTC.toFixed(2)}, ${notes || null}, ${req.user?.id || null})
      RETURNING *
    `);
    const newFacture = factureResult.rows[0];

    // Créer les lignes de facture
    for (const ligne of lignesProcessed) {
      await db.execute(sql`
        INSERT INTO facture_achat_items (entreprise_id, facture_id, produit_id, description, quantite, prix_unitaire, total_ligne)
        VALUES (${req.entrepriseId}, ${newFacture.id}, ${ligne.produitId ? parseInt(ligne.produitId) : null}, ${ligne.description}, ${ligne.quantite}, ${ligne.prixUnitaireReel}, ${ligne.totalLigne.toFixed(2)})
      `);
    }

    // Créer les lignes de coûts logistiques dans la facture
    for (const cout of coutsProcessed) {
      await db.execute(sql`
        INSERT INTO facture_achat_items (entreprise_id, facture_id, produit_id, description, quantite, prix_unitaire, total_ligne)
        VALUES (${req.entrepriseId}, ${newFacture.id}, ${null}, ${`Frais ${cout.type}: ${cout.description || ''}`}, ${1}, ${cout.montant.toFixed(2)}, ${cout.montant.toFixed(2)})
      `);
    }

    // Lier les réceptions à la facture et mettre à jour les stock_pending
    for (const recId of receptionsIds) {
      // Mettre à jour le bon de réception
      await db.execute(sql`
        UPDATE bons_reception SET facture_achat_id = ${newFacture.id}, updated_at = NOW() WHERE id = ${parseInt(recId)}
      `);

      // Mettre à jour les stock_pending -> invoiced
      await db.execute(sql`
        UPDATE stock_pending 
        SET statut = 'invoiced', facture_achat_id = ${newFacture.id}, date_facturation = NOW(), updated_at = NOW()
        WHERE bon_reception_id = ${parseInt(recId)} AND statut = 'pending'
      `);

      // Mettre à jour les logistique_pending -> invoiced
      await db.execute(sql`
        UPDATE logistique_pending 
        SET statut = 'invoiced', facture_achat_id = ${newFacture.id}, date_facturation = NOW(), updated_at = NOW()
        WHERE bon_reception_id = ${parseInt(recId)} AND statut = 'pending'
      `);
    }

    // Mettre à jour les coûts réels dans stock_pending (prix réel vs estimé)
    for (const ligne of lignesProcessed) {
      if (ligne.produitId) {
        await db.execute(sql`
          UPDATE stock_pending 
          SET prix_reel = ${ligne.prixUnitaireReel}, ecart_prix = ${ligne.prixUnitaireReel} - prix_estime
          WHERE facture_achat_id = ${newFacture.id} AND produit_id = ${parseInt(ligne.produitId)}
        `);
      }
    }

    // Mettre à jour les coûts réels dans logistique_pending
    for (const cout of coutsProcessed) {
      await db.execute(sql`
        UPDATE logistique_pending 
        SET montant_reel = ${cout.montant.toFixed(2)}, ecart_montant = ${cout.montant} - montant_estime
        WHERE facture_achat_id = ${newFacture.id} AND type = ${cout.type}
      `);
    }

    // *** INTÉGRATION COMPTABLE AUTOMATIQUE ***
    // Calculer le montant pending (estimé à la réception) pour régulariser le compte 408
    const pendingResult = await db.execute(sql`
      SELECT 
        COALESCE(SUM(sp.valeur_estimee), 0) as total_stock_pending,
        COALESCE(SUM(lp.montant_estime), 0) as total_logistique_pending
      FROM (
        SELECT COALESCE(SUM(valeur_estimee), 0) as valeur_estimee 
        FROM stock_pending WHERE facture_achat_id = ${newFacture.id}
      ) sp,
      (
        SELECT COALESCE(SUM(montant_estime), 0) as montant_estime 
        FROM logistique_pending WHERE facture_achat_id = ${newFacture.id}
      ) lp
    `);
    
    const totalPending = parseFloat(pendingResult.rows?.[0]?.total_stock_pending || 0) + parseFloat(pendingResult.rows?.[0]?.total_logistique_pending || 0);
    const ecartPrix = totalHT - totalPending;

    try {
      const ecriture = await createEcritureFactureAchat({
        entrepriseId: req.entrepriseId,
        numeroFacture: numeroFacture,
        dateFacture: dateFacture || new Date().toISOString().split('T')[0],
        fournisseurNom: fournisseur.raison_sociale || fournisseur.nom,
        fournisseurCompteId: fournisseur.compte_comptable_id,
        totalHT,
        totalTVA,
        totalTTC,
        montantPending: totalPending,
        ecartPrix
      });

      if (ecriture) {
        await db.execute(sql`
          UPDATE factures_achat SET ecriture_comptable_id = ${ecriture.id} WHERE id = ${newFacture.id}
        `);
      }
    } catch (comptaError) {
      console.warn('Avertissement: Écriture comptable non générée:', comptaError.message);
    }

    res.status(201).json({
      success: true,
      message: 'Facture créée avec rapprochement réussi',
      data: {
        ...newFacture,
        totalArticles: totalArticlesHT,
        totalLogistique,
        receptionsRapprochees: receptionsIds.length
      }
    });
  } catch (error) {
    console.error('Erreur création facture avec rapprochement:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Helper: Sanitize date (remove query string artifacts)
function sanitizeDate(dateStr) {
  if (!dateStr) return null;
  const cleaned = dateStr.split('?')[0].trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return null;
  return cleaned;
}

// GET /api/achats/ecarts-costing - Rapport des écarts de costing
router.get('/ecarts-costing', async (req, res) => {
  try {
    const dateDebut = sanitizeDate(req.query.dateDebut);
    const dateFin = sanitizeDate(req.query.dateFin);
    const fournisseurId = req.query.fournisseurId ? parseInt(req.query.fournisseurId, 10) : null;
    const entrepriseId = parseInt(req.entrepriseId, 10);
    
    // Stock écarts - requête sécurisée avec sql template literals
    let stockQuery = sql`
      SELECT sp.*, p.nom as produit_nom, p.reference as produit_reference, f.raison_sociale as fournisseur_nom
      FROM stock_pending sp
      LEFT JOIN produits p ON sp.produit_id = p.id
      LEFT JOIN fournisseurs f ON sp.fournisseur_id = f.id
      WHERE sp.entreprise_id = ${entrepriseId} 
        AND sp.statut = 'invoiced' 
        AND sp.ecart_prix IS NOT NULL 
        AND sp.ecart_prix != 0
    `;
    
    if (fournisseurId && !isNaN(fournisseurId)) {
      stockQuery = sql`${stockQuery} AND sp.fournisseur_id = ${fournisseurId}`;
    }
    if (dateDebut) {
      stockQuery = sql`${stockQuery} AND sp.date_facturation >= ${dateDebut}`;
    }
    if (dateFin) {
      stockQuery = sql`${stockQuery} AND sp.date_facturation <= ${dateFin}`;
    }
    
    stockQuery = sql`${stockQuery} ORDER BY ABS(sp.ecart_prix) DESC`;

    const stockEcarts = await db.execute(stockQuery);

    // Logistique écarts - requête sécurisée avec sql template literals
    let logQuery = sql`
      SELECT lp.*, f.raison_sociale as fournisseur_nom
      FROM logistique_pending lp
      LEFT JOIN fournisseurs f ON lp.fournisseur_id = f.id
      WHERE lp.entreprise_id = ${entrepriseId} 
        AND lp.statut = 'invoiced' 
        AND lp.ecart_montant IS NOT NULL 
        AND lp.ecart_montant != 0
    `;
    
    if (fournisseurId && !isNaN(fournisseurId)) {
      logQuery = sql`${logQuery} AND lp.fournisseur_id = ${fournisseurId}`;
    }
    if (dateDebut) {
      logQuery = sql`${logQuery} AND lp.date_facturation >= ${dateDebut}`;
    }
    if (dateFin) {
      logQuery = sql`${logQuery} AND lp.date_facturation <= ${dateFin}`;
    }
    
    logQuery = sql`${logQuery} ORDER BY ABS(lp.ecart_montant) DESC`;

    const logEcarts = await db.execute(logQuery);

    const totalEcartStock = (stockEcarts.rows || []).reduce((sum, r) => sum + parseFloat(r.ecart_prix || 0), 0);
    const totalEcartLogistique = (logEcarts.rows || []).reduce((sum, r) => sum + parseFloat(r.ecart_montant || 0), 0);

    res.json({
      success: true,
      data: {
        ecartsStock: stockEcarts.rows || [],
        ecartsLogistique: logEcarts.rows || [],
        totaux: {
          ecartStock: totalEcartStock,
          ecartLogistique: totalEcartLogistique,
          ecartTotal: totalEcartStock + totalEcartLogistique
        }
      }
    });
  } catch (error) {
    console.error('Erreur rapport écarts costing:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
