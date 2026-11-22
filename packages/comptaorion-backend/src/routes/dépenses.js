import express from 'express';
import { db } from '../db.js';
import { depenses, categoriesDepenses, approvalsDepenses, remboursementsEmployes, auditLogs, employes, liteIdempotency, entreprises } from '../schema.js';
import { eq, and, gte, lte, desc, asc } from 'drizzle-orm';
import { createEcritureDepense, createEcritureDepenseLite } from '../services/comptabiliteService.js';
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
// CRUD EMPLOYÉS (annuaire pour les notes de frais)
// Seuls les champs simples sont exposés ici : les champs de paie
// (salaire, CNPS, indemnités, avantages en nature, documents) ne sont
// pas gérés par ce module et restent nullables dans la table.
// ==========================================

const EMPLOYE_SIMPLE_FIELDS = ['nom', 'prenom', 'telephone', 'email', 'poste', 'departement', 'matricule', 'dateEmbauche', 'typeContrat'];

function employePayload(body = {}) {
  const payload = {};
  for (const field of EMPLOYE_SIMPLE_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    payload[field] = value === '' ? null : value;
  }
  if (payload.nom !== undefined && payload.nom !== null) payload.nom = String(payload.nom).trim();
  if (payload.prenom !== undefined && payload.prenom !== null) payload.prenom = String(payload.prenom).trim();
  return payload;
}

function isUniqueViolation(error) {
  return error?.cause?.code === '23505' || error?.code === '23505';
}

router.get('/employes/list', async (req, res) => {
  try {
    const employesList = await db.query.employes.findMany({
      where: and(eq(employes.entrepriseId, req.entrepriseId), eq(employes.actif, true)),
      orderBy: [asc(employes.nom), asc(employes.prenom)],
    });
    res.json(employesList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/employes', async (req, res) => {
  try {
    const nom = String(req.body.nom || '').trim();
    const prenom = String(req.body.prenom || '').trim();
    if (!nom || !prenom) {
      return res.status(400).json({ error: 'Nom et prénom sont obligatoires.' });
    }
    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(employes).values({
        entrepriseId: req.entrepriseId,
        ...employePayload(req.body),
        nom,
        prenom,
      }).returning();
      await tx.insert(auditLogs).values({
        entrepriseId: req.entrepriseId,
        userId: req.user?.id || null,
        action: 'CREATE',
        tableName: 'employes',
        recordId: row.id,
        description: `Employé créé: ${prenom} ${nom}`,
      });
      return row;
    });
    res.status(201).json(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: 'Ce matricule est déjà utilisé par un autre employé.' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/employes/:id', async (req, res) => {
  try {
    const employeId = Number(req.params.id);
    if (!Number.isSafeInteger(employeId) || employeId <= 0) {
      return res.status(400).json({ error: 'Identifiant d’employé invalide.' });
    }
    const updates = employePayload(req.body);
    if (updates.nom === null || updates.prenom === null) {
      return res.status(400).json({ error: 'Nom et prénom ne peuvent pas être vides.' });
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à modifier.' });
    }
    const updated = await db.transaction(async (tx) => {
      const [previous] = await tx.select().from(employes).where(and(
        eq(employes.id, employeId),
        eq(employes.entrepriseId, req.entrepriseId),
      )).limit(1);
      if (!previous) throw Object.assign(new Error('Employé introuvable.'), { status: 404 });
      const [row] = await tx.update(employes).set(updates).where(and(
        eq(employes.id, employeId),
        eq(employes.entrepriseId, req.entrepriseId),
      )).returning();
      await tx.insert(auditLogs).values({
        entrepriseId: req.entrepriseId,
        userId: req.user?.id || null,
        action: 'UPDATE',
        tableName: 'employes',
        recordId: row.id,
        description: `Employé modifié: ${(row.prenom || '').trim()} ${(row.nom || '').trim()}`.trim(),
      });
      return row;
    });
    res.json(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: 'Ce matricule est déjà utilisé par un autre employé.' });
    }
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.delete('/employes/:id', async (req, res) => {
  try {
    const employeId = Number(req.params.id);
    if (!Number.isSafeInteger(employeId) || employeId <= 0) {
      return res.status(400).json({ error: 'Identifiant d’employé invalide.' });
    }
    const deactivated = await db.transaction(async (tx) => {
      const [previous] = await tx.select().from(employes).where(and(
        eq(employes.id, employeId),
        eq(employes.entrepriseId, req.entrepriseId),
        eq(employes.actif, true),
      )).limit(1);
      if (!previous) throw Object.assign(new Error('Employé introuvable.'), { status: 404 });
      const [row] = await tx.update(employes).set({ actif: false }).where(and(
        eq(employes.id, employeId),
        eq(employes.entrepriseId, req.entrepriseId),
      )).returning();
      await tx.insert(auditLogs).values({
        entrepriseId: req.entrepriseId,
        userId: req.user?.id || null,
        action: 'DELETE',
        tableName: 'employes',
        recordId: row.id,
        description: `Employé désactivé: ${(row.prenom || '').trim()} ${(row.nom || '').trim()}`.trim(),
      });
      return row;
    });
    res.json(deactivated);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ==========================================
// ENREGISTREMENT DÉPENSES
// ==========================================

export async function createExpense(req, res) {
  try {
    const { categorieId, montant, dateDepense, description, justificatifUrl, récurrente, fréquenceRécurrence, ipAddress } = req.body;
    const numericAmount = Number(montant);
    const parsedDate = dateDepense ? new Date(dateDepense) : new Date();
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || Number.isNaN(parsedDate.getTime()) || !String(description || '').trim()) {
      return res.status(400).json({ error: 'Montant, date et description sont obligatoires et doivent être valides' });
    }
    const isLiteExpense = req.isLiteExpense === true;
    const modePaiement = req.body.modePaiement || 'especes';
    if (isLiteExpense && !['especes', 'banque'].includes(modePaiement)) {
      return res.status(400).json({ error: 'Mode de paiement invalide' });
    }
    const result = await db.transaction(async (tx) => {
    // Shared by photo and ordinary writes so a photo review cannot race a
    // concurrent expense creation in this company. Other companies stay independent.
    await tx.select({ id: entreprises.id }).from(entreprises)
      .where(eq(entreprises.id, req.entrepriseId)).for('update');
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
    if (req.beforeCreateExpense) await req.beforeCreateExpense(tx);
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
      dateDepense: parsedDate.toISOString().slice(0, 10),
      description: String(description).trim(),
      justificatifUrl,
      récurrente: récurrente || false,
      fréquenceRécurrence,
      statut: isLiteExpense ? 'approuvée' : 'en_attente',
      montantApprouve: isLiteExpense ? numericAmount : 0
    }).returning();

    let ecritureComptable = null;
    if (isLiteExpense) {
      ecritureComptable = await createEcritureDepenseLite({
        entrepriseId: req.entrepriseId,
        reference: `LITE-EXP-${depense[0].id}`,
        dateDepense: depense[0].dateDepense,
        description: depense[0].description,
        montant: numericAmount,
        modePaiement,
        categorieNom: categorie?.nom || null,
        executor: tx
      });
    } else {
      // Les dépenses du workflow standard restent soumises aux approbations.
      await tx.insert(approvalsDepenses).values({
        entrepriseId: req.entrepriseId,
        depenseId: depense[0].id,
        etape: 'manager',
        statut: 'en_attente'
      });
    }

    // Audit
    await tx.insert(auditLogs).values({
      entrepriseId: req.entrepriseId,
      userId: req.user.id,
      action: 'CREATE',
      tableName: 'depenses',
      recordId: depense[0].id,
      description: `Dépense créée: ${description} (${montant} FCFA)`,
      ipAddress
    });

    const body = { ...depense[0], ecritureComptableId: ecritureComptable?.id || null };
    if (req.idempotencyKey) await tx.update(liteIdempotency).set({ status: 'completed', responseStatus: 200, responseBody: body, updatedAt: new Date() }).where(and(eq(liteIdempotency.entrepriseId, req.entrepriseId), eq(liteIdempotency.idempotencyKey, req.idempotencyKey)));
    return { replay: false, status: 200, body };
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ ...(status === 409 && error.details ? error.details : {}), error: status >= 500
      ? 'Impossible d’enregistrer la dépense. Le brouillon est conservé; réessayez.'
      : error.message });
  }
}
router.post('/create', createExpense);
router.post('/lite-create', (req, res) => {
  req.isLiteExpense = true;
  return createExpense(req, res);
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
