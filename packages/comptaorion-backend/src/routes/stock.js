import express from 'express';
import { db } from '../db.js';
import { produits, categoriesStock, entrepots, stockParEntrepot, mouvementsStock, alertesStock, inventairesTournants, bonsReception, lignesReception, fournisseurs, ecritures, lignesEcritures, comptesComptables, journaux } from '../schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { logAudit, extractAuditInfo } from '../utils/auditLogger.js';

const router = express.Router();

async function calculerCoutMoyenPondere(produitId, nouvelleQuantite, nouveauPrixUnitaire, entrepriseId) {
  try {
    const produitData = await db.execute(sql`
      SELECT quantite, cout_moyen, prix_achat FROM produits 
      WHERE id = ${produitId} AND entreprise_id = ${entrepriseId}
    `);
    
    if (!produitData.rows || produitData.rows.length === 0) {
      return nouveauPrixUnitaire;
    }
    
    const produit = produitData.rows[0];
    const quantiteActuelle = parseFloat(produit.quantite || 0);
    const coutMoyenActuel = parseFloat(produit.cout_moyen || produit.prix_achat || 0);
    const qteEntree = parseFloat(nouvelleQuantite);
    const prixEntree = parseFloat(nouveauPrixUnitaire);
    
    if (quantiteActuelle <= 0) {
      return prixEntree;
    }
    
    const valeurStockActuel = quantiteActuelle * coutMoyenActuel;
    const valeurEntree = qteEntree * prixEntree;
    const nouvelleQuantiteTotale = quantiteActuelle + qteEntree;
    
    if (nouvelleQuantiteTotale <= 0) {
      return coutMoyenActuel;
    }
    
    const nouveauCMP = (valeurStockActuel + valeurEntree) / nouvelleQuantiteTotale;
    return Math.round(nouveauCMP * 100) / 100;
  } catch (error) {
    console.error('Erreur calcul CMP:', error);
    return nouveauPrixUnitaire;
  }
}

async function mettreAJourCoutMoyen(produitId, coutMoyen, entrepriseId) {
  try {
    await db.execute(sql`
      UPDATE produits 
      SET cout_moyen = ${coutMoyen}, 
          derniere_maj_cout = NOW(),
          updated_at = NOW()
      WHERE id = ${produitId} AND entreprise_id = ${entrepriseId}
    `);
  } catch (error) {
    console.error('Erreur mise à jour CMP:', error);
  }
}

// CRUD Catégories
router.get('/categories', async (req, res) => {
  try {
    const categories = await db.query.categoriesStock.findMany({
      where: eq(categoriesStock.entrepriseId, req.entrepriseId)
    });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/categories', async (req, res) => {
  try {
    const { nom, description, codeCategorie, compteVentesId, compteAchatsId, compteStockId } = req.body;
    
    // Valider que les comptes comptables appartiennent à la même entreprise
    const comptesIds = [compteVentesId, compteAchatsId, compteStockId].filter(Boolean).map(id => parseInt(id));
    if (comptesIds.length > 0) {
      const comptesValides = await db.query.comptesComptables.findMany({
        where: and(
          eq(comptesComptables.entrepriseId, req.entrepriseId),
          sql`${comptesComptables.id} IN (${sql.join(comptesIds.map(id => sql`${id}`), sql`, `)})`
        )
      });
      if (comptesValides.length !== comptesIds.length) {
        return res.status(400).json({ error: 'Comptes comptables invalides ou appartenant à une autre entreprise' });
      }
    }
    
    const result = await db.insert(categoriesStock).values({
      entrepriseId: req.entrepriseId,
      nom,
      description,
      codeCategorie,
      compteVentesId: compteVentesId ? parseInt(compteVentesId) : null,
      compteAchatsId: compteAchatsId ? parseInt(compteAchatsId) : null,
      compteStockId: compteStockId ? parseInt(compteStockId) : null
    }).returning();

    // Audit log
    const auditInfo = extractAuditInfo(req);
    await logAudit({
      ...auditInfo,
      action: 'CREATE',
      table: 'categories_stock',
      recordId: result[0].id,
      nouvelleValeur: result[0],
      description: `Catégorie stock créée: ${nom}`
    });

    res.json(result[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/categories/:id', async (req, res) => {
  try {
    const { nom, description, codeCategorie, compteVentesId, compteAchatsId, compteStockId } = req.body;
    
    // Valider que les comptes comptables appartiennent à la même entreprise
    const comptesIds = [compteVentesId, compteAchatsId, compteStockId].filter(Boolean).map(id => parseInt(id));
    if (comptesIds.length > 0) {
      const comptesValides = await db.query.comptesComptables.findMany({
        where: and(
          eq(comptesComptables.entrepriseId, req.entrepriseId),
          sql`${comptesComptables.id} IN (${sql.join(comptesIds.map(id => sql`${id}`), sql`, `)})`
        )
      });
      if (comptesValides.length !== comptesIds.length) {
        return res.status(400).json({ error: 'Comptes comptables invalides ou appartenant à une autre entreprise' });
      }
    }
    
    const result = await db.update(categoriesStock)
      .set({ 
        nom, 
        description, 
        codeCategorie,
        compteVentesId: compteVentesId ? parseInt(compteVentesId) : null,
        compteAchatsId: compteAchatsId ? parseInt(compteAchatsId) : null,
        compteStockId: compteStockId ? parseInt(compteStockId) : null
      })
      .where(and(
        eq(categoriesStock.id, parseInt(req.params.id)),
        eq(categoriesStock.entrepriseId, req.entrepriseId)
      ))
      .returning();

    // Audit log
    const auditInfo = extractAuditInfo(req);
    await logAudit({
      ...auditInfo,
      action: 'UPDATE',
      table: 'categories_stock',
      recordId: parseInt(req.params.id),
      nouvelleValeur: result[0],
      description: `Catégorie stock modifiée: ${nom}`
    });

    res.json(result[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/categories/:id', async (req, res) => {
  try {
    // Audit log avant suppression
    const auditInfo = extractAuditInfo(req);
    await logAudit({
      ...auditInfo,
      action: 'DELETE',
      table: 'categories_stock',
      recordId: parseInt(req.params.id),
      description: `Catégorie stock supprimée ID: ${req.params.id}`
    });

    await db.delete(categoriesStock)
      .where(and(
        eq(categoriesStock.id, parseInt(req.params.id)),
        eq(categoriesStock.entrepriseId, req.entrepriseId)
      ));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CRUD Produits
router.get('/produits', async (req, res) => {
  try {
    const { entrepriseId } = req.query;
    const produitsList = await db.query.produits.findMany({
      where: eq(produits.entrepriseId, parseInt(entrepriseId))
    });
    res.json(produitsList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/produits', async (req, res) => {
  try {
    const { entrepriseId, reference, nom, categoriId, prixAchat, prixVente, valorisationMethod } = req.body;
    const result = await db.insert(produits).values({
      entrepriseId: parseInt(entrepriseId),
      reference,
      nom,
      categoriId: categoriId ? parseInt(categoriId) : null,
      prixAchat: parseFloat(prixAchat) || 0,
      prixVente: parseFloat(prixVente) || 0,
      valorisationMethod: valorisationMethod || 'FIFO'
    }).returning();

    // Audit log
    const auditInfo = extractAuditInfo(req);
    await logAudit({
      ...auditInfo,
      action: 'CREATE',
      table: 'produits',
      recordId: result[0].id,
      nouvelleValeur: result[0],
      description: `Produit créé: ${nom} (${reference})`
    });

    res.json(result[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CRUD Entrepôts
router.get('/entrepots', async (req, res) => {
  try {
    const entrepotsList = await db.query.entrepots.findMany({
      where: eq(entrepots.entrepriseId, req.entrepriseId)
    });
    res.json(entrepotsList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/entrepots', async (req, res) => {
  try {
    const { nom, adresse, responsable } = req.body;
    const result = await db.insert(entrepots).values({
      entrepriseId: req.entrepriseId,
      nom,
      adresse,
      responsable
    }).returning();

    // Audit log
    const auditInfo = extractAuditInfo(req);
    await logAudit({
      ...auditInfo,
      action: 'CREATE',
      table: 'entrepots',
      recordId: result[0].id,
      nouvelleValeur: result[0],
      description: `Entrepôt créé: ${nom}`
    });

    res.json(result[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/entrepots/:id', async (req, res) => {
  try {
    const { nom, adresse, responsable } = req.body;
    const result = await db.update(entrepots)
      .set({ nom, adresse, responsable, updatedAt: new Date() })
      .where(and(
        eq(entrepots.id, parseInt(req.params.id)),
        eq(entrepots.entrepriseId, req.entrepriseId)
      ))
      .returning();

    // Audit log
    const auditInfo = extractAuditInfo(req);
    await logAudit({
      ...auditInfo,
      action: 'UPDATE',
      table: 'entrepots',
      recordId: parseInt(req.params.id),
      nouvelleValeur: result[0],
      description: `Entrepôt modifié: ${nom}`
    });

    res.json(result[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/entrepots/:id', async (req, res) => {
  try {
    // Audit log avant suppression
    const auditInfo = extractAuditInfo(req);
    await logAudit({
      ...auditInfo,
      action: 'DELETE',
      table: 'entrepots',
      recordId: parseInt(req.params.id),
      description: `Entrepôt supprimé ID: ${req.params.id}`
    });

    await db.delete(entrepots)
      .where(and(
        eq(entrepots.id, parseInt(req.params.id)),
        eq(entrepots.entrepriseId, req.entrepriseId)
      ));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mouvements de stock
router.get('/mouvements', async (req, res) => {
  try {
    const mouvementsList = await db.select().from(mouvementsStock)
      .where(eq(mouvementsStock.entrepriseId, req.entrepriseId))
      .orderBy(mouvementsStock.createdAt);
    res.json(mouvementsList);
  } catch (error) {
    // Table mouvements_stock pas encore créée - retourner vide temporairement
    console.log('Erreur mouvements_stock:', error.message);
    res.json([]);
  }
});

router.post('/mouvements', async (req, res) => {
  try {
    const { entrepriseId, produitId, entrepotId, type, quantite, prixUnitaire, reference } = req.body;
    
    // Validation: entrepôt obligatoire
    if (!entrepotId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Un entrepôt est obligatoire pour tout mouvement de stock' 
      });
    }
    
    const entId = parseInt(entrepriseId) || req.entrepriseId;
    const prodId = parseInt(produitId);
    const qte = parseFloat(quantite);
    const prix = prixUnitaire ? parseFloat(prixUnitaire) : null;
    
    if (type === 'entree' && prix) {
      const nouveauCMP = await calculerCoutMoyenPondere(prodId, qte, prix, entId);
      await mettreAJourCoutMoyen(prodId, nouveauCMP, entId);
    }
    
    // Insérer le mouvement
    const movement = await db.insert(mouvementsStock).values({
      entrepriseId: entId,
      produitId: prodId,
      entrepotId: entrepotId ? parseInt(entrepotId) : null,
      type,
      quantite: qte,
      prixUnitaire: prix,
      reference
    }).returning();

    // Mettre à jour le stock par entrepôt
    if (entrepotId && type !== 'transfert') {
      const currentStock = await db.query.stockParEntrepot.findFirst({
        where: and(
          eq(stockParEntrepot.produitId, parseInt(produitId)),
          eq(stockParEntrepot.entrepotId, parseInt(entrepotId))
        )
      });

      const quantityChange = type === 'entree' ? parseFloat(quantite) : -parseFloat(quantite);
      
      if (currentStock) {
        await db.update(stockParEntrepot).set({
          quantitePresente: currentStock.quantitePresente + quantityChange,
          quantiteDisponible: currentStock.quantiteDisponible + quantityChange,
          updatedAt: new Date()
        }).where(eq(stockParEntrepot.id, currentStock.id));
      } else {
        await db.insert(stockParEntrepot).values({
          entrepriseId: parseInt(entrepriseId),
          produitId: parseInt(produitId),
          entrepotId: parseInt(entrepotId),
          quantitePresente: type === 'entree' ? parseFloat(quantite) : 0,
          quantiteDisponible: type === 'entree' ? parseFloat(quantite) : 0
        });
      }

      // Vérifier alertes
      await checkStockAlerts(parseInt(entrepriseId), parseInt(produitId), parseInt(entrepotId));
    }

    // Audit log
    const auditInfo = extractAuditInfo(req);
    await logAudit({
      ...auditInfo,
      action: 'CREATE',
      table: 'mouvements_stock',
      recordId: movement[0].id,
      nouvelleValeur: movement[0],
      description: `Mouvement stock ${type}: ${quantite} unités (ref: ${reference || 'N/A'})`
    });

    res.json(movement[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Suivi temps réel
router.get('/suivi/:produitId', async (req, res) => {
  try {
    const { produitId } = req.params;
    const { entrepriseId } = req.query;
    
    const stock = await db.query.stockParEntrepot.findMany({
      where: and(
        eq(stockParEntrepot.produitId, parseInt(produitId)),
        eq(stockParEntrepot.entrepriseId, parseInt(entrepriseId))
      )
    });
    
    res.json(stock);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Alertes
router.get('/alertes', async (req, res) => {
  try {
    const { entrepriseId } = req.query;
    const alerts = await db.query.alertesStock.findMany({
      where: and(
        eq(alertesStock.entrepriseId, parseInt(entrepriseId)),
        eq(alertesStock.statut, 'active')
      )
    });
    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fonction pour vérifier les alertes
async function checkStockAlerts(entrepriseId, produitId, entrepotId) {
  try {
    const stock = await db.query.stockParEntrepot.findFirst({
      where: and(
        eq(stockParEntrepot.produitId, produitId),
        eq(stockParEntrepot.entrepotId, entrepotId)
      )
    });

    const produit = await db.query.produits.findFirst({
      where: eq(produits.id, produitId)
    });

    if (stock && produit && stock.quantiteDisponible < produit.stockMinimum) {
      await db.insert(alertesStock).values({
        entrepriseId,
        produitId,
        entrepotId,
        type: 'seuil_min',
        quantiteActuelle: stock.quantiteDisponible,
        seuil: produit.stockMinimum,
        statut: 'active'
      });
    }
  } catch (error) {
    console.error('Erreur vérification alertes:', error);
  }
}

// ==========================================
// BONS DE RÉCEPTION
// ==========================================

// Liste des bons de réception
router.get('/receptions', async (req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT br.*, 
             f.nom as fournisseur_nom,
             e.nom as entrepot_nom,
             (SELECT COUNT(*) FROM lignes_reception WHERE bon_reception_id = br.id) as nb_lignes
      FROM bons_reception br
      LEFT JOIN fournisseurs f ON br.fournisseur_id = f.id
      LEFT JOIN entrepots e ON br.entrepot_id = e.id
      WHERE br.entreprise_id = ${req.entrepriseId}
      ORDER BY br.date_reception DESC, br.id DESC
    `);
    res.json(result.rows || result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Détail d'un bon de réception
router.get('/receptions/:id', async (req, res) => {
  try {
    const bonResult = await db.execute(sql`
      SELECT br.*, 
             f.nom as fournisseur_nom,
             e.nom as entrepot_nom
      FROM bons_reception br
      LEFT JOIN fournisseurs f ON br.fournisseur_id = f.id
      LEFT JOIN entrepots e ON br.entrepot_id = e.id
      WHERE br.id = ${parseInt(req.params.id)} AND br.entreprise_id = ${req.entrepriseId}
    `);
    
    if (!bonResult.rows?.length) {
      return res.status(404).json({ error: 'Bon de réception non trouvé' });
    }

    const lignesResult = await db.execute(sql`
      SELECT lr.*, p.nom as produit_nom, p.reference as produit_reference
      FROM lignes_reception lr
      LEFT JOIN produits p ON lr.produit_id = p.id
      WHERE lr.bon_reception_id = ${parseInt(req.params.id)}
    `);

    res.json({
      ...bonResult.rows[0],
      lignes: lignesResult.rows || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Générer un numéro de bon de réception
async function generateReceptionNumber(entrepriseId) {
  const result = await db.execute(sql`
    SELECT COUNT(*) + 1 as next_num FROM bons_reception WHERE entreprise_id = ${entrepriseId}
  `);
  const nextNum = result.rows?.[0]?.next_num || 1;
  return `BR-${new Date().getFullYear()}-${String(nextNum).padStart(5, '0')}`;
}

// Créer un bon de réception (brouillon)
router.post('/receptions', async (req, res) => {
  try {
    const { fournisseurId, dateReception, entrepotId, notes, lignes } = req.body;

    if (!fournisseurId || !dateReception || !lignes?.length) {
      return res.status(400).json({ error: 'Fournisseur, date et au moins une ligne requis' });
    }

    if (!entrepotId) {
      return res.status(400).json({ error: 'Un entrepôt est obligatoire pour réceptionner du stock. Créez-en un dans Paramètres → Entrepôts.' });
    }

    const numero = await generateReceptionNumber(req.entrepriseId);
    
    // Calculer total HT
    const totalHT = lignes.reduce((sum, l) => sum + (parseFloat(l.quantiteRecue) * parseFloat(l.prixUnitaireEstime)), 0);

    // Créer l'en-tête
    const bonResult = await db.execute(sql`
      INSERT INTO bons_reception (entreprise_id, numero, fournisseur_id, date_reception, entrepot_id, notes, total_ht, user_id, statut)
      VALUES (${req.entrepriseId}, ${numero}, ${fournisseurId}, ${dateReception}, ${entrepotId || null}, ${notes || null}, ${totalHT}, ${req.userId}, 'brouillon')
      RETURNING *
    `);
    
    const bonId = bonResult.rows[0].id;

    // Créer les lignes
    for (const ligne of lignes) {
      await db.execute(sql`
        INSERT INTO lignes_reception (entreprise_id, bon_reception_id, produit_id, quantite_commandee, quantite_recue, prix_unitaire_estime)
        VALUES (${req.entrepriseId}, ${bonId}, ${ligne.produitId}, ${ligne.quantiteCommandee || 0}, ${ligne.quantiteRecue}, ${ligne.prixUnitaireEstime})
      `);
    }

    // Audit
    const auditInfo = extractAuditInfo(req);
    await logAudit({
      ...auditInfo,
      action: 'CREATE',
      table: 'bons_reception',
      recordId: bonId,
      nouvelleValeur: { numero, fournisseurId, dateReception, totalHT },
      description: `Bon de réception créé: ${numero}`
    });

    res.json({ id: bonId, numero, message: 'Bon de réception créé' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Valider un bon de réception (génère écriture comptable + mouvement stock)
router.post('/receptions/:id/valider', async (req, res) => {
  try {
    const bonId = parseInt(req.params.id);

    // Récupérer le bon et ses lignes
    const bonResult = await db.execute(sql`
      SELECT * FROM bons_reception WHERE id = ${bonId} AND entreprise_id = ${req.entrepriseId}
    `);
    
    if (!bonResult.rows?.length) {
      return res.status(404).json({ error: 'Bon de réception non trouvé' });
    }

    const bon = bonResult.rows[0];
    
    if (bon.statut !== 'brouillon') {
      return res.status(400).json({ error: 'Ce bon ne peut plus être validé' });
    }

    const lignesResult = await db.execute(sql`
      SELECT lr.*, p.nom as produit_nom, p.prix_achat
      FROM lignes_reception lr
      LEFT JOIN produits p ON lr.produit_id = p.id
      WHERE lr.bon_reception_id = ${bonId}
    `);
    
    const lignes = lignesResult.rows || [];
    
    if (!lignes.length) {
      return res.status(400).json({ error: 'Aucune ligne dans ce bon de réception' });
    }

    // 1. Créer les mouvements de stock pour chaque ligne
    for (const ligne of lignes) {
      // Mouvement d'entrée
      const mvtResult = await db.execute(sql`
        INSERT INTO mouvements_stock (entreprise_id, produit_id, type, quantite, prix_unitaire, reference, notes, user_id)
        VALUES (${req.entrepriseId}, ${ligne.produit_id}, 'entree', ${ligne.quantite_recue}, ${ligne.prix_unitaire_estime}, ${bon.numero}, ${'Réception: ' + bon.numero}, ${req.userId})
        RETURNING id
      `);
      
      // Mettre à jour la ligne avec l'ID du mouvement
      await db.execute(sql`
        UPDATE lignes_reception SET mouvement_stock_id = ${mvtResult.rows[0].id} WHERE id = ${ligne.id}
      `);

      // Mettre à jour le stock par entrepôt si entrepôt défini
      if (bon.entrepot_id) {
        await db.execute(sql`
          INSERT INTO stock_par_entrepot (entreprise_id, produit_id, entrepot_id, quantite_presente, quantite_disponible)
          VALUES (${req.entrepriseId}, ${ligne.produit_id}, ${bon.entrepot_id}, ${ligne.quantite_recue}, ${ligne.quantite_recue})
          ON CONFLICT (produit_id, entrepot_id) DO UPDATE 
          SET quantite_presente = stock_par_entrepot.quantite_presente + ${ligne.quantite_recue},
              quantite_disponible = stock_par_entrepot.quantite_disponible + ${ligne.quantite_recue},
              updated_at = NOW()
        `);
      }
    }

    // 2. Créer l'écriture comptable (Stock au Débit / Stock non facturé au Crédit)
    // Trouver le journal des achats
    const journalResult = await db.execute(sql`
      SELECT id FROM journaux WHERE entreprise_id = ${req.entrepriseId} AND type = 'achats' LIMIT 1
    `);
    
    let journalId = journalResult.rows?.[0]?.id;
    
    // Créer un journal achats si n'existe pas
    if (!journalId) {
      const newJournal = await db.execute(sql`
        INSERT INTO journaux (entreprise_id, code, nom, type) VALUES (${req.entrepriseId}, 'AC', 'Journal des Achats', 'achats') RETURNING id
      `);
      journalId = newJournal.rows[0].id;
    }

    // Trouver les comptes comptables (31x Stock marchandises et 408 Fournisseurs factures non parvenues)
    const compteStockResult = await db.execute(sql`
      SELECT id FROM comptes_comptables WHERE entreprise_id = ${req.entrepriseId} AND numero LIKE '31%' LIMIT 1
    `);
    
    const comptePontResult = await db.execute(sql`
      SELECT id FROM comptes_comptables WHERE entreprise_id = ${req.entrepriseId} AND numero LIKE '408%' LIMIT 1
    `);

    let compteStockId = compteStockResult.rows?.[0]?.id;
    let comptePontId = comptePontResult.rows?.[0]?.id;

    // Créer les comptes s'ils n'existent pas
    if (!compteStockId) {
      const newCompte = await db.execute(sql`
        INSERT INTO comptes_comptables (entreprise_id, numero, intitule, classe, type) 
        VALUES (${req.entrepriseId}, '311', 'Stock de marchandises', '3', 'actif') RETURNING id
      `);
      compteStockId = newCompte.rows[0].id;
    }
    
    if (!comptePontId) {
      const newCompte = await db.execute(sql`
        INSERT INTO comptes_comptables (entreprise_id, numero, intitule, classe, type) 
        VALUES (${req.entrepriseId}, '408', 'Fournisseurs - Factures non parvenues', '4', 'passif') RETURNING id
      `);
      comptePontId = newCompte.rows[0].id;
    }

    // Générer numéro d'écriture
    const ecritureNumResult = await db.execute(sql`
      SELECT COALESCE(MAX(CAST(SUBSTRING(numero_piece FROM '[0-9]+') AS INTEGER)), 0) + 1 as next_num
      FROM ecritures WHERE entreprise_id = ${req.entrepriseId}
    `);
    const nextNum = ecritureNumResult.rows?.[0]?.next_num || 1;
    const numeroPiece = `EC-${new Date().getFullYear()}-${String(nextNum).padStart(5, '0')}`;

    // Créer l'écriture comptable
    const ecritureResult = await db.execute(sql`
      INSERT INTO ecritures (entreprise_id, journal_id, numero_piece, date_ecriture, libelle, statut)
      VALUES (${req.entrepriseId}, ${journalId}, ${numeroPiece}, ${bon.date_reception}, ${'Réception marchandises ' + bon.numero}, 'brouillon')
      RETURNING id
    `);
    
    const ecritureId = ecritureResult.rows[0].id;

    // Ligne débit Stock
    await db.execute(sql`
      INSERT INTO lignes_ecriture (entreprise_id, ecriture_id, compte_comptable_id, libelle, debit, credit)
      VALUES (${req.entrepriseId}, ${ecritureId}, ${compteStockId}, ${'Entrée stock ' + bon.numero}, ${bon.total_ht}, 0)
    `);

    // Ligne crédit Fournisseurs factures non parvenues
    await db.execute(sql`
      INSERT INTO lignes_ecriture (entreprise_id, ecriture_id, compte_comptable_id, libelle, debit, credit)
      VALUES (${req.entrepriseId}, ${ecritureId}, ${comptePontId}, ${'Stock non facturé ' + bon.numero}, 0, ${bon.total_ht})
    `);

    // 4. Créer les enregistrements stock_pending pour chaque ligne
    for (const ligne of lignes) {
      const valeurEstimee = parseFloat(ligne.quantite_recue) * parseFloat(ligne.prix_unitaire_estime || 0);
      await db.execute(sql`
        INSERT INTO stock_pending (entreprise_id, bon_reception_id, ligne_reception_id, produit_id, fournisseur_id, quantite_pending, prix_estime, valeur_estimee, date_reception, entrepot_id, statut)
        VALUES (${req.entrepriseId}, ${bonId}, ${ligne.id}, ${ligne.produit_id}, ${bon.fournisseur_id}, ${ligne.quantite_recue}, ${ligne.prix_unitaire_estime || 0}, ${valeurEstimee}, ${bon.date_reception}, ${bon.entrepot_id}, 'pending')
      `);
    }

    // 5. Créer les enregistrements logistique_pending si commande d'achat associée
    if (bon.commande_achat_id) {
      const coutsResult = await db.execute(sql`
        SELECT * FROM couts_logistiques_commande WHERE commande_achat_id = ${bon.commande_achat_id}
      `);
      
      const coutsLogistiques = coutsResult.rows || [];
      for (const cout of coutsLogistiques) {
        await db.execute(sql`
          INSERT INTO logistique_pending (entreprise_id, bon_reception_id, commande_achat_id, fournisseur_id, type, description, montant_estime, date_reception, statut)
          VALUES (${req.entrepriseId}, ${bonId}, ${bon.commande_achat_id}, ${bon.fournisseur_id}, ${cout.type}, ${cout.description}, ${cout.montant}, ${bon.date_reception}, 'pending')
        `);
      }
    }

    // 6. Mettre à jour le bon de réception
    await db.execute(sql`
      UPDATE bons_reception 
      SET statut = 'validee', ecriture_stock_id = ${ecritureId}, updated_at = NOW()
      WHERE id = ${bonId}
    `);

    // Audit
    const auditInfo = extractAuditInfo(req);
    await logAudit({
      ...auditInfo,
      action: 'UPDATE',
      table: 'bons_reception',
      recordId: bonId,
      nouvelleValeur: { statut: 'validee', ecritureId },
      description: `Bon de réception validé: ${bon.numero}`
    });

    res.json({ 
      message: 'Bon de réception validé avec succès',
      ecritureId,
      details: {
        stockMouvements: lignes.length,
        ecritureComptable: numeroPiece,
        totalHT: bon.total_ht
      }
    });
  } catch (error) {
    console.error('Erreur validation réception:', error);
    res.status(500).json({ error: error.message });
  }
});

// Supprimer un bon de réception (uniquement brouillon)
router.delete('/receptions/:id', async (req, res) => {
  try {
    const bonId = parseInt(req.params.id);
    
    const bonResult = await db.execute(sql`
      SELECT * FROM bons_reception WHERE id = ${bonId} AND entreprise_id = ${req.entrepriseId}
    `);
    
    if (!bonResult.rows?.length) {
      return res.status(404).json({ error: 'Bon de réception non trouvé' });
    }
    
    if (bonResult.rows[0].statut !== 'brouillon') {
      return res.status(400).json({ error: 'Seuls les bons en brouillon peuvent être supprimés' });
    }

    // Supprimer les lignes puis le bon
    await db.execute(sql`DELETE FROM lignes_reception WHERE bon_reception_id = ${bonId}`);
    await db.execute(sql`DELETE FROM bons_reception WHERE id = ${bonId}`);

    res.json({ message: 'Bon de réception supprimé' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Réceptions en attente de facturation
router.get('/receptions/en-attente-facturation', async (req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT br.*, f.nom as fournisseur_nom
      FROM bons_reception br
      LEFT JOIN fournisseurs f ON br.fournisseur_id = f.id
      WHERE br.entreprise_id = ${req.entrepriseId} 
        AND br.statut = 'validee' 
        AND br.facture_achat_id IS NULL
      ORDER BY br.date_reception ASC
    `);
    res.json(result.rows || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// RAPPORTS D'INVENTAIRE
// ==========================================

// Rapport état des stocks
router.get('/rapports/etat-stocks', async (req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT 
        p.id, p.reference, p.nom, p.unite_mesure, p.prix_achat, p.prix_vente,
        COALESCE(SUM(spe.quantite_presente), 0) as quantite_totale,
        COALESCE(SUM(spe.quantite_disponible), 0) as quantite_disponible,
        COALESCE(SUM(spe.quantite_reservee), 0) as quantite_reservee,
        COALESCE(SUM(spe.quantite_presente), 0) * COALESCE(p.prix_achat, 0) as valeur_stock,
        c.nom as categorie_nom
      FROM produits p
      LEFT JOIN stock_par_entrepot spe ON p.id = spe.produit_id
      LEFT JOIN categories_stock c ON p.categorie_id = c.id
      WHERE p.entreprise_id = ${req.entrepriseId} AND p.actif = true
      GROUP BY p.id, p.reference, p.nom, p.unite_mesure, p.prix_achat, p.prix_vente, c.nom
      ORDER BY p.nom
    `);
    
    const produits = result.rows || [];
    const totalValeur = produits.reduce((sum, p) => sum + parseFloat(p.valeur_stock || 0), 0);
    
    res.json({ produits, totalValeur });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rapport valorisation des stocks
router.get('/rapports/valorisation', async (req, res) => {
  try {
    const { methode = 'CMP' } = req.query;
    
    const result = await db.execute(sql`
      SELECT 
        p.id, p.reference, p.nom, p.valorisation_method,
        COALESCE(SUM(spe.quantite_presente), 0) as quantite,
        CASE 
          WHEN p.valorisation_method = 'FIFO' THEN (
            SELECT COALESCE(AVG(cout_unitaire), p.prix_achat) 
            FROM valorisations_stock vs 
            WHERE vs.produit_id = p.id
          )
          ELSE COALESCE(p.prix_achat, 0)
        END as cout_unitaire,
        CASE 
          WHEN p.valorisation_method = 'FIFO' THEN (
            SELECT COALESCE(SUM(cout_total), 0) 
            FROM valorisations_stock vs 
            WHERE vs.produit_id = p.id
          )
          ELSE COALESCE(SUM(spe.quantite_presente), 0) * COALESCE(p.prix_achat, 0)
        END as valeur_totale
      FROM produits p
      LEFT JOIN stock_par_entrepot spe ON p.id = spe.produit_id
      WHERE p.entreprise_id = ${req.entrepriseId} AND p.actif = true
      GROUP BY p.id, p.reference, p.nom, p.valorisation_method, p.prix_achat
      HAVING COALESCE(SUM(spe.quantite_presente), 0) > 0
      ORDER BY p.nom
    `);
    
    const produits = result.rows || [];
    const totalValorisation = produits.reduce((sum, p) => sum + parseFloat(p.valeur_totale || 0), 0);
    
    res.json({ produits, totalValorisation, methode });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper: Sanitize date (remove query string artifacts)
function sanitizeDate(dateStr) {
  if (!dateStr) return null;
  const cleaned = dateStr.split('?')[0].trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return null;
  return cleaned;
}

// Helper: Sanitize integer ID
function sanitizeInt(val) {
  if (!val) return null;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? null : parsed;
}

// Rapport mouvements de stock
router.get('/rapports/mouvements', async (req, res) => {
  try {
    const dateDebut = sanitizeDate(req.query.dateDebut);
    const dateFin = sanitizeDate(req.query.dateFin);
    const produitId = sanitizeInt(req.query.produitId);
    const type = req.query.type ? req.query.type.split('?')[0].trim() : null;
    const entrepriseId = sanitizeInt(req.entrepriseId);
    
    // Construire la requête avec sql template literals (sécurisé)
    let query = sql`
      SELECT ms.*, p.nom as produit_nom, p.reference as produit_reference,
             u.nom as user_nom, u.prenom as user_prenom
      FROM mouvements_stock ms
      LEFT JOIN produits p ON ms.produit_id = p.id
      LEFT JOIN users u ON ms.user_id = u.id
      WHERE ms.entreprise_id = ${entrepriseId}
    `;
    
    if (dateDebut) {
      query = sql`${query} AND ms.created_at >= ${dateDebut}`;
    }
    if (dateFin) {
      query = sql`${query} AND ms.created_at <= ${dateFin}::date + interval '1 day'`;
    }
    if (produitId) {
      query = sql`${query} AND ms.produit_id = ${produitId}`;
    }
    if (type) {
      query = sql`${query} AND ms.type = ${type}`;
    }
    
    query = sql`${query} ORDER BY ms.created_at DESC LIMIT 500`;
    
    const result = await db.execute(query);
    
    res.json(result.rows || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// RAPPORTS STOCK NON FACTURÉ & COÛTS LOGISTIQUES
// ==========================================

// Rapport stock non facturé (pending)
router.get('/rapports/stock-non-facture', async (req, res) => {
  try {
    const fournisseurId = sanitizeInt(req.query.fournisseurId);
    const produitId = sanitizeInt(req.query.produitId);
    const dateDebut = sanitizeDate(req.query.dateDebut);
    const dateFin = sanitizeDate(req.query.dateFin);
    const entrepriseId = sanitizeInt(req.entrepriseId);
    
    // Construire la requête avec sql template literals (sécurisé)
    let query = sql`
      SELECT 
        sp.*,
        p.reference as produit_reference, p.nom as produit_nom,
        f.raison_sociale as fournisseur_nom,
        br.numero as reception_numero,
        br.commande_achat_id,
        ca.numero_commande as commande_numero,
        e.nom as entrepot_nom
      FROM stock_pending sp
      LEFT JOIN produits p ON sp.produit_id = p.id
      LEFT JOIN fournisseurs f ON sp.fournisseur_id = f.id
      LEFT JOIN bons_reception br ON sp.bon_reception_id = br.id
      LEFT JOIN commandes_achat ca ON br.commande_achat_id = ca.id
      LEFT JOIN entrepots e ON sp.entrepot_id = e.id
      WHERE sp.entreprise_id = ${entrepriseId} AND sp.statut = 'pending'
    `;
    
    if (fournisseurId) {
      query = sql`${query} AND sp.fournisseur_id = ${fournisseurId}`;
    }
    if (produitId) {
      query = sql`${query} AND sp.produit_id = ${produitId}`;
    }
    if (dateDebut) {
      query = sql`${query} AND sp.date_reception >= ${dateDebut}`;
    }
    if (dateFin) {
      query = sql`${query} AND sp.date_reception <= ${dateFin}`;
    }
    
    query = sql`${query} ORDER BY sp.date_reception DESC`;
    
    const result = await db.execute(query);
    
    const items = result.rows || [];
    const totalQuantite = items.reduce((sum, i) => sum + parseFloat(i.quantite_pending || 0), 0);
    const totalValeur = items.reduce((sum, i) => sum + parseFloat(i.valeur_estimee || 0), 0);
    
    // Résumé par fournisseur
    const parFournisseur = {};
    for (const item of items) {
      const key = item.fournisseur_id;
      if (!parFournisseur[key]) {
        parFournisseur[key] = { fournisseurId: key, nom: item.fournisseur_nom, quantite: 0, valeur: 0, lignes: 0 };
      }
      parFournisseur[key].quantite += parseFloat(item.quantite_pending || 0);
      parFournisseur[key].valeur += parseFloat(item.valeur_estimee || 0);
      parFournisseur[key].lignes++;
    }
    
    res.json({ 
      items, 
      totaux: { quantite: totalQuantite, valeur: totalValeur, lignes: items.length },
      parFournisseur: Object.values(parFournisseur)
    });
  } catch (error) {
    console.error('Erreur rapport stock non facturé:', error);
    res.status(500).json({ error: error.message });
  }
});

// Rapport coûts logistiques non facturés (pending)
router.get('/rapports/logistique-non-facturee', async (req, res) => {
  try {
    const fournisseurId = sanitizeInt(req.query.fournisseurId);
    const type = req.query.type ? req.query.type.split('?')[0].trim() : null;
    const dateDebut = sanitizeDate(req.query.dateDebut);
    const dateFin = sanitizeDate(req.query.dateFin);
    const entrepriseId = sanitizeInt(req.entrepriseId);
    
    // Construire la requête avec sql template literals (sécurisé)
    let query = sql`
      SELECT 
        lp.*,
        f.raison_sociale as fournisseur_nom,
        br.numero as reception_numero,
        ca.numero_commande as commande_numero
      FROM logistique_pending lp
      LEFT JOIN fournisseurs f ON lp.fournisseur_id = f.id
      LEFT JOIN bons_reception br ON lp.bon_reception_id = br.id
      LEFT JOIN commandes_achat ca ON lp.commande_achat_id = ca.id
      WHERE lp.entreprise_id = ${entrepriseId} AND lp.statut = 'pending'
    `;
    
    if (fournisseurId) {
      query = sql`${query} AND lp.fournisseur_id = ${fournisseurId}`;
    }
    if (type) {
      query = sql`${query} AND lp.type = ${type}`;
    }
    if (dateDebut) {
      query = sql`${query} AND lp.date_reception >= ${dateDebut}`;
    }
    if (dateFin) {
      query = sql`${query} AND lp.date_reception <= ${dateFin}`;
    }
    
    query = sql`${query} ORDER BY lp.date_reception DESC`;
    
    const result = await db.execute(query);
    
    const items = result.rows || [];
    const totalMontant = items.reduce((sum, i) => sum + parseFloat(i.montant_estime || 0), 0);
    
    // Résumé par type
    const parType = {};
    for (const item of items) {
      const key = item.type;
      if (!parType[key]) {
        parType[key] = { type: key, montant: 0, lignes: 0 };
      }
      parType[key].montant += parseFloat(item.montant_estime || 0);
      parType[key].lignes++;
    }
    
    // Résumé par fournisseur
    const parFournisseur = {};
    for (const item of items) {
      const key = item.fournisseur_id;
      if (!parFournisseur[key]) {
        parFournisseur[key] = { fournisseurId: key, nom: item.fournisseur_nom, montant: 0, lignes: 0 };
      }
      parFournisseur[key].montant += parseFloat(item.montant_estime || 0);
      parFournisseur[key].lignes++;
    }
    
    res.json({ 
      items, 
      totaux: { montant: totalMontant, lignes: items.length },
      parType: Object.values(parType),
      parFournisseur: Object.values(parFournisseur)
    });
  } catch (error) {
    console.error('Erreur rapport logistique non facturée:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
