import express from 'express';
import { db } from '../db.js';
import { immobilisations, categoriesImmobilisations, amortissements, cessionsImmobilisations, auditLogs } from '../schema.js';
import { eq, and, gte, lte } from 'drizzle-orm';

const router = express.Router();

// ==========================================
// CRUD CATÉGORIES IMMOBILISATIONS
// ==========================================

router.get('/categories', async (req, res) => {
  try {
    const { entrepriseId } = req.query;
    const categories = await db.query.categoriesImmobilisations.findMany({
      where: eq(categoriesImmobilisations.entrepriseId, parseInt(entrepriseId))
    });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/categories', async (req, res) => {
  try {
    const { entrepriseId, nom, dureeVie, methodeAmortissement, compteAmortissement, compte } = req.body;
    const result = await db.insert(categoriesImmobilisations).values({
      entrepriseId: parseInt(entrepriseId),
      nom,
      dureeVie: parseInt(dureeVie),
      methodeAmortissement, // linéaire ou dégressif
      compteAmortissement,
      compte
    }).returning();
    res.json(result[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// CRUD IMMOBILISATIONS
// ==========================================

router.get('/list', async (req, res) => {
  try {
    const { entrepriseId } = req.query;
    const immobsList = await db.query.immobilisations.findMany({
      where: eq(immobilisations.entrepriseId, parseInt(entrepriseId))
    });
    res.json(immobsList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/create', async (req, res) => {
  try {
    const { entrepriseId, reference, description, categorieId, dateAcquisition, valeurAcquisition, userId, ipAddress } = req.body;
    
    const immo = await db.insert(immobilisations).values({
      entrepriseId: parseInt(entrepriseId),
      reference,
      description,
      categorieId: parseInt(categorieId),
      dateAcquisition: new Date(dateAcquisition),
      valeurAcquisition: parseFloat(valeurAcquisition),
      valeurNetteComptable: parseFloat(valeurAcquisition),
      amortissementCumule: 0,
      statut: 'actif'
    }).returning();

    // Audit
    await db.insert(auditLogs).values({
      entrepriseId: parseInt(entrepriseId),
      userId,
      action: 'CREATE',
      table: 'immobilisations',
      recordId: immo[0].id,
      nouvelleValeur: JSON.stringify(immo[0]),
      description: `Création immobilisation ${reference}`,
      ipAddress
    });

    res.json(immo[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// CALCUL AMORTISSEMENT
// ==========================================

async function calculerAmortissementMensuel(entrepriseId, immobilisationId, mois) {
  try {
    const immo = await db.query.immobilisations.findFirst({
      where: eq(immobilisations.id, immobilisationId)
    });

    if (!immo || immo.statut !== 'actif') return null;

    const categorie = await db.query.categoriesImmobilisations.findFirst({
      where: eq(categoriesImmobilisations.id, immo.categorieId)
    });

    if (!categorie) return null;

    let amortissementMensuel = 0;

    if (categorie.methodeAmortissement === 'linéaire') {
      // Amortissement linéaire : Valeur / Durée de vie en mois
      amortissementMensuel = parseFloat(immo.valeurAcquisition) / (categorie.dureeVie * 12);
    } else if (categorie.methodeAmortissement === 'dégressif') {
      // Amortissement dégressif (1.5x ou 2x selon la durée)
      const tauxDegressif = categorie.dureeVie <= 5 ? 2 : 1.5;
      const tauxLinéaire = 1 / (categorie.dureeVie * 12);
      const valeurRestante = parseFloat(immo.valeurNetteComptable);
      amortissementMensuel = valeurRestante * tauxLinéaire * tauxDegressif;
    }

    return {
      immobilisationId,
      monthDate: new Date(),
      montant: parseFloat(amortissementMensuel).toFixed(2),
      methode: categorie.methodeAmortissement
    };
  } catch (error) {
    console.error('Erreur calcul amortissement:', error);
    return null;
  }
}

router.post('/calculer-amortissements', async (req, res) => {
  try {
    const { entrepriseId } = req.body;
    const eId = parseInt(entrepriseId);

    const immobsList = await db.query.immobilisations.findMany({
      where: and(
        eq(immobilisations.entrepriseId, eId),
        eq(immobilisations.statut, 'actif')
      )
    });

    const resultats = [];
    for (const immo of immobsList) {
      const amort = await calculerAmortissementMensuel(eId, immo.id, new Date());
      if (amort) {
        // Enregistrer l'amortissement
        const result = await db.insert(amortissements).values({
          entrepriseId: eId,
          immobilisationId: immo.id,
          dateAmortissement: new Date(),
          montant: parseFloat(amort.montant)
        }).returning();

        // Mettre à jour l'immobilisation
        const nouvelleVNC = parseFloat(immo.valeurNetteComptable) - parseFloat(amort.montant);
        await db.update(immobilisations).set({
          amortissementCumule: parseFloat(immo.amortissementCumule) + parseFloat(amort.montant),
          valeurNetteComptable: nouvelleVNC
        }).where(eq(immobilisations.id, immo.id));

        resultats.push(result[0]);
      }
    }

    res.json({
      message: `${resultats.length} amortissements calculés et comptabilisés`,
      resultats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// SORTIE / CESSION IMMOBILISATION
// ==========================================

router.post('/cession', async (req, res) => {
  try {
    const { entrepriseId, immobilisationId, dateCession, prixVente, userId, ipAddress } = req.body;

    const immo = await db.query.immobilisations.findFirst({
      where: eq(immobilisations.id, parseInt(immobilisationId))
    });

    if (!immo) {
      return res.status(404).json({ error: 'Immobilisation non trouvée' });
    }

    const gainPerte = parseFloat(prixVente) - parseFloat(immo.valeurNetteComptable);

    // Enregistrer la cession
    const cession = await db.insert(cessionsImmobilisations).values({
      entrepriseId: parseInt(entrepriseId),
      immobilisationId: parseInt(immobilisationId),
      dateCession: new Date(dateCession),
      valeurNetteComptable: immo.valeurNetteComptable,
      prixVente: parseFloat(prixVente),
      gainPerte: gainPerte,
      comptabilisee: false
    }).returning();

    // Mettre à jour le statut
    await db.update(immobilisations).set({
      statut: 'cédée',
      dateCession: new Date(dateCession)
    }).where(eq(immobilisations.id, parseInt(immobilisationId)));

    // Audit
    await db.insert(auditLogs).values({
      entrepriseId: parseInt(entrepriseId),
      userId,
      action: 'UPDATE',
      table: 'immobilisations',
      recordId: parseInt(immobilisationId),
      description: `Cession immobilisation - Gain/Perte: ${gainPerte}`,
      ipAddress
    });

    res.json(cession[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// REGISTRE IMMOBILISATIONS
// ==========================================

router.get('/registre', async (req, res) => {
  try {
    const { entrepriseId } = req.query;
    const eId = parseInt(entrepriseId);

    const registre = await db.query.immobilisations.findMany({
      where: eq(immobilisations.entrepriseId, eId)
    });

    const resultats = registre.map(immo => ({
      reference: immo.reference,
      description: immo.description,
      dateAcquisition: immo.dateAcquisition,
      valeurAcquisition: immo.valeurAcquisition,
      amortissementCumule: immo.amortissementCumule,
      valeurNetteComptable: immo.valeurNetteComptable,
      statut: immo.statut,
      dateCession: immo.dateCession
    }));

    res.json(resultats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
