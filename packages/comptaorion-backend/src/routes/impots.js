import express from 'express';
import { db } from '../db.js';
import { parametresFiscaux, declarationsFiscales, factures, comptesComptables } from '../schema.js';
import { eq, and, sql, gte, lte } from 'drizzle-orm';
import crypto from 'crypto';
import { createEcriturePaiementImpot } from '../services/comptabiliteService.js';

const router = express.Router();

import { lignesEcritures, ecritures } from '../schema.js';

const ENCRYPTION_KEY = process.env.FISCAL_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const getEncryptionKey = () => crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decrypt(text) {
  try {
    const [ivHex, authTagHex, encryptedHex] = text.split(':');
    if (!ivHex || !authTagHex || !encryptedHex) return null;
    const iv = Buffer.from(ivHex, 'hex');
    const encryptedText = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv);
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (error) {
    console.error('Erreur décryptage:', error);
    return null;
  }
}

// API pour récupérer les montants de TVA depuis les écritures comptables
router.get('/tva/resume', async (req, res) => {
  try {
    const { dateDebut, dateFin } = req.query;
    const eId = req.entrepriseId;
    
    // Calculer TVA Collectée (compte 4431) - solde crédit
    const tvaCollecteeData = await db.execute(sql`
      SELECT COALESCE(SUM(le.credit), 0) - COALESCE(SUM(le.debit), 0) as montant
      FROM lignes_ecriture le
      JOIN ecritures e ON le.ecriture_id = e.id
      JOIN comptes_comptables cc ON le.compte_comptable_id = cc.id
      WHERE e.entreprise_id = ${eId}
      AND cc.numero LIKE '4431%'
      ${dateDebut ? sql`AND e.date_ecriture >= ${dateDebut}` : sql``}
      ${dateFin ? sql`AND e.date_ecriture <= ${dateFin}` : sql``}
    `);
    
    // Calculer TVA Déductible (compte 4452) - solde débit
    const tvaDeductibleData = await db.execute(sql`
      SELECT COALESCE(SUM(le.debit), 0) - COALESCE(SUM(le.credit), 0) as montant
      FROM lignes_ecriture le
      JOIN ecritures e ON le.ecriture_id = e.id
      JOIN comptes_comptables cc ON le.compte_comptable_id = cc.id
      WHERE e.entreprise_id = ${eId}
      AND cc.numero LIKE '4452%'
      ${dateDebut ? sql`AND e.date_ecriture >= ${dateDebut}` : sql``}
      ${dateFin ? sql`AND e.date_ecriture <= ${dateFin}` : sql``}
    `);
    
    const rowsCollectee = tvaCollecteeData.rows || tvaCollecteeData || [];
    const rowsDeductible = tvaDeductibleData.rows || tvaDeductibleData || [];
    
    const tvaCollectee = parseFloat(rowsCollectee[0]?.montant || 0);
    const tvaDeductible = parseFloat(rowsDeductible[0]?.montant || 0);
    const tvaADecaisser = tvaCollectee - tvaDeductible;
    
    res.json({
      success: true,
      periode: { dateDebut, dateFin },
      tvaCollectee,
      tvaDeductible,
      tvaADecaisser,
      creditTVA: tvaADecaisser < 0 ? Math.abs(tvaADecaisser) : 0
    });
  } catch (error) {
    console.error('Erreur GET /api/impots/tva/resume:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du calcul de la TVA',
      error: error.message
    });
  }
});

router.get('/parametres', async (req, res) => {
  try {
    const [params] = await db
      .select()
      .from(parametresFiscaux)
      .where(eq(parametresFiscaux.entrepriseId, req.entrepriseId))
      .limit(1);

    if (!params) {
      return res.json({
        success: true,
        data: null
      });
    }

    const paramsDecryptes = {
      ...params,
      apiCleSecrete: params.apiCleSecrete ? '••••••••' : null
    };

    res.json({
      success: true,
      data: paramsDecryptes
    });
  } catch (error) {
    console.error('Erreur GET /api/impots/parametres:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des paramètres fiscaux',
      error: error.message
    });
  }
});

router.post('/parametres', async (req, res) => {
  try {
    const {
      pays,
      administrationNom,
      numeroIFU,
      numeroNIF,
      centreImpots,
      regimeImposition,
      apiUrl,
      apiIdentifiant,
      apiCleSecrete
    } = req.body;

    if (!pays) {
      return res.status(400).json({
        success: false,
        message: 'Le pays est requis'
      });
    }

    const [existing] = await db
      .select()
      .from(parametresFiscaux)
      .where(eq(parametresFiscaux.entrepriseId, req.entrepriseId))
      .limit(1);

    const dataToSave = {
      entrepriseId: req.entrepriseId,
      pays,
      administrationNom,
      numeroIFU,
      numeroNIF,
      centreImpots,
      regimeImposition,
      apiUrl,
      apiIdentifiant,
      apiCleSecrete: apiCleSecrete && apiCleSecrete !== '••••••••' ? encrypt(apiCleSecrete) : existing?.apiCleSecrete,
      connexionActive: false,
      updatedAt: new Date()
    };

    let savedParams;

    if (existing) {
      [savedParams] = await db
        .update(parametresFiscaux)
        .set(dataToSave)
        .where(eq(parametresFiscaux.id, existing.id))
        .returning();
    } else {
      [savedParams] = await db
        .insert(parametresFiscaux)
        .values(dataToSave)
        .returning();
    }

    res.json({
      success: true,
      message: 'Paramètres fiscaux enregistrés avec succès',
      data: {
        ...savedParams,
        apiCleSecrete: savedParams.apiCleSecrete ? '••••••••' : null
      }
    });
  } catch (error) {
    console.error('Erreur POST /api/impots/parametres:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'enregistrement des paramètres fiscaux',
      error: error.message
    });
  }
});

router.post('/parametres/tester-connexion', async (req, res) => {
  try {
    const [params] = await db
      .select()
      .from(parametresFiscaux)
      .where(eq(parametresFiscaux.entrepriseId, req.entrepriseId))
      .limit(1);

    if (!params) {
      return res.status(404).json({
        success: false,
        message: 'Aucun paramètre fiscal configuré'
      });
    }

    await db
      .update(parametresFiscaux)
      .set({
        connexionActive: true,
        derniereConnexion: new Date()
      })
      .where(eq(parametresFiscaux.id, params.id));

    res.json({
      success: true,
      message: `Connexion simulée avec succès à ${params.administrationNom || params.pays}`,
      data: {
        pays: params.pays,
        administration: params.administrationNom,
        statut: 'connecte'
      }
    });
  } catch (error) {
    console.error('Erreur test connexion:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du test de connexion',
      error: error.message
    });
  }
});

router.get('/declarations', async (req, res) => {
  try {
    const declarations = await db
      .select()
      .from(declarationsFiscales)
      .where(eq(declarationsFiscales.entrepriseId, req.entrepriseId))
      .orderBy(sql`${declarationsFiscales.createdAt} DESC`)
      .limit(50);

    res.json({
      success: true,
      count: declarations.length,
      data: declarations
    });
  } catch (error) {
    console.error('Erreur GET /api/impots/declarations:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des déclarations',
      error: error.message
    });
  }
});

router.post('/declarations/tva', async (req, res) => {
  try {
    const { periode, notes } = req.body;

    if (!periode) {
      return res.status(400).json({
        success: false,
        message: 'La période est requise (format: YYYY-MM)'
      });
    }

    const [params] = await db
      .select()
      .from(parametresFiscaux)
      .where(eq(parametresFiscaux.entrepriseId, req.entrepriseId))
      .limit(1);

    if (!params || !params.connexionActive) {
      return res.status(400).json({
        success: false,
        message: 'Aucune connexion active à l\'administration fiscale. Veuillez configurer et tester la connexion dans les paramètres.'
      });
    }

    const [annee, mois] = periode.split('-');
    const dateDebut = new Date(parseInt(annee), parseInt(mois) - 1, 1);
    const dateFin = new Date(parseInt(annee), parseInt(mois), 0, 23, 59, 59);

    const facturesPeriode = await db
      .select({
        totalTTC: factures.totalTTC,
        totalHT: factures.totalHT,
        montantTVA: factures.montantTVA
      })
      .from(factures)
      .where(and(
        eq(factures.entrepriseId, req.entrepriseId),
        gte(factures.dateFacture, dateDebut),
        lte(factures.dateFacture, dateFin),
        sql`${factures.statut} IN ('envoyee', 'payee', 'retard')`
      ));

    const tvaCollectee = facturesPeriode.reduce((sum, f) => sum + parseFloat(f.montantTVA || 0), 0);
    const montantHT = facturesPeriode.reduce((sum, f) => sum + parseFloat(f.totalHT || 0), 0);

    const [declaration] = await db
      .insert(declarationsFiscales)
      .values({
        entrepriseId: req.entrepriseId,
        type: 'tva',
        periode,
        montant: tvaCollectee.toString(),
        statut: 'soumise',
        numeroDeclaration: `TVA-${periode}-${Date.now()}`,
        dateDeclaration: new Date(),
        dateSoumission: new Date(),
        reponseAdministration: JSON.stringify({
          success: true,
          message: 'Déclaration simulée acceptée',
          administration: params.administrationNom,
          pays: params.pays
        }),
        notes
      })
      .returning();

    await db
      .update(parametresFiscaux)
      .set({ derniereSynchronisation: new Date() })
      .where(eq(parametresFiscaux.id, params.id));

    res.json({
      success: true,
      message: 'Déclaration TVA créée avec succès',
      data: {
        ...declaration,
        calculs: {
          montantHT,
          tvaCollectee,
          nombreFactures: facturesPeriode.length
        }
      }
    });
  } catch (error) {
    console.error('Erreur POST /api/impots/declarations/tva:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de la déclaration TVA',
      error: error.message
    });
  }
});

// ==========================================
// PAIEMENT DES IMPÔTS
// ==========================================

router.post('/declarations/:id/payer', async (req, res) => {
  try {
    const { id } = req.params;
    const { datePaiement, modePaiement = 'virement', reference } = req.body;

    const [declaration] = await db
      .select()
      .from(declarationsFiscales)
      .where(and(
        eq(declarationsFiscales.id, parseInt(id)),
        eq(declarationsFiscales.entrepriseId, req.entrepriseId)
      ))
      .limit(1);

    if (!declaration) {
      return res.status(404).json({
        success: false,
        message: 'Déclaration non trouvée'
      });
    }

    if (declaration.statut === 'payée') {
      return res.status(400).json({
        success: false,
        message: 'Cette déclaration est déjà payée'
      });
    }

    // Mettre à jour le statut de la déclaration
    const [updated] = await db
      .update(declarationsFiscales)
      .set({
        statut: 'payée',
        datePaiement: new Date(datePaiement || new Date()),
        referencePaiement: reference || `PAY-${Date.now()}`
      })
      .where(eq(declarationsFiscales.id, parseInt(id)))
      .returning();

    // Créer écriture comptable automatique
    try {
      await createEcriturePaiementImpot({
        entrepriseId: req.entrepriseId,
        reference: reference || `IMP-${declaration.numeroDeclaration}`,
        datePaiement: new Date(datePaiement || new Date()),
        typeImpot: declaration.type,
        montant: parseFloat(declaration.montant),
        periode: declaration.periode,
        modePaiement
      });
      console.log(`Écriture comptable créée pour paiement impôt ${declaration.type} - ${declaration.periode}`);
    } catch (comptaError) {
      console.error('Erreur création écriture comptable impôt:', comptaError.message);
    }

    res.json({
      success: true,
      message: 'Paiement enregistré avec succès',
      data: updated
    });
  } catch (error) {
    console.error('Erreur POST /api/impots/declarations/:id/payer:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'enregistrement du paiement',
      error: error.message
    });
  }
});

export default router;
