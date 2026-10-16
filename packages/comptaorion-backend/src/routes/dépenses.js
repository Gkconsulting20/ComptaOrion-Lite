import express from 'express';
import { db } from '../db.js';
import { depenses, categoriesDepenses, approvalsDepenses, remboursementsEmployes, auditLogs, employes, liteIdempotency } from '../schema.js';
import { eq, and, gte, lte, desc } from 'drizzle-orm';
import { createEcritureDepense } from '../services/comptabiliteService.js';
import { claimIdempotentOperation } from '../middleware/idempotency.js';

const router = express.Router();

// ==========================================
// CRUD CATÉGORIES DÉPENSES
// ==========================================

router.get('/categories', async (req, res) => {
  try {
    const categories = await db.query.categoriesDepenses.findMany({
      where: eq(categoriesDepenses.entrepriseId, req.entrepriseId)
    });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/categories', async (req, res) => {
  try {
    const { nom, description, limiteApproval } = req.body;
    const result = await db.insert(categoriesDepenses).values({
      entrepriseId: req.entrepriseId,
      nom,
      description,
      limiteApproval: parseFloat(limiteApproval) || 0
    }).returning();
    res.json(result[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ENREGISTREMENT DÉPENSES
// ==========================================

router.post('/create', async (req, res) => {
  try {
    const { categorieId, montant, dateDepense, description, justificatifUrl, récurrente, fréquenceRécurrence, ipAddress } = req.body;
    const numericAmount = Number(montant);
    const parsedDate = dateDepense ? new Date(dateDepense) : new Date();
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || Number.isNaN(parsedDate.getTime()) || !String(description || '').trim()) {
      return res.status(400).json({ error: 'Montant, date et description sont obligatoires et doivent être valides' });
    }
    const result = await db.transaction(async (tx) => {
    const idempotency = await claimIdempotentOperation({
      entrepriseId: req.entrepriseId,
      idempotencyKey: req.idempotencyKey,
      insertClaim: async () => {
        const [claim] = await tx.insert(liteIdempotency).values({
          entrepriseId: req.entrepriseId,
          idempotencyKey: req.idempotencyKey,
        }).onConflictDoNothing().returning();
        return claim;
      },
      findByKey: async () => {
        const [existing] = await tx.select().from(liteIdempotency)
          .where(eq(liteIdempotency.idempotencyKey, req.idempotencyKey))
          .limit(1);
        return existing;
      },
    });
    if (idempotency.replay) return idempotency;
    let categorie = null;

    if (categorieId) {
      [categorie] = await tx.select().from(categoriesDepenses).where(and(eq(categoriesDepenses.id, parseInt(categorieId)), eq(categoriesDepenses.entrepriseId, req.entrepriseId))).limit(1);
    }

    if (!categorie) {
      [categorie] = await tx.select().from(categoriesDepenses).where(eq(categoriesDepenses.entrepriseId, req.entrepriseId)).limit(1);
    }

    if (!categorie) {
      [categorie] = await tx.insert(categoriesDepenses).values({
        entrepriseId: req.entrepriseId,
        nom: 'Divers',
        description: 'Dépenses courantes enregistrées depuis ComptaOrion Lite'
      }).returning();
    }
    
    const depense = await tx.insert(depenses).values({
      entrepriseId: req.entrepriseId,
      employeId: req.user.id,
      categorieId: categorie.id,
      montant: numericAmount,
      dateDepense: parsedDate,
      description: String(description).trim(),
      justificatifUrl,
      récurrente: récurrente || false,
      fréquenceRécurrence,
      statut: 'en_attente',
      montantApprouve: 0
    }).returning();

    // Créer demande d'approbation initiale
    await tx.insert(approvalsDepenses).values({
      entrepriseId: req.entrepriseId,
      depenseId: depense[0].id,
      etape: 'manager',
      statut: 'en_attente'
    });

    // Audit
    await tx.insert(auditLogs).values({
      entrepriseId: req.entrepriseId,
      userId: req.user.id,
      action: 'CREATE',
      table: 'depenses',
      recordId: depense[0].id,
      description: `Dépense créée: ${description} (${montant} FCFA)`,
      ipAddress
    });

    const body = depense[0];
    if (req.idempotencyKey) await tx.update(liteIdempotency).set({ status: 'completed', responseStatus: 200, responseBody: body, updatedAt: new Date() }).where(and(eq(liteIdempotency.entrepriseId, req.entrepriseId), eq(liteIdempotency.idempotencyKey, req.idempotencyKey)));
    return { replay: false, status: 200, body };
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/list', async (req, res) => {
  try {
    const { employeId } = req.query;
    const where = [eq(depenses.entrepriseId, req.entrepriseId)];
    if (employeId) where.push(eq(depenses.employeId, parseInt(employeId)));

    const depensesList = await db.query.depenses.findMany({
      where: and(...where)
    });
    res.json(depensesList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// WORKFLOW D'APPROBATION
// ==========================================

router.post('/approve/:depenseId/:etape', async (req, res) => {
  try {
    const { depenseId, etape } = req.params;
    const { statut, raison, userId } = req.body;
    const depenseId_int = parseInt(depenseId);

    const depense = await db.query.depenses.findFirst({
      where: eq(depenses.id, depenseId_int)
    });

    if (!depense) {
      return res.status(404).json({ error: 'Dépense non trouvée' });
    }

    // Mettre à jour approbation
    const approval = await db.update(approvalsDepenses).set({
      statut: statut, // approuvée, rejetée
      dateApprobation: new Date(),
      approbateurId: userId,
      raison
    }).where(
      and(
        eq(approvalsDepenses.depenseId, depenseId_int),
        eq(approvalsDepenses.etape, etape)
      )
    ).returning();

    // Si rejetée, changer statut dépense
    if (statut === 'rejetée') {
      await db.update(depenses).set({
        statut: 'rejetée'
      }).where(eq(depenses.id, depenseId_int));
      
      return res.json({ message: 'Dépense rejetée' });
    }

    // Déterminer prochaine étape
    let prochainEtape = null;
    if (etape === 'manager') prochainEtape = 'comptable';

    if (prochainEtape) {
      await db.insert(approvalsDepenses).values({
        entrepriseId: depense.entrepriseId,
        depenseId: depenseId_int,
        etape: prochainEtape,
        statut: 'en_attente'
      });
    } else {
      // Toutes les approbations terminées
      await db.update(depenses).set({
        statut: 'approuvée',
        montantApprouve: depense.montant
      }).where(eq(depenses.id, depenseId_int));
    }

    res.json({ message: `Dépense approuvée pour l'étape: ${etape}`, approval: approval[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// REMBOURSEMENT EMPLOYÉS
// ==========================================

router.post('/remboursement', async (req, res) => {
  try {
    const { entrepriseId, depenseId, montantRembourse, dateRemboursement, methodePaiement, userId } = req.body;

    const depense = await db.query.depenses.findFirst({
      where: eq(depenses.id, parseInt(depenseId))
    });

    if (!depense) {
      return res.status(404).json({ error: 'Dépense non trouvée' });
    }

    // Récupérer le nom de l'employé
    let employeNom = 'Employé';
    if (depense.employeId) {
      const employe = await db.query.employes.findFirst({
        where: eq(employes.id, depense.employeId)
      });
      if (employe) {
        employeNom = `${employe.prenom || ''} ${employe.nom || ''}`.trim();
      }
    }

    // Créer remboursement
    const remboursement = await db.insert(remboursementsEmployes).values({
      entrepriseId: parseInt(entrepriseId),
      depenseId: parseInt(depenseId),
      montantRembourse: parseFloat(montantRembourse),
      dateRemboursement: new Date(dateRemboursement),
      methodePaiement,
      statut: 'complété'
    }).returning();

    // Mettre à jour montant remboursé dans dépense
    const totalRembourse = (depense.montantRembourse || 0) + parseFloat(montantRembourse);
    await db.update(depenses).set({
      montantRembourse: totalRembourse,
      statut: totalRembourse >= depense.montantApprouve ? 'remboursée' : 'partiellement_remboursée'
    }).where(eq(depenses.id, parseInt(depenseId)));

    // Créer écriture comptable automatique
    try {
      await createEcritureDepense({
        entrepriseId: parseInt(entrepriseId),
        reference: `RMB-${remboursement[0].id}`,
        dateRemboursement: new Date(dateRemboursement),
        employeNom,
        description: depense.description || 'Dépense',
        montant: parseFloat(montantRembourse),
        modePaiement: methodePaiement === 'especes' ? 'especes' : 'virement',
        categorieCompte: '62'
      });
      console.log(`Écriture comptable créée pour remboursement dépense ${depenseId}`);
    } catch (comptaError) {
      console.error('Erreur création écriture comptable dépense:', comptaError.message);
    }

    res.json(remboursement[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// EXPORT EXCEL/CSV
// ==========================================

router.get('/export', async (req, res) => {
  try {
    const { entrepriseId, format = 'json' } = req.query;

    const dépensesList = await db.query.depenses.findMany({
      where: eq(depenses.entrepriseId, parseInt(entrepriseId))
    });

    if (format === 'csv') {
      const headers = 'Date,Employé,Catégorie,Montant,Description,Statut,Montant Remboursé\n';
      const rows = dépensesList.map(d =>
        `"${d.dateDepense}","${d.employeId}","${d.categorieId}","${d.montant}","${d.description}","${d.statut}","${d.montantRembourse || 0}"`
      ).join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="dépenses.csv"');
      res.send(headers + rows);
    } else {
      res.json(dépensesList);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
