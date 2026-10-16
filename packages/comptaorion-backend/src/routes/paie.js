import express from 'express';
import { db } from '../db.js';
import { employes, fichesPaie, avancesSalaire, ecritures, lignesEcritures } from '../schema.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import { logAudit, extractAuditInfo } from '../utils/auditLogger.js';

const router = express.Router();

router.get('/employes', async (req, res) => {
  try {
    const { entrepriseId } = req;
    const list = await db.select().from(employes)
      .where(eq(employes.entrepriseId, entrepriseId))
      .orderBy(desc(employes.createdAt));
    res.json({ success: true, data: list });
  } catch (error) {
    console.error('Erreur GET /employes:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/employes/:id', async (req, res) => {
  try {
    const { entrepriseId } = req;
    const { id } = req.params;
    const [employe] = await db.select().from(employes)
      .where(and(eq(employes.id, parseInt(id)), eq(employes.entrepriseId, entrepriseId)));
    
    if (!employe) {
      return res.status(404).json({ success: false, message: 'Employé non trouvé' });
    }
    res.json({ success: true, data: employe });
  } catch (error) {
    console.error('Erreur GET /employes/:id:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/employes', async (req, res) => {
  try {
    const { entrepriseId } = req;
    const auditInfo = extractAuditInfo(req);
    
    const [newEmploye] = await db.insert(employes).values({
      entrepriseId,
      ...req.body
    }).returning();

    await logAudit({
      ...auditInfo,
      action: 'CREATE',
      table: 'employes',
      recordId: newEmploye.id,
      nouvelleValeur: newEmploye,
      description: `Employé créé: ${newEmploye.nom} ${newEmploye.prenom}`
    });

    res.json({ success: true, message: 'Employé créé avec succès', data: newEmploye });
  } catch (error) {
    console.error('Erreur POST /employes:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/employes/:id', async (req, res) => {
  try {
    const { entrepriseId } = req;
    const { id } = req.params;
    const auditInfo = extractAuditInfo(req);

    const [ancienne] = await db.select().from(employes)
      .where(and(eq(employes.id, parseInt(id)), eq(employes.entrepriseId, entrepriseId)));

    if (!ancienne) {
      return res.status(404).json({ success: false, message: 'Employé non trouvé' });
    }

    const [updated] = await db.update(employes)
      .set({ ...req.body, updatedAt: new Date() })
      .where(and(eq(employes.id, parseInt(id)), eq(employes.entrepriseId, entrepriseId)))
      .returning();

    await logAudit({
      ...auditInfo,
      action: 'UPDATE',
      table: 'employes',
      recordId: updated.id,
      ancienneValeur: ancienne,
      nouvelleValeur: updated,
      description: `Employé modifié: ${updated.nom} ${updated.prenom}`
    });

    res.json({ success: true, message: 'Employé modifié avec succès', data: updated });
  } catch (error) {
    console.error('Erreur PUT /employes/:id:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/employes/:id', async (req, res) => {
  try {
    const { entrepriseId } = req;
    const { id } = req.params;
    const auditInfo = extractAuditInfo(req);

    const [ancienne] = await db.select().from(employes)
      .where(and(eq(employes.id, parseInt(id)), eq(employes.entrepriseId, entrepriseId)));

    if (!ancienne) {
      return res.status(404).json({ success: false, message: 'Employé non trouvé' });
    }

    await db.delete(employes)
      .where(and(eq(employes.id, parseInt(id)), eq(employes.entrepriseId, entrepriseId)));

    await logAudit({
      ...auditInfo,
      action: 'DELETE',
      table: 'employes',
      recordId: parseInt(id),
      ancienneValeur: ancienne,
      description: `Employé supprimé: ${ancienne.nom} ${ancienne.prenom}`
    });

    res.json({ success: true, message: 'Employé supprimé avec succès' });
  } catch (error) {
    console.error('Erreur DELETE /employes/:id:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/fiches-paie', async (req, res) => {
  try {
    const { entrepriseId } = req;
    const { employeId, mois } = req.query;

    let query = db.select({
      fiche: fichesPaie,
      employe: {
        id: employes.id,
        matricule: employes.matricule,
        nom: employes.nom,
        prenom: employes.prenom,
        poste: employes.poste
      }
    }).from(fichesPaie)
      .leftJoin(employes, eq(fichesPaie.employeId, employes.id))
      .where(eq(fichesPaie.entrepriseId, entrepriseId));

    if (employeId) {
      query = query.where(eq(fichesPaie.employeId, parseInt(employeId)));
    }
    if (mois) {
      query = query.where(eq(fichesPaie.mois, mois));
    }

    const list = await query.orderBy(desc(fichesPaie.mois));
    res.json({ success: true, data: list });
  } catch (error) {
    console.error('Erreur GET /fiches-paie:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/fiches-paie', async (req, res) => {
  try {
    const { entrepriseId } = req;
    const auditInfo = extractAuditInfo(req);
    const { employeId, mois, genererEcriture } = req.body;

    const salaireBrut = parseFloat(req.body.salaireBase || 0) +
      parseFloat(req.body.indemnitesTransport || 0) +
      parseFloat(req.body.indemnitesLogement || 0) +
      parseFloat(req.body.indemnitesAutres || 0) +
      parseFloat(req.body.avantagesNature || 0) +
      parseFloat(req.body.heuresSupplementaires || 0) +
      parseFloat(req.body.primes || 0);

    const totalRetenues = parseFloat(req.body.cotisationsCNPS || 0) +
      parseFloat(req.body.cotisationsIPRES || 0) +
      parseFloat(req.body.impotSurRevenu || 0) +
      parseFloat(req.body.autresRetenues || 0) +
      parseFloat(req.body.avancesSalaire || 0);

    const salaireNet = salaireBrut - totalRetenues;

    let ecritureId = null;

    if (genererEcriture) {
      const [ecriture] = await db.insert(ecritures).values({
        entrepriseId,
        journalId: 1,
        reference: `PAIE-${mois}-${employeId}`,
        dateEcriture: new Date(),
        libelle: `Salaire ${mois} - Employé #${employeId}`,
        statut: 'validée',
      }).returning();

      await db.insert(lignesEcritures).values([
        {
          entrepriseId,
          ecritureId: ecriture.id,
          compteId: 1,
          libelle: `Charge de personnel - Salaire ${mois}`,
          debit: salaireBrut,
          credit: 0
        },
        {
          entrepriseId,
          ecritureId: ecriture.id,
          compteId: 2,
          libelle: `Dette salariale - Salaire ${mois}`,
          debit: 0,
          credit: salaireNet
        },
        {
          entrepriseId,
          ecritureId: ecriture.id,
          compteId: 3,
          libelle: `Cotisations sociales - ${mois}`,
          debit: 0,
          credit: totalRetenues - parseFloat(req.body.avancesSalaire || 0)
        }
      ]);

      ecritureId = ecriture.id;
    }

    const [newFiche] = await db.insert(fichesPaie).values({
      entrepriseId,
      employeId,
      mois,
      salaireBase: req.body.salaireBase,
      indemnitesTransport: req.body.indemnitesTransport || 0,
      indemnitesLogement: req.body.indemnitesLogement || 0,
      indemnitesAutres: req.body.indemnitesAutres || 0,
      avantagesNature: req.body.avantagesNature || 0,
      heuresSupplementaires: req.body.heuresSupplementaires || 0,
      primes: req.body.primes || 0,
      salaireBrut,
      cotisationsCNPS: req.body.cotisationsCNPS || 0,
      cotisationsIPRES: req.body.cotisationsIPRES || 0,
      impotSurRevenu: req.body.impotSurRevenu || 0,
      autresRetenues: req.body.autresRetenues || 0,
      avancesSalaire: req.body.avancesSalaire || 0,
      salaireNet,
      ecritureComptableId: ecritureId,
      statut: req.body.statut || 'brouillon',
      notes: req.body.notes
    }).returning();

    await logAudit({
      ...auditInfo,
      action: 'CREATE',
      table: 'fiches_paie',
      recordId: newFiche.id,
      nouvelleValeur: newFiche,
      description: `Fiche de paie créée pour ${mois}`
    });

    res.json({ success: true, message: 'Fiche de paie créée avec succès', data: newFiche });
  } catch (error) {
    console.error('Erreur POST /fiches-paie:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/avances', async (req, res) => {
  try {
    const { entrepriseId } = req;
    const { employeId } = req.query;

    let query = db.select({
      avance: avancesSalaire,
      employe: {
        id: employes.id,
        nom: employes.nom,
        prenom: employes.prenom
      }
    }).from(avancesSalaire)
      .leftJoin(employes, eq(avancesSalaire.employeId, employes.id))
      .where(eq(avancesSalaire.entrepriseId, entrepriseId));

    if (employeId) {
      query = query.where(eq(avancesSalaire.employeId, parseInt(employeId)));
    }

    const list = await query.orderBy(desc(avancesSalaire.dateAvance));
    res.json({ success: true, data: list });
  } catch (error) {
    console.error('Erreur GET /avances:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/avances', async (req, res) => {
  try {
    const { entrepriseId } = req;
    const auditInfo = extractAuditInfo(req);

    const [newAvance] = await db.insert(avancesSalaire).values({
      entrepriseId,
      ...req.body
    }).returning();

    await logAudit({
      ...auditInfo,
      action: 'CREATE',
      table: 'avances_salaire',
      recordId: newAvance.id,
      nouvelleValeur: newAvance,
      description: `Avance sur salaire créée: ${newAvance.montant} FCFA`
    });

    res.json({ success: true, message: 'Avance créée avec succès', data: newAvance });
  } catch (error) {
    console.error('Erreur POST /avances:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
