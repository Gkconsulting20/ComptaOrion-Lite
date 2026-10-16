import express from 'express';
import { db } from '../db.js';
import { 
  ecrituresRecurrentes, 
  histoGeneration, 
  parametresComptables,
  journaux,
  comptesComptables,
  ecritures,
  lignesEcritures
} from '../schema.js';
import { eq, and, sql, gte, lte } from 'drizzle-orm';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const recurrentes = await db.select({
      ecriture: ecrituresRecurrentes,
      journal: journaux
    })
    .from(ecrituresRecurrentes)
    .leftJoin(journaux, eq(ecrituresRecurrentes.journalId, journaux.id))
    .where(eq(ecrituresRecurrentes.entrepriseId, req.entrepriseId))
    .orderBy(sql`${ecrituresRecurrentes.nom} ASC`);

    res.json(recurrentes.map(r => ({
      ...r.ecriture,
      journal: r.journal
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [recurrente] = await db.select()
      .from(ecrituresRecurrentes)
      .where(and(
        eq(ecrituresRecurrentes.id, parseInt(req.params.id)),
        eq(ecrituresRecurrentes.entrepriseId, req.entrepriseId)
      ))
      .limit(1);

    if (!recurrente) {
      return res.status(404).json({ error: 'Écriture récurrente introuvable' });
    }

    res.json(recurrente);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function calculerProchaineDateGeneration(dateDebut, frequence, jourDuMois, moisDebut) {
  const now = new Date();
  let prochaine = new Date(dateDebut);

  while (prochaine <= now) {
    switch (frequence) {
      case 'mensuel':
        prochaine.setMonth(prochaine.getMonth() + 1);
        break;
      case 'trimestriel':
        prochaine.setMonth(prochaine.getMonth() + 3);
        break;
      case 'semestriel':
        prochaine.setMonth(prochaine.getMonth() + 6);
        break;
      case 'annuel':
        prochaine.setFullYear(prochaine.getFullYear() + 1);
        break;
    }
  }

  prochaine.setDate(jourDuMois || 1);
  return prochaine.toISOString().split('T')[0];
}

router.post('/', async (req, res) => {
  try {
    const {
      journalId,
      nom,
      description,
      frequence,
      jourDuMois,
      moisDebut,
      dateDebut,
      dateFin,
      montantReference,
      lignesModele
    } = req.body;

    if (!nom || !journalId || !frequence || !dateDebut || !lignesModele || lignesModele.length === 0) {
      return res.status(400).json({ error: 'Champs obligatoires manquants' });
    }

    let totalDebit = 0;
    let totalCredit = 0;
    lignesModele.forEach(ligne => {
      const montant = parseFloat(ligne.montant);
      if (ligne.type === 'debit') {
        totalDebit += montant;
      } else {
        totalCredit += montant;
      }
    });

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return res.status(400).json({ 
        error: 'Les lignes doivent être équilibrées (total débit = total crédit)' 
      });
    }

    const prochaineDateGeneration = calculerProchaineDateGeneration(
      dateDebut, frequence, jourDuMois, moisDebut
    );

    const [nouvelleRecurrente] = await db.insert(ecrituresRecurrentes)
      .values({
        entrepriseId: req.entrepriseId,
        journalId,
        nom,
        description,
        frequence,
        jourDuMois: jourDuMois || 1,
        moisDebut: moisDebut || 1,
        dateDebut,
        dateFin,
        montantReference,
        lignesModele: JSON.stringify(lignesModele),
        prochaineDateGeneration,
        actif: true
      })
      .returning();

    res.json(nouvelleRecurrente);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      journalId,
      nom,
      description,
      frequence,
      jourDuMois,
      moisDebut,
      dateDebut,
      dateFin,
      montantReference,
      lignesModele,
      actif
    } = req.body;

    const [existe] = await db.select()
      .from(ecrituresRecurrentes)
      .where(and(
        eq(ecrituresRecurrentes.id, parseInt(id)),
        eq(ecrituresRecurrentes.entrepriseId, req.entrepriseId)
      ))
      .limit(1);

    if (!existe) {
      return res.status(404).json({ error: 'Écriture récurrente introuvable' });
    }

    if (lignesModele && lignesModele.length > 0) {
      let totalDebit = 0;
      let totalCredit = 0;
      lignesModele.forEach(ligne => {
        const montant = parseFloat(ligne.montant);
        if (ligne.type === 'debit') {
          totalDebit += montant;
        } else {
          totalCredit += montant;
        }
      });

      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return res.status(400).json({ 
          error: 'Les lignes doivent être équilibrées (total débit = total crédit)' 
        });
      }
    }

    const [updated] = await db.update(ecrituresRecurrentes)
      .set({
        journalId,
        nom,
        description,
        frequence,
        jourDuMois,
        moisDebut,
        dateDebut,
        dateFin,
        montantReference,
        lignesModele: lignesModele ? JSON.stringify(lignesModele) : undefined,
        actif,
        updatedAt: new Date()
      })
      .where(and(
        eq(ecrituresRecurrentes.id, parseInt(id)),
        eq(ecrituresRecurrentes.entrepriseId, req.entrepriseId)
      ))
      .returning();

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [existe] = await db.select()
      .from(ecrituresRecurrentes)
      .where(and(
        eq(ecrituresRecurrentes.id, parseInt(id)),
        eq(ecrituresRecurrentes.entrepriseId, req.entrepriseId)
      ))
      .limit(1);

    if (!existe) {
      return res.status(404).json({ error: 'Écriture récurrente introuvable' });
    }

    await db.delete(ecrituresRecurrentes)
      .where(and(
        eq(ecrituresRecurrentes.id, parseInt(id)),
        eq(ecrituresRecurrentes.entrepriseId, req.entrepriseId)
      ));

    res.json({ message: 'Écriture récurrente supprimée avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/generer', async (req, res) => {
  try {
    const { id } = req.params;
    const { dateEcriture } = req.body;

    const [recurrente] = await db.select()
      .from(ecrituresRecurrentes)
      .where(and(
        eq(ecrituresRecurrentes.id, parseInt(id)),
        eq(ecrituresRecurrentes.entrepriseId, req.entrepriseId)
      ))
      .limit(1);

    if (!recurrente) {
      return res.status(404).json({ error: 'Écriture récurrente introuvable' });
    }

    if (!recurrente.actif) {
      return res.status(400).json({ error: 'Écriture récurrente inactive' });
    }

    const lignes = typeof recurrente.lignesModele === 'string' 
      ? JSON.parse(recurrente.lignesModele) 
      : recurrente.lignesModele;

    for (const ligne of lignes) {
      const [compte] = await db.select()
        .from(comptesComptables)
        .where(and(
          eq(comptesComptables.id, ligne.compteId),
          eq(comptesComptables.entrepriseId, req.entrepriseId)
        ))
        .limit(1);
      
      if (!compte) {
        return res.status(400).json({ 
          error: `Le compte ${ligne.compteId} n'appartient pas à cette entreprise` 
        });
      }
    }

    let totalDebit = 0;
    let totalCredit = 0;
    lignes.forEach(ligne => {
      const montant = parseFloat(ligne.montant);
      if (ligne.type === 'debit') {
        totalDebit += montant;
      } else {
        totalCredit += montant;
      }
    });

    const [nouvelleEcriture] = await db.insert(ecritures)
      .values({
        entrepriseId: req.entrepriseId,
        journalId: recurrente.journalId,
        dateEcriture: dateEcriture || new Date().toISOString().split('T')[0],
        reference: `REC-${recurrente.id}-${Date.now()}`,
        description: `${recurrente.nom} - ${recurrente.description || ''}`,
        statut: 'brouillon',
        totalDebit: totalDebit.toString(),
        totalCredit: totalCredit.toString()
      })
      .returning();

    for (const ligne of lignes) {
      await db.insert(lignesEcritures)
        .values({
          entrepriseId: req.entrepriseId,
          ecritureId: nouvelleEcriture.id,
          compteId: ligne.compteId,
          montant: ligne.montant.toString(),
          type: ligne.type,
          description: ligne.description
        });
    }

    await db.insert(histoGeneration)
      .values({
        entrepriseId: req.entrepriseId,
        ecritureRecurrenteId: recurrente.id,
        ecritureId: nouvelleEcriture.id,
        dateEcriture: dateEcriture || new Date().toISOString().split('T')[0],
        statut: 'generee'
      });

    const prochaineDateGeneration = calculerProchaineDateGeneration(
      dateEcriture || new Date().toISOString().split('T')[0],
      recurrente.frequence,
      recurrente.jourDuMois,
      recurrente.moisDebut
    );

    await db.update(ecrituresRecurrentes)
      .set({
        derniereDateGeneration: dateEcriture || new Date().toISOString().split('T')[0],
        prochaineDateGeneration,
        updatedAt: new Date()
      })
      .where(eq(ecrituresRecurrentes.id, recurrente.id));

    res.json({ 
      message: 'Écriture générée avec succès',
      ecriture: nouvelleEcriture
    });
  } catch (err) {
    await db.insert(histoGeneration)
      .values({
        entrepriseId: req.entrepriseId,
        ecritureRecurrenteId: parseInt(req.params.id),
        dateEcriture: req.body.dateEcriture || new Date().toISOString().split('T')[0],
        statut: 'echouee',
        messageErreur: err.message
      })
      .catch(() => {});
    
    res.status(500).json({ error: err.message });
  }
});

router.get('/parametres/comptables', async (req, res) => {
  try {
    const [params] = await db.select()
      .from(parametresComptables)
      .where(eq(parametresComptables.entrepriseId, req.entrepriseId))
      .limit(1);

    if (!params) {
      const [nouveauParams] = await db.insert(parametresComptables)
        .values({
          entrepriseId: req.entrepriseId
        })
        .returning();
      
      return res.json(nouveauParams);
    }

    res.json(params);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/parametres/comptables', async (req, res) => {
  try {
    const {
      prefixeEcritures,
      numeroSuivantEcriture,
      formatNumeroEcriture,
      validationAutomatique,
      toleranceDesequilibre,
      bloquerSiDesequilibre,
      clotureDateLimite,
      exerciceCourant,
      afficherSoldesComptes,
      afficherCodeComplet,
      archiverApresNJours
    } = req.body;

    const [existe] = await db.select()
      .from(parametresComptables)
      .where(eq(parametresComptables.entrepriseId, req.entrepriseId))
      .limit(1);

    let result;
    if (!existe) {
      [result] = await db.insert(parametresComptables)
        .values({
          entrepriseId: req.entrepriseId,
          prefixeEcritures,
          numeroSuivantEcriture,
          formatNumeroEcriture,
          validationAutomatique,
          toleranceDesequilibre,
          bloquerSiDesequilibre,
          clotureDateLimite,
          exerciceCourant,
          afficherSoldesComptes,
          afficherCodeComplet,
          archiverApresNJours
        })
        .returning();
    } else {
      [result] = await db.update(parametresComptables)
        .set({
          prefixeEcritures,
          numeroSuivantEcriture,
          formatNumeroEcriture,
          validationAutomatique,
          toleranceDesequilibre,
          bloquerSiDesequilibre,
          clotureDateLimite,
          exerciceCourant,
          afficherSoldesComptes,
          afficherCodeComplet,
          archiverApresNJours,
          updatedAt: new Date()
        })
        .where(eq(parametresComptables.entrepriseId, req.entrepriseId))
        .returning();
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/historique', async (req, res) => {
  try {
    const { id } = req.params;

    const historique = await db.select()
      .from(histoGeneration)
      .where(and(
        eq(histoGeneration.ecritureRecurrenteId, parseInt(id)),
        eq(histoGeneration.entrepriseId, req.entrepriseId)
      ))
      .orderBy(sql`${histoGeneration.dateGeneration} DESC`)
      .limit(50);

    res.json(historique);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
