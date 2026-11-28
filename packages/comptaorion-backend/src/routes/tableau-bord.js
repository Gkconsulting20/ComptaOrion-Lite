// Tableau de bord Lite en UNE requête (28 nov. 2026, performance).
//
// Au démarrage, LiteApp chargeait 5 listes en parallèle
// (/clients, /factures, /produits, /depenses/list, /factures/lite-day) :
// 5 requêtes Worker, 5 ouvertures de connexion Neon, 5 passages dans les
// middlewares d'authentification et d'essai — 2,1 à 3,1 s par appel en live,
// ~3,3 s pour le lot. Cet endpoint regroupe les 5 lectures en une seule
// requête (7 lectures base, en Promise.all sur le même pool, sans les
// COUNT de pagination — le tableau de bord n'utilise que les listes).
//
// Les requêtes sont les COPIES exactes de celles des routes d'origine
// (mêmes sélections, mêmes tris, mêmes limites) : la réponse reprend
// leurs enveloppes, pour que le frontend mappe les données à l'identique.
// Les routes d'origine restent montées (les autres pages les utilisent).
import express from 'express';
import { db } from '../db.js';
import {
  clients, produits, depenses, factures, paiements, entreprises,
} from '../schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';

const router = express.Router();

// Assemblage pur (testable sans base) : mêmes enveloppes que les routes
// d'origine, pour que LiteApp réutilise son mapping existant.
export function assemblerTableauBord({ clientsList, facturesList, produitsList, depensesList, jour }) {
  return {
    success: true,
    clients: { success: true, count: clientsList.length, data: clientsList },
    factures: { success: true, count: facturesList.length, data: facturesList },
    produits: { success: true, count: produitsList.length, data: produitsList },
    depenses: depensesList,
    jour,
  };
}

// Totaux légers du jour — mêmes 3 lectures que GET /factures/lite-day.
async function chargerJour(entrepriseId, date) {
  const [company] = await db
    .select({ tauxTva: entreprises.tauxTva })
    .from(entreprises)
    .where(eq(entreprises.id, entrepriseId))
    .limit(1);
  const [sales] = await db
    .select({
      total: sql`COALESCE(SUM(${factures.totalTTC}), 0)`,
      count: sql`COUNT(*)::int`,
    })
    .from(factures)
    .where(and(
      eq(factures.entrepriseId, entrepriseId),
      eq(factures.dateFacture, date),
      sql`${factures.statut} <> 'annulee'`,
    ));
  const [payments] = await db
    .select({
      total: sql`COALESCE(SUM(${paiements.montant}), 0)`,
      count: sql`COUNT(*)::int`,
    })
    .from(paiements)
    .where(and(
      eq(paiements.entrepriseId, entrepriseId),
      eq(paiements.datePaiement, date),
    ));
  return {
    date,
    ventes: Number(sales?.total || 0),
    nombreVentes: Number(sales?.count || 0),
    encaissements: Number(payments?.total || 0),
    nombrePaiements: Number(payments?.count || 0),
    tauxTva: Number(company?.tauxTva ?? 18),
  };
}

// GET /api/tableau-bord?limit=100&date=YYYY-MM-DD
router.get('/', async (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, message: 'Date invalide' });
  }
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 100));
  try {
    const [clientsList, facturesList, produitsList, depensesList, jour] = await Promise.all([
      db.select().from(clients)
        .where(eq(clients.entrepriseId, req.entrepriseId))
        .orderBy(desc(clients.createdAt))
        .limit(limit),
      db.select({
        facture: factures,
        client: {
          id: clients.id,
          nom: clients.nom,
          email: clients.email,
          telephone: clients.telephone,
        },
      })
        .from(factures)
        .leftJoin(clients, eq(factures.clientId, clients.id))
        .where(eq(factures.entrepriseId, req.entrepriseId))
        .orderBy(desc(factures.createdAt))
        .limit(limit),
      db.select().from(produits)
        .where(eq(produits.entrepriseId, req.entrepriseId))
        .orderBy(desc(produits.createdAt))
        .limit(limit),
      db.query.depenses.findMany({
        where: eq(depenses.entrepriseId, req.entrepriseId),
      }),
      chargerJour(req.entrepriseId, date),
    ]);
    res.json(assemblerTableauBord({ clientsList, facturesList, produitsList, depensesList, jour }));
  } catch (error) {
    console.error('Erreur GET /api/tableau-bord:', error);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement du tableau de bord' });
  }
});

export default router;
