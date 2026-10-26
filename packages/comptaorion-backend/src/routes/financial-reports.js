import express from 'express';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db.js';
import { comptesComptables, ecritures, lignesEcritures } from '../schema.js';
import { buildFinancialStatements } from '../services/financialStatements.js';

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

router.get('/', async (req, res) => {
  const entrepriseId = Number(req.entrepriseId);
  const dateDebut = req.query.dateDebut;
  const dateFin = req.query.dateFin;
  if (!Number.isInteger(entrepriseId) || entrepriseId < 1) {
    return res.status(401).json({ error: 'Entreprise non identifiée.' });
  }
  if (!validDate(dateDebut) || !validDate(dateFin) || dateDebut > dateFin) {
    return res.status(400).json({ error: 'La période doit contenir deux dates valides, dans le bon ordre.' });
  }

  try {
    const balanceRows = await db
      .select({
        numero: comptesComptables.numero,
        nom: comptesComptables.nom,
        debit: sql`COALESCE(SUM(${lignesEcritures.debit}), 0)`,
        credit: sql`COALESCE(SUM(${lignesEcritures.credit}), 0)`,
      })
      .from(lignesEcritures)
      .innerJoin(ecritures, eq(lignesEcritures.ecritureId, ecritures.id))
      .innerJoin(comptesComptables, eq(lignesEcritures.compteComptableId, comptesComptables.id))
      .where(and(
        eq(ecritures.entrepriseId, entrepriseId),
        eq(lignesEcritures.entrepriseId, entrepriseId),
        eq(comptesComptables.entrepriseId, entrepriseId),
        lte(ecritures.dateEcriture, dateFin),
      ))
      .groupBy(comptesComptables.id, comptesComptables.numero, comptesComptables.nom);

    const incomeRows = await db
      .select({
        numero: comptesComptables.numero,
        nom: comptesComptables.nom,
        debit: sql`COALESCE(SUM(${lignesEcritures.debit}), 0)`,
        credit: sql`COALESCE(SUM(${lignesEcritures.credit}), 0)`,
      })
      .from(lignesEcritures)
      .innerJoin(ecritures, eq(lignesEcritures.ecritureId, ecritures.id))
      .innerJoin(comptesComptables, eq(lignesEcritures.compteComptableId, comptesComptables.id))
      .where(and(
        eq(ecritures.entrepriseId, entrepriseId),
        eq(lignesEcritures.entrepriseId, entrepriseId),
        eq(comptesComptables.entrepriseId, entrepriseId),
        gte(ecritures.dateEcriture, dateDebut),
        lte(ecritures.dateEcriture, dateFin),
        sql`LEFT(${comptesComptables.numero}, 1) IN ('6', '7')`,
      ))
      .groupBy(comptesComptables.id, comptesComptables.numero, comptesComptables.nom);

    const entryRows = await db
      .select({
        valide: ecritures.valide,
        debit: sql`COALESCE(SUM(${lignesEcritures.debit}), 0)`,
        credit: sql`COALESCE(SUM(${lignesEcritures.credit}), 0)`,
      })
      .from(ecritures)
      .leftJoin(lignesEcritures, and(
        eq(lignesEcritures.ecritureId, ecritures.id),
        eq(lignesEcritures.entrepriseId, entrepriseId),
      ))
      .where(and(
        eq(ecritures.entrepriseId, entrepriseId),
        gte(ecritures.dateEcriture, dateDebut),
        lte(ecritures.dateEcriture, dateFin),
      ))
      .groupBy(ecritures.id, ecritures.valide);

    const quality = {
      nombreEcritures: entryRows.length,
      ecrituresNonValidees: entryRows.filter((row) => row.valide !== true).length,
      ecrituresNonEquilibrees: entryRows.filter((row) =>
        Math.abs(Number(row.debit) - Number(row.credit)) >= 0.01
      ).length,
    };

    return res.json(buildFinancialStatements({
      balanceRows,
      incomeRows,
      dateDebut,
      dateFin,
      quality,
    }));
  } catch (error) {
    console.error('Erreur de génération des états financiers:', error.message);
    return res.status(500).json({ error: 'Impossible de générer les états financiers pour le moment.' });
  }
});

export default router;
