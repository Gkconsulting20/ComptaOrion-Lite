// Vérification de l'adresse e-mail par code à 6 chiffres (28 nov. 2026).
// Design validé par Cap le 27 nov. 2026, miroir de ComptaOrion :
// - code à 6 chiffres (crypto.randomInt), stocké HASHÉ SHA-256 uniquement,
//   un seul code actif par utilisateur ;
// - validité 15 minutes ; 5 tentatives max puis code invalidé ;
//   3 codes invalidés d'affilée → blocage 1 heure pour cet e-mail ;
// - renvoi après 60 s minimum, max 3 renvois / heure / e-mail ;
// - réponses génériques (ne jamais révéler si l'e-mail existe) ;
// - l'essai de 30 jours démarre À LA VÉRIFICATION (saas_clients.
//   date_inscription est réinitialisée à ce moment-là — Lite n'a pas
//   d'abonnement d'essai séparé, l'essai vit dans saas_clients) ;
// - comptes existants considérés vérifiés (backfill) ; comptes ORIONEXA
//   (entreprise 1) jamais bloqués ; démos exclues par construction
//   (aucune vérification n'est demandée pour une entreprise démo).
import crypto from 'node:crypto';
import { db } from '../db.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { emailVerificationCodes, entreprises, saasClients, users } from '../schema.js';
import { TRIAL_DURATION_MS, getTrialEnd } from '../trial-access.js';

export const CODE_TTL_MS = 15 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_MAX_INVALIDATED_IN_A_ROW = 3;
export const CODE_BLOCK_MS = 60 * 60 * 1000;
export const RESEND_MIN_INTERVAL_MS = 60 * 1000;
export const RESEND_MAX_PER_HOUR = 3;
export const UNVERIFIED_PURGE_DAYS = 7;

// ---------------------------------------------------------------------------
// Fonctions pures (testées sans base)
// ---------------------------------------------------------------------------

/** Code à 6 chiffres, zéros initiaux conservés (ex. « 042817 »). */
export function generateVerificationCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** Empreinte SHA-256 hex du code — seul le hash est persisté. */
export function hashVerificationCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/** Comparaison à temps constant entre le code saisi et le hash stocké. */
export function matchesCodeHash(code, codeHash) {
  const candidate = hashVerificationCode(code);
  const a = Buffer.from(candidate);
  const b = Buffer.from(String(codeHash || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isCodeExpired(codeRow, now = new Date()) {
  return new Date(codeRow.expiresAt).getTime() <= now.getTime();
}

/**
 * Blocage après 3 codes invalidés d'affilée pour un même e-mail.
 * `codesDesc` : lignes de cet e-mail triées par createdAt décroissant.
 * Retourne la fin du blocage (Date) ou null. Un code utilisé ou actif
 * interrompt la série ; un blocage expiré ne compte plus.
 */
export function computeBlockedUntil(codesDesc, now = new Date()) {
  let consecutive = 0;
  let thirdInvalidatedAt = null;
  for (const code of codesDesc || []) {
    if (code.statut === 'invalide') {
      consecutive += 1;
      if (consecutive === CODE_MAX_INVALIDATED_IN_A_ROW) {
        thirdInvalidatedAt = new Date(code.invalidatedAt || code.updatedAt || code.createdAt);
      }
      continue;
    }
    break;
  }
  if (!thirdInvalidatedAt || !Number.isFinite(thirdInvalidatedAt.getTime())) return null;
  const blockedUntil = new Date(thirdInvalidatedAt.getTime() + CODE_BLOCK_MS);
  return blockedUntil.getTime() > now.getTime() ? blockedUntil : null;
}

/**
 * Règles de renvoi. `createdLastHour` : nombre de codes créés pour cet
 * e-mail dans la dernière heure ; `lastCreatedAt` : création du dernier.
 */
export function checkResendAllowed({ lastCreatedAt, createdLastHour, now = new Date() }) {
  if (lastCreatedAt) {
    const elapsed = now.getTime() - new Date(lastCreatedAt).getTime();
    if (elapsed < RESEND_MIN_INTERVAL_MS) {
      return {
        allowed: false,
        reason: 'trop-tot',
        retryAfterSeconds: Math.ceil((RESEND_MIN_INTERVAL_MS - elapsed) / 1000),
      };
    }
  }
  if (Number(createdLastHour) >= RESEND_MAX_PER_HOUR) {
    return { allowed: false, reason: 'limite-horaire', retryAfterSeconds: 3600 };
  }
  return { allowed: true, reason: 'ok', retryAfterSeconds: 0 };
}

// ---------------------------------------------------------------------------
// Accès base
// ---------------------------------------------------------------------------

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export async function findUserByEmail(executor, email) {
  const [user] = await executor.select().from(users)
    .where(sql`LOWER(${users.email}) = ${normalizeEmail(email)}`)
    .limit(1);
  return user || null;
}

export async function getActiveCode(executor, userId) {
  const [code] = await executor.select().from(emailVerificationCodes)
    .where(and(
      eq(emailVerificationCodes.userId, userId),
      eq(emailVerificationCodes.statut, 'actif'),
    ))
    .orderBy(desc(emailVerificationCodes.createdAt))
    .limit(1);
  return code || null;
}

async function getRecentCodesForEmail(executor, email, limit = 10) {
  return executor.select().from(emailVerificationCodes)
    .where(eq(emailVerificationCodes.email, normalizeEmail(email)))
    .orderBy(desc(emailVerificationCodes.createdAt))
    .limit(limit);
}

/**
 * Crée un code pour l'utilisateur : les codes actifs précédents sont
 * marqués « remplace » (un seul code actif par utilisateur). Retourne
 * le code en clair (à envoyer par e-mail, jamais à persister) et la ligne.
 */
export async function createVerificationCode(executor = db, { userId, email, now = new Date() }) {
  const normalized = normalizeEmail(email);
  await executor.update(emailVerificationCodes)
    .set({ statut: 'remplace', updatedAt: now })
    .where(and(
      eq(emailVerificationCodes.userId, userId),
      eq(emailVerificationCodes.statut, 'actif'),
    ));
  const code = generateVerificationCode();
  const [record] = await executor.insert(emailVerificationCodes).values({
    userId,
    email: normalized,
    codeHash: hashVerificationCode(code),
    statut: 'actif',
    tentatives: 0,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    createdAt: now,
    updatedAt: now,
  }).returning();
  return { code, record };
}

/** Fin du blocage éventuel pour cet e-mail (null si aucun blocage actif). */
export async function getBlockedUntilForEmail(executor = db, email, now = new Date()) {
  const codes = await getRecentCodesForEmail(executor, email);
  return computeBlockedUntil(codes, now);
}

/** État de renvoi pour un e-mail : dernier code créé + codes créés < 1 h. */
export async function getResendState(executor = db, email, now = new Date()) {
  const rows = await executor.select({
    createdAt: emailVerificationCodes.createdAt,
  }).from(emailVerificationCodes)
    .where(eq(emailVerificationCodes.email, normalizeEmail(email)))
    .orderBy(desc(emailVerificationCodes.createdAt))
    .limit(10);
  const hourAgo = now.getTime() - 60 * 60 * 1000;
  return {
    lastCreatedAt: rows[0]?.createdAt || null,
    createdLastHour: rows.filter((row) => new Date(row.createdAt).getTime() >= hourAgo).length,
  };
}

/**
 * Vérifie un code saisi. Ne révèle jamais si l'e-mail existe : l'appelant
 * traduit tous les échecs par le même message générique.
 * Retourne { ok, reason, attemptsLeft, blockedUntil }.
 */
export async function verifyEmailCode(executor = db, { user, code, now = new Date() }) {
  const blockedUntil = await getBlockedUntilForEmail(executor, user.email, now);
  if (blockedUntil) return { ok: false, reason: 'bloque', blockedUntil, attemptsLeft: 0 };

  const active = await getActiveCode(executor, user.id);
  if (!active) return { ok: false, reason: 'aucun-code', attemptsLeft: 0 };

  if (isCodeExpired(active, now)) {
    await executor.update(emailVerificationCodes)
      .set({ statut: 'expire', updatedAt: now })
      .where(eq(emailVerificationCodes.id, active.id));
    return { ok: false, reason: 'expire', attemptsLeft: 0 };
  }

  if (!/^\d{6}$/.test(String(code || '')) || !matchesCodeHash(code, active.codeHash)) {
    const attempts = Number(active.tentatives || 0) + 1;
    const exhausted = attempts >= CODE_MAX_ATTEMPTS;
    await executor.update(emailVerificationCodes)
      .set({
        tentatives: attempts,
        statut: exhausted ? 'invalide' : 'actif',
        invalidatedAt: exhausted ? now : null,
        updatedAt: now,
      })
      .where(eq(emailVerificationCodes.id, active.id));
    return {
      ok: false,
      reason: exhausted ? 'tentatives-epuisees' : 'code-invalide',
      attemptsLeft: Math.max(0, CODE_MAX_ATTEMPTS - attempts),
    };
  }

  await executor.update(emailVerificationCodes)
    .set({ statut: 'utilise', usedAt: now, updatedAt: now })
    .where(eq(emailVerificationCodes.id, active.id));
  return { ok: true, reason: 'ok', attemptsLeft: CODE_MAX_ATTEMPTS };
}

/**
 * Marque l'e-mail vérifié ET démarre l'essai de 30 jours à cet instant :
 * la date d'inscription SaaS (qui porte l'essai Lite) est réinitialisée
 * sur la vérification — uniquement pour un client en essai (« trial ») ;
 * un client déjà payant (« actif ») garde sa date. Retourne la fin
 * d'essai recalculée (ou null si l'entreprise n'est pas en essai).
 */
export async function markEmailVerifiedAndStartTrial(executor = db, { user, now = new Date() }) {
  await executor.update(users)
    .set({ emailVerifiedAt: now, updatedAt: now })
    .where(eq(users.id, user.id));
  const trialExpiresAt = getTrialEnd(now);
  await executor.update(saasClients)
    .set({ dateInscription: now, updatedAt: now })
    .where(and(
      eq(saasClients.entrepriseId, user.entrepriseId),
      eq(saasClients.statut, 'trial'),
    ));
  return { emailVerifiedAt: now, trialExpiresAt };
}

/**
 * Corrige l'adresse e-mail d'un compte non vérifié (avant un renvoi) :
 * met à jour l'utilisateur et l'entreprise. Refuse si la nouvelle
 * adresse est déjà utilisée par un autre compte.
 */
export async function correctUnverifiedEmail(executor = db, { user, newEmail }) {
  const normalized = normalizeEmail(newEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { ok: false, reason: 'email-invalide' };
  }
  const existing = await findUserByEmail(executor, normalized);
  if (existing && existing.id !== user.id) return { ok: false, reason: 'email-deja-utilise' };
  if (user.emailVerifiedAt) return { ok: false, reason: 'deja-verifie' };
  await executor.update(users)
    .set({ email: normalized, updatedAt: new Date() })
    .where(eq(users.id, user.id));
  await executor.update(entreprises)
    .set({ email: normalized, updatedAt: new Date() })
    .where(eq(entreprises.id, user.entrepriseId));
  return { ok: true, email: normalized };
}

/** Le compte doit-il être bloqué tant que l'e-mail n'est pas vérifié ? */
export function isEmailVerificationRequired(user, { isDemoEntreprise = false } = {}) {
  if (!user) return false;
  if (user.emailVerifiedAt) return false;
  // Comptes ORIONEXA (entreprise 1 : admin plateforme et Cap) : jamais bloqués.
  if (Number(user.entrepriseId) === 1) return false;
  // Démos exclues par construction : jamais de vérification.
  if (isDemoEntreprise) return false;
  return true;
}

// Ré-exporté pour les tests (durée d'essai Lite : 30 jours).
export { TRIAL_DURATION_MS };
