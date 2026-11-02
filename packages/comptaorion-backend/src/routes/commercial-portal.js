import express from 'express';
import { db } from '../db.js';
import { saasCommerciaux, saasClients, saasVentes, entreprises } from '../schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;

async function authenticateCommercial(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  const token = authHeader.split(' ')[1];
  try {
    if (!JWT_SECRET) return res.status(503).json({ error: 'Authentification commerciale non configurée.' });
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'commercial') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    const [account] = await db.select({
      id: saasCommerciaux.id,
      email: saasCommerciaux.email,
      actif: saasCommerciaux.actif,
    })
      .from(saasCommerciaux)
      .where(eq(saasCommerciaux.id, Number(decoded.id)))
      .limit(1);
    if (!account?.actif || account.email !== decoded.email) {
      return res.status(401).json({ error: 'Session commerciale expirée ou désactivée.' });
    }
    req.commercial = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Token invalide' });
  }
}

router.post('/login', async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const [commercial] = await db.select()
      .from(saasCommerciaux)
      .where(eq(saasCommerciaux.email, email.toLowerCase()))
      .limit(1);

    if (!commercial) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    if (!commercial.actif) {
      return res.status(403).json({ error: 'Compte désactivé' });
    }

    if (!commercial.passwordHash) {
      return res.status(400).json({ error: 'Mot de passe non configuré. Contactez l\'administrateur.' });
    }

    const isValidPassword = await bcrypt.compare(password, commercial.passwordHash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    if (!JWT_SECRET) return res.status(503).json({ error: 'Authentification commerciale non configurée.' });
    const token = jwt.sign(
      { 
        id: commercial.id, 
        email: commercial.email,
        nom: commercial.nom,
        prenom: commercial.prenom,
        type: 'commercial'
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      commercial: {
        id: commercial.id,
        nom: commercial.nom,
        prenom: commercial.prenom,
        email: commercial.email,
        region: commercial.region,
        commission: 10
      }
    });
  } catch (error) {
    console.error('Erreur login commercial:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/me', authenticateCommercial, async (req, res) => {
  try {
    const [commercial] = await db.select({
      id: saasCommerciaux.id,
      nom: saasCommerciaux.nom,
      prenom: saasCommerciaux.prenom,
      email: saasCommerciaux.email,
      telephone: saasCommerciaux.telephone,
      region: saasCommerciaux.region,
      commission: sql`10`,
      objectifMensuel: saasCommerciaux.objectifMensuel
    })
    .from(saasCommerciaux)
    .where(eq(saasCommerciaux.id, req.commercial.id))
    .limit(1);

    if (!commercial) {
      return res.status(404).json({ error: 'Commercial non trouvé' });
    }

    res.json(commercial);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/dashboard', authenticateCommercial, async (req, res) => {
  try {
    const commercialId = req.commercial.id;

    const clients = await db.select({
      id: saasClients.id,
      entrepriseNom: entreprises.nom,
      statut: saasClients.statut,
      dateInscription: saasClients.dateInscription,
      source: saasClients.source
    })
    .from(saasClients)
    .leftJoin(entreprises, eq(saasClients.entrepriseId, entreprises.id))
    .where(eq(saasClients.commercialId, commercialId))
    .orderBy(desc(saasClients.dateInscription));

    const ventes = await db.select({
      id: saasVentes.id,
      clientNom: entreprises.nom,
      montantVente: saasVentes.montantVente,
      commission: sql`CASE WHEN ${saasVentes.statut} = 'confirmée' THEN ROUND(${saasVentes.montantVente} * 0.10, 2) ELSE 0 END`,
      dateVente: saasVentes.dateVente,
      statut: saasVentes.statut
    })
    .from(saasVentes)
    .leftJoin(saasClients, eq(saasVentes.clientId, saasClients.id))
    .leftJoin(entreprises, eq(saasClients.entrepriseId, entreprises.id))
    .where(eq(saasVentes.commercialId, commercialId))
    .orderBy(desc(saasVentes.dateVente));

    const statsResult = await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM saas_clients WHERE commercial_id = ${commercialId})::int AS total_clients,
        (SELECT COUNT(*) FROM saas_clients WHERE commercial_id = ${commercialId} AND statut = 'actif')::int AS clients_actifs,
        COALESCE(SUM(montant_vente) FILTER (WHERE statut = 'confirmée'), 0)::numeric AS ca_total,
        COALESCE(SUM(ROUND(montant_vente * 0.10, 2)) FILTER (WHERE statut = 'confirmée'), 0)::numeric AS commissions_totales,
        COALESCE(SUM(montant_vente) FILTER (WHERE statut = 'confirmée' AND date_vente >= date_trunc('month', CURRENT_DATE)), 0)::numeric AS ca_mois,
        COALESCE(SUM(ROUND(montant_vente * 0.10, 2)) FILTER (WHERE statut = 'confirmée' AND date_vente >= date_trunc('month', CURRENT_DATE)), 0)::numeric AS commissions_mois
      FROM saas_ventes
      WHERE commercial_id = ${commercialId}
    `);
    const stats = statsResult.rows?.[0] || statsResult[0] || {};

    res.json({
      stats: stats || {},
      clients,
      ventes,
      lienParrainage: `/?ref=${commercialId}`
    });
  } catch (error) {
    console.error('Erreur dashboard commercial:', error);
    res.status(500).json({ error: error.message });
  }
});

function reportPeriod(req, res) {
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const defaultFrom = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const from = String(req.query.from || defaultFrom);
  const to = String(req.query.to || defaultTo);
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if (!validDate(from) || !validDate(to) || from > to) {
    res.status(400).json({ error: 'Période invalide. Utilisez des dates AAAA-MM-JJ.' });
    return null;
  }
  return { from, to };
}

router.get('/reports', authenticateCommercial, async (req, res) => {
  const period = reportPeriod(req, res);
  if (!period) return;
  try {
    const commercialId = Number(req.commercial.id);
    const [salesResult, clientCountResult] = await Promise.all([
      db.select({
        id: saasVentes.id,
        clientNom: entreprises.nom,
        montantVente: saasVentes.montantVente,
        commission: sql`CASE WHEN ${saasVentes.statut} = 'confirmée' THEN ROUND(${saasVentes.montantVente} * 0.10, 2) ELSE 0 END`,
        dateVente: saasVentes.dateVente,
        statut: saasVentes.statut,
      })
        .from(saasVentes)
        .leftJoin(saasClients, eq(saasVentes.clientId, saasClients.id))
        .leftJoin(entreprises, eq(saasClients.entrepriseId, entreprises.id))
        .where(sql`${saasVentes.commercialId} = ${commercialId}
          AND ${saasVentes.dateVente} >= ${period.from}::date
          AND ${saasVentes.dateVente} < (${period.to}::date + interval '1 day')`)
        .orderBy(desc(saasVentes.dateVente)),
      db.execute(sql`
        SELECT COUNT(*)::int AS clients
        FROM saas_clients
        WHERE commercial_id = ${commercialId}
          AND date_inscription >= ${period.from}::date
          AND date_inscription < (${period.to}::date + interval '1 day')
      `),
    ]);
    const confirmed = salesResult.filter((sale) => sale.statut === 'confirmée');
    const clientCount = clientCountResult.rows?.[0] || clientCountResult[0] || {};
    const stats = {
      clients: Number(clientCount.clients || 0),
      ventes: salesResult.length,
      ca: confirmed.reduce((sum, sale) => sum + Number(sale.montantVente || 0), 0),
      commissions: confirmed.reduce((sum, sale) => sum + Number(sale.commission || 0), 0),
    };
    res.json({ period, stats, ventes: salesResult });
  } catch (error) {
    req.log?.error({ err: error }, 'Erreur rapport commercial');
    res.status(500).json({ error: 'Impossible de générer le rapport commercial.' });
  }
});

export default router;
