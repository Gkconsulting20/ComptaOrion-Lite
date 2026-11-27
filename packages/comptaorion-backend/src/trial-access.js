import { eq } from 'drizzle-orm';
import { db } from './db.js';
import { saasClients } from './schema.js';

export const TRIAL_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const OWNER_EMAIL = (process.env.SAAS_PLATFORM_OWNER_EMAIL || 'admin@orionexa.com').trim().toLowerCase();

export function getTrialEnd(dateInscription) {
  const start = new Date(dateInscription);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + TRIAL_DURATION_MS);
}

export function evaluateSaasAccess(client, now = new Date()) {
  if (!client) return { allowed: false, code: 'ACCESS_NOT_CONFIGURED' };
  if (client.statut === 'actif') return { allowed: true, status: 'actif', trialEndsAt: null };
  if (client.statut !== 'trial') {
    return { allowed: false, code: 'ACCOUNT_INACTIVE' };
  }

  const trialEndsAt = getTrialEnd(client.dateInscription);
  if (!trialEndsAt) return { allowed: false, code: 'TRIAL_DATE_INVALID' };
  if (now.getTime() >= trialEndsAt.getTime()) {
    return { allowed: false, code: 'TRIAL_EXPIRED', trialEndsAt: trialEndsAt.toISOString() };
  }
  return { allowed: true, status: 'trial', trialEndsAt: trialEndsAt.toISOString() };
}

export async function getSaasAccess(entrepriseId, user = {}, now = new Date()) {
  const email = String(user.email || '').trim().toLowerCase();
  if (user.role === 'admin' && email === OWNER_EMAIL) {
    return { allowed: true, status: 'platform-owner', trialEndsAt: null };
  }

  let [client] = await db.select().from(saasClients)
    .where(eq(saasClients.entrepriseId, Number(entrepriseId)))
    .limit(1);

  // Existing organizations that predate SaaS tracking receive a single
  // 30-day trial from their first authenticated request after this rollout.
  if (!client) {
    await db.insert(saasClients).values({
      entrepriseId: Number(entrepriseId),
      statut: 'trial',
      source: 'legacy',
    }).onConflictDoNothing();
    [client] = await db.select().from(saasClients)
      .where(eq(saasClients.entrepriseId, Number(entrepriseId)))
      .limit(1);
  }

  return evaluateSaasAccess(client, now);
}

export async function trialAccessMiddleware(req, res, next) {
  try {
    const access = await getSaasAccess(req.user?.entrepriseId, req.user);
    if (access.allowed) {
      req.saasAccess = access;
      return next();
    }

    if (access.code === 'TRIAL_EXPIRED') {
      return res.status(403).json({
        code: access.code,
        error: 'La période d’essai est terminée. Contactez ComptaOrion pour réactiver votre accès.',
        trialEndsAt: access.trialEndsAt,
      });
    }
    if (access.code === 'ACCOUNT_INACTIVE') {
      return res.status(403).json({
        code: access.code,
        error: 'Cet espace est suspendu ou désactivé. Contactez ComptaOrion.',
      });
    }
    return res.status(403).json({
      code: access.code || 'ACCESS_NOT_CONFIGURED',
      error: 'Impossible de vérifier l’accès à cet espace. Contactez ComptaOrion.',
    });
  } catch (error) {
    console.error('Échec de vérification de la période d’essai:', error.message);
    return res.status(503).json({
      code: 'ACCESS_CHECK_UNAVAILABLE',
      error: 'La vérification de l’accès est temporairement indisponible. Réessayez.',
    });
  }
}

