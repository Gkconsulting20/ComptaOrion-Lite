// Bilan après clôture d'exercice (ComptaOrioLite).
//
// Problème : GET /financial-reports calculait les soldes du bilan en
// cumulant TOUTES les écritures valides jusqu'à dateFin, sans borne
// inférieure. Après une clôture, les écritures d'avant-clôture ET
// l'écriture d'ouverture à nouveaux (AN-{année+1}-*) qui les reprend
// étaient donc comptées deux fois — exercice 2026, entreprise test 13 :
// bilan janv. 2027 = 3 824 000 = 2 × 1 912 000 (caisse 3 581 600 au lieu
// de 1 790 800, capital 400 000 au lieu de 200 000, résultat 120 doublé).
//
// Correction — même principe que le correctif 7d13ac1 de ComptaOrion,
// adapté à Lite : Lite n'a pas de table clotures_exercices, l'état
// (clôturé / réouvert) est déduit des écritures elles-mêmes (voir
// routes/cloture-exercice.js). Les soldes repartent donc de la DERNIÈRE
// ouverture à nouveaux ACTIVE : la plus récente écriture AN-{année}-NNN
// non contrepassée (aucune écriture AN-{année}-NNN-R). Les soldes sont
// alors les lignes de cette écriture d'ouverture + celles des écritures
// datées STRICTEMENT après elle. Sans ouverture active (jamais clôturé,
// ou exercice réouvert — la contrepassation annule l'ouverture), le
// comportement est inchangé : toutes les lignes jusqu'à dateFin.
//
// Cas limite (identique à ComptaOrion) : une écriture ordinaire datée du
// jour même de l'ouverture (1er janvier) est exclue des soldes.

import { and, desc, eq, like, lte } from 'drizzle-orm';
import { ecritures } from '../schema.js';

/** Normalise une date (chaîne 'YYYY-MM-DD' ou Date) en 'YYYY-MM-DD'. */
export function toDateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

const NUMERO_OUVERTURE_RE = /^AN-\d{4}-\d+$/;

/**
 * Dernière ouverture à nouveaux ACTIVE parmi des écritures AN-*.
 * Entrées attendues : [{ id, numeroEcriture, dateEcriture }], dans
 * n'importe quel ordre. Une ouverture est active si aucune écriture
 * AN-{année}-NNN-R (contrepassation de réouverture) ne la concerne.
 * Retourne { ecritureOuvertureId, dateEcriture } ou null.
 */
export function selectActiveOpening(entries) {
  const rows = [...(entries || [])];
  const numeros = new Set(rows.map((row) => String(row.numeroEcriture || '')));
  const candidates = rows
    .filter((row) => NUMERO_OUVERTURE_RE.test(String(row.numeroEcriture || '')))
    .filter((row) => !numeros.has(`${row.numeroEcriture}-R`))
    .sort((a, b) => {
      const byDate = toDateOnly(b.dateEcriture).localeCompare(toDateOnly(a.dateEcriture));
      if (byDate !== 0) return byDate;
      return String(b.numeroEcriture).localeCompare(String(a.numeroEcriture));
    });
  const [latest] = candidates;
  if (!latest || !latest.id || !latest.dateEcriture) return null;
  return { ecritureOuvertureId: latest.id, dateEcriture: latest.dateEcriture };
}

/**
 * Dernière ouverture à nouveaux ACTIVE pour l'entreprise, datée au plus
 * tard à dateFin (sans quoi elle ne concerne pas la période demandée).
 * Retourne { ecritureOuvertureId, dateEcriture } ou null.
 */
export async function findLatestActiveOpening(executor, entrepriseId, dateFin) {
  if (!Number.isSafeInteger(entrepriseId) || entrepriseId <= 0) return null;
  const conditions = [
    eq(ecritures.entrepriseId, entrepriseId),
    like(ecritures.numeroEcriture, 'AN-%'),
  ];
  if (dateFin) {
    conditions.push(lte(ecritures.dateEcriture, new Date(dateFin)));
  }
  const rows = await executor
    .select({
      id: ecritures.id,
      numeroEcriture: ecritures.numeroEcriture,
      dateEcriture: ecritures.dateEcriture,
    })
    .from(ecritures)
    .where(and(...conditions))
    .orderBy(desc(ecritures.dateEcriture), desc(ecritures.numeroEcriture));
  const opening = selectActiveOpening(rows);
  if (!opening) return null;
  if (dateFin && toDateOnly(opening.dateEcriture) > toDateOnly(dateFin)) return null;
  return opening;
}
