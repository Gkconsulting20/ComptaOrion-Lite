import express from 'express';
import { db } from '../db.js';
import { tauxChange, devises, entreprises } from '../schema.js';
import { eq, and, desc, lte, or } from 'drizzle-orm';
import { authMiddleware, entrepriseIsolation } from '../auth.js';

const router = express.Router();

router.use(authMiddleware);
router.use(entrepriseIsolation);

const DEVISES_PREDEFINIES = [
  { code: 'XOF', nom: 'Franc CFA BCEAO', symbole: 'FCFA', decimales: 0 },
  { code: 'XAF', nom: 'Franc CFA BEAC', symbole: 'FCFA', decimales: 0 },
  { code: 'EUR', nom: 'Euro', symbole: '€', decimales: 2 },
  { code: 'USD', nom: 'Dollar américain', symbole: '$', decimales: 2 },
  { code: 'GBP', nom: 'Livre sterling', symbole: '£', decimales: 2 },
  { code: 'CAD', nom: 'Dollar canadien', symbole: 'CAD', decimales: 2 },
  { code: 'CHF', nom: 'Franc suisse', symbole: 'CHF', decimales: 2 },
  { code: 'GNF', nom: 'Franc guinéen', symbole: 'GNF', decimales: 0 },
  { code: 'MGA', nom: 'Ariary malgache', symbole: 'Ar', decimales: 0 },
  { code: 'NGN', nom: 'Naira nigérian', symbole: '₦', decimales: 2 },
  { code: 'GHS', nom: 'Cedi ghanéen', symbole: 'GH₵', decimales: 2 },
  { code: 'KES', nom: 'Shilling kényan', symbole: 'KSh', decimales: 2 },
  { code: 'ZAR', nom: 'Rand sud-africain', symbole: 'R', decimales: 2 },
  { code: 'MAD', nom: 'Dirham marocain', symbole: 'DH', decimales: 2 },
  { code: 'TND', nom: 'Dinar tunisien', symbole: 'TND', decimales: 3 },
  { code: 'DZD', nom: 'Dinar algérien', symbole: 'DA', decimales: 2 },
  { code: 'EGP', nom: 'Livre égyptienne', symbole: 'E£', decimales: 2 },
  { code: 'CNY', nom: 'Yuan chinois', symbole: '¥', decimales: 2 },
  { code: 'JPY', nom: 'Yen japonais', symbole: '¥', decimales: 0 },
  { code: 'INR', nom: 'Roupie indienne', symbole: '₹', decimales: 2 },
];

async function getHomeCurrency(entrepriseId) {
  const entreprise = await db.select({ devise: entreprises.devise })
    .from(entreprises)
    .where(eq(entreprises.id, entrepriseId))
    .limit(1);
  return entreprise[0]?.devise || 'XOF';
}

router.get('/devises', async (req, res) => {
  try {
    let devisesDb = await db.select().from(devises).orderBy(devises.code);
    
    if (devisesDb.length === 0) {
      for (const d of DEVISES_PREDEFINIES) {
        await db.insert(devises).values(d).onConflictDoNothing();
      }
      devisesDb = await db.select().from(devises).orderBy(devises.code);
    }
    
    res.json(devisesDb);
  } catch (error) {
    console.error('Erreur GET devises:', error);
    res.status(500).json({ message: 'Erreur serveur', error: error.message });
  }
});

router.get('/home-currency', async (req, res) => {
  try {
    const homeCurrency = await getHomeCurrency(req.entrepriseId);
    res.json({ homeCurrency });
  } catch (error) {
    console.error('Erreur GET home-currency:', error);
    res.status(500).json({ message: 'Erreur serveur', error: error.message });
  }
});

router.get('/taux', async (req, res) => {
  try {
    const taux = await db.select({
      id: tauxChange.id,
      deviseSource: tauxChange.deviseSource,
      deviseCible: tauxChange.deviseCible,
      taux: tauxChange.taux,
      dateEffet: tauxChange.dateEffet,
      source: tauxChange.source,
      notes: tauxChange.notes,
      actif: tauxChange.actif,
      createdAt: tauxChange.createdAt
    })
    .from(tauxChange)
    .where(eq(tauxChange.entrepriseId, req.entrepriseId))
    .orderBy(desc(tauxChange.dateEffet));
    
    res.json(taux);
  } catch (error) {
    console.error('Erreur GET taux:', error);
    res.status(500).json({ message: 'Erreur serveur', error: error.message });
  }
});

router.get('/taux/paire/:source/:cible', async (req, res) => {
  try {
    const { source, cible } = req.params;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    
    const taux = await db.select()
      .from(tauxChange)
      .where(and(
        eq(tauxChange.entrepriseId, req.entrepriseId),
        eq(tauxChange.deviseSource, source.toUpperCase()),
        eq(tauxChange.deviseCible, cible.toUpperCase()),
        lte(tauxChange.dateEffet, date),
        eq(tauxChange.actif, true)
      ))
      .orderBy(desc(tauxChange.dateEffet))
      .limit(1);
    
    if (taux.length === 0) {
      const tauxInverse = await db.select()
        .from(tauxChange)
        .where(and(
          eq(tauxChange.entrepriseId, req.entrepriseId),
          eq(tauxChange.deviseSource, cible.toUpperCase()),
          eq(tauxChange.deviseCible, source.toUpperCase()),
          lte(tauxChange.dateEffet, date),
          eq(tauxChange.actif, true)
        ))
        .orderBy(desc(tauxChange.dateEffet))
        .limit(1);
      
      if (tauxInverse.length > 0) {
        const tauxCalcule = 1 / parseFloat(tauxInverse[0].taux);
        return res.json({
          ...tauxInverse[0],
          deviseSource: source.toUpperCase(),
          deviseCible: cible.toUpperCase(),
          taux: tauxCalcule.toFixed(6),
          inverse: true
        });
      }
      
      return res.status(404).json({ 
        message: `Aucun taux de change trouvé pour ${source}/${cible}`,
        suggestion: 'Veuillez ajouter un taux de change pour cette paire de devises'
      });
    }
    
    res.json({ ...taux[0], inverse: false });
  } catch (error) {
    console.error('Erreur GET taux paire:', error);
    res.status(500).json({ message: 'Erreur serveur', error: error.message });
  }
});

router.post('/taux', async (req, res) => {
  try {
    const { deviseSource, deviseCible, taux, dateEffet, notes } = req.body;
    
    if (!deviseSource || !deviseCible || !taux || !dateEffet) {
      return res.status(400).json({ 
        message: 'Champs requis: deviseSource, deviseCible, taux, dateEffet' 
      });
    }
    
    if (deviseSource.toUpperCase() === deviseCible.toUpperCase()) {
      return res.status(400).json({ message: 'Les devises source et cible doivent être différentes' });
    }
    
    const tauxNum = parseFloat(taux);
    if (isNaN(tauxNum) || tauxNum <= 0) {
      return res.status(400).json({ message: 'Le taux doit être un nombre positif' });
    }
    
    const nouveauTaux = await db.insert(tauxChange).values({
      entrepriseId: req.entrepriseId,
      deviseSource: deviseSource.toUpperCase(),
      deviseCible: deviseCible.toUpperCase(),
      taux: tauxNum.toString(),
      dateEffet,
      source: 'manuel',
      notes,
      createdBy: req.userId
    }).returning();
    
    res.status(201).json(nouveauTaux[0]);
  } catch (error) {
    console.error('Erreur POST taux:', error);
    res.status(500).json({ message: 'Erreur serveur', error: error.message });
  }
});

router.put('/taux/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { taux, dateEffet, notes, actif } = req.body;
    
    const updateData = { updatedAt: new Date() };
    if (taux !== undefined) updateData.taux = parseFloat(taux).toString();
    if (dateEffet !== undefined) updateData.dateEffet = dateEffet;
    if (notes !== undefined) updateData.notes = notes;
    if (actif !== undefined) updateData.actif = actif;
    
    const updated = await db.update(tauxChange)
      .set(updateData)
      .where(and(
        eq(tauxChange.id, parseInt(id)),
        eq(tauxChange.entrepriseId, req.entrepriseId)
      ))
      .returning();
    
    if (updated.length === 0) {
      return res.status(404).json({ message: 'Taux non trouvé' });
    }
    
    res.json(updated[0]);
  } catch (error) {
    console.error('Erreur PUT taux:', error);
    res.status(500).json({ message: 'Erreur serveur', error: error.message });
  }
});

router.delete('/taux/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const deleted = await db.delete(tauxChange)
      .where(and(
        eq(tauxChange.id, parseInt(id)),
        eq(tauxChange.entrepriseId, req.entrepriseId)
      ))
      .returning();
    
    if (deleted.length === 0) {
      return res.status(404).json({ message: 'Taux non trouvé' });
    }
    
    res.json({ message: 'Taux supprimé', id: parseInt(id) });
  } catch (error) {
    console.error('Erreur DELETE taux:', error);
    res.status(500).json({ message: 'Erreur serveur', error: error.message });
  }
});

router.post('/convertir', async (req, res) => {
  try {
    const { montant, deviseSource, deviseCible, date } = req.body;
    
    if (!montant || !deviseSource || !deviseCible) {
      return res.status(400).json({ message: 'Champs requis: montant, deviseSource, deviseCible' });
    }
    
    const dateRecherche = date || new Date().toISOString().split('T')[0];
    const source = deviseSource.toUpperCase();
    const cible = deviseCible.toUpperCase();
    
    if (source === cible) {
      return res.json({
        montantOriginal: parseFloat(montant),
        deviseSource: source,
        montantConverti: parseFloat(montant),
        deviseCible: cible,
        tauxUtilise: 1,
        dateEffet: dateRecherche,
        inverse: false
      });
    }
    
    let tauxUtilise = null;
    let inverse = false;
    let dateEffet = null;
    
    const tauxDirect = await db.select()
      .from(tauxChange)
      .where(and(
        eq(tauxChange.entrepriseId, req.entrepriseId),
        eq(tauxChange.deviseSource, source),
        eq(tauxChange.deviseCible, cible),
        lte(tauxChange.dateEffet, dateRecherche),
        eq(tauxChange.actif, true)
      ))
      .orderBy(desc(tauxChange.dateEffet))
      .limit(1);
    
    if (tauxDirect.length > 0) {
      tauxUtilise = parseFloat(tauxDirect[0].taux);
      dateEffet = tauxDirect[0].dateEffet;
    } else {
      const tauxInverse = await db.select()
        .from(tauxChange)
        .where(and(
          eq(tauxChange.entrepriseId, req.entrepriseId),
          eq(tauxChange.deviseSource, cible),
          eq(tauxChange.deviseCible, source),
          lte(tauxChange.dateEffet, dateRecherche),
          eq(tauxChange.actif, true)
        ))
        .orderBy(desc(tauxChange.dateEffet))
        .limit(1);
      
      if (tauxInverse.length > 0) {
        tauxUtilise = 1 / parseFloat(tauxInverse[0].taux);
        dateEffet = tauxInverse[0].dateEffet;
        inverse = true;
      }
    }
    
    if (tauxUtilise === null) {
      return res.status(404).json({
        message: `Aucun taux de change trouvé pour ${source}/${cible}`,
        suggestion: 'Veuillez ajouter un taux de change pour cette paire de devises'
      });
    }
    
    const montantConverti = parseFloat(montant) * tauxUtilise;
    
    res.json({
      montantOriginal: parseFloat(montant),
      deviseSource: source,
      montantConverti: Math.round(montantConverti * 100) / 100,
      deviseCible: cible,
      tauxUtilise: parseFloat(tauxUtilise.toFixed(6)),
      dateEffet,
      inverse
    });
  } catch (error) {
    console.error('Erreur conversion:', error);
    res.status(500).json({ message: 'Erreur serveur', error: error.message });
  }
});

export default router;
