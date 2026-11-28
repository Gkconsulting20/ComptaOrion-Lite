// Cycle de vie des entreprises — purge des démos et des essais expirés
// (ComptaOrioLite, décisions Cap 27 nov. 2026).
//
// Cycle confirmé : 30 jours d'essai → compte bloqué → 30 jours de
// blocage → suppression définitive. Démos : purge après 7 jours.
// Les durées sont des paramètres (table parametres_plateforme, repli
// variable d'environnement, puis défaut). La suppression réelle est
// GATED par trial_purge_enabled (défaut false) : tant que le paramètre
// est à false, le job tourne en dry-run (sélection + journalisation
// seulement, aucune suppression réelle).
//
// Gardes (§6.3, adaptées Lite) : jamais l'entreprise 1 (ORIONEXA),
// jamais une démo dans la purge des essais, jamais sans ligne
// saasClients (cas signalé, non supprimé), statut 'trial' uniquement,
// date_inscription non nulle, défense : exclure s'il existe un
// abonnement payant actif ou une facture d'abonnement payée.
// Re-vérification ligne par ligne avec SELECT ... FOR UPDATE dans la
// transaction de suppression ; LIMIT 50 par exécution.

import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { TRIAL_DURATION_MS } from '../trial-access.js';
import { UNVERIFIED_PURGE_DAYS } from './emailVerification.js';

export const PLATFORM_OWNER_ENTREPRISE_ID = 1;
export const PURGE_LIMIT_PER_RUN = 50;
export const DEMO_RATE_LIMIT_PER_DAY = 5;
const UNVERIFIED_MOTIF = 'email_non_verifie';

const DEFAULTS = {
  trial_deletion_delay_days: 30,
  demo_retention_days: 7,
  trial_purge_enabled: false,
};

function parseDelayDays(raw, fallback) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function parseEnabled(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return String(raw).trim().toLowerCase() === 'true';
}

// Lecture des paramètres : table d'abord, sinon variable
// d'environnement, sinon défaut. Une valeur invalide → défaut + avertissement.
export async function getPlatformParams(executor = db) {
  const params = { ...DEFAULTS };
  try {
    const rows = await executor.execute(
      sql`SELECT cle, valeur FROM parametres_plateforme`,
    );
    const list = rows?.rows || rows || [];
    for (const row of list) {
      if (row.cle === 'trial_deletion_delay_days') {
        params.trial_deletion_delay_days = parseDelayDays(row.valeur, DEFAULTS.trial_deletion_delay_days);
      } else if (row.cle === 'demo_retention_days') {
        params.demo_retention_days = parseDelayDays(row.valeur, DEFAULTS.demo_retention_days);
      } else if (row.cle === 'trial_purge_enabled') {
        params.trial_purge_enabled = parseEnabled(row.valeur, DEFAULTS.trial_purge_enabled);
      }
    }
  } catch (error) {
    // Table absente (base antérieure à la migration) : on continue avec
    // les variables d'environnement puis les défauts.
    console.warn('Lecture parametres_plateforme impossible, défauts appliqués:', error?.message || error);
  }
  if (process.env.TRIAL_DELETION_DELAY_DAYS !== undefined) {
    params.trial_deletion_delay_days = parseDelayDays(process.env.TRIAL_DELETION_DELAY_DAYS, params.trial_deletion_delay_days);
  }
  if (process.env.DEMO_RETENTION_DAYS !== undefined) {
    params.demo_retention_days = parseDelayDays(process.env.DEMO_RETENTION_DAYS, params.demo_retention_days);
  }
  if (process.env.TRIAL_PURGE_ENABLED !== undefined) {
    params.trial_purge_enabled = parseEnabled(process.env.TRIAL_PURGE_ENABLED, params.trial_purge_enabled);
  }
  return params;
}

export async function setPlatformParam(cle, valeur, updatedBy = null, executor = db) {
  const allowed = ['trial_deletion_delay_days', 'demo_retention_days', 'trial_purge_enabled'];
  if (!allowed.includes(cle)) throw Object.assign(new Error(`Paramètre inconnu : ${cle}`), { status: 400 });
  if (cle === 'trial_purge_enabled') {
    if (!['true', 'false'].includes(String(valeur).trim().toLowerCase())) {
      throw Object.assign(new Error('trial_purge_enabled doit être true ou false.'), { status: 400 });
    }
  } else {
    const days = parseDelayDays(valeur, -1);
    if (days < 0 || days > 3650) throw Object.assign(new Error('Le délai doit être un nombre de jours entre 0 et 3650.'), { status: 400 });
  }
  const [row] = await executor.execute(sql`
    INSERT INTO parametres_plateforme (cle, valeur, updated_at, updated_by)
    VALUES (${cle}, ${String(valeur)}, now(), ${updatedBy})
    ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur, updated_at = now(), updated_by = EXCLUDED.updated_by
    RETURNING cle, valeur, updated_at, updated_by
  `).then((r) => r?.rows || r || []);
  return row;
}

// ---------------------------------------------------------------------------
// Éligibilité (fonction pure, testée par la matrice §6.3)
// ---------------------------------------------------------------------------
// candidate : { entrepriseId, isDemo, saasClient: {statut, dateInscription} | null,
//               hasPaidSubscription, hasPaidSubscriptionInvoice }
// Retour : { eligible: boolean, motif: 'demo_expiree' | 'essai_expire_non_converti' | null,
//            reason: string|null, orphan: boolean }
export function classifyPurgeCandidate(candidate, params, now = new Date()) {
  const { entrepriseId, isDemo, saasClient, hasPaidSubscription, hasPaidSubscriptionInvoice } = candidate;
  if (entrepriseId === PLATFORM_OWNER_ENTREPRISE_ID) {
    return { eligible: false, motif: null, reason: 'entreprise_plateforme', orphan: false };
  }
  if (isDemo) {
    const createdAt = candidate.createdAt ? new Date(candidate.createdAt) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) {
      return { eligible: false, motif: null, reason: 'demo_sans_date_creation', orphan: false };
    }
    const ageMs = now.getTime() - createdAt.getTime();
    if (ageMs >= params.demo_retention_days * 24 * 60 * 60 * 1000) {
      return { eligible: true, motif: 'demo_expiree', reason: null, orphan: false };
    }
    return { eligible: false, motif: null, reason: 'demo_trop_recente', orphan: false };
  }
  // Essai : jamais sans ligne saasClients (pas de date d'inscription fiable).
  if (!saasClient) {
    return { eligible: false, motif: null, reason: 'sans_ligne_saas_clients', orphan: true };
  }
  if (saasClient.source === 'demo') {
    return { eligible: false, motif: null, reason: 'source_demo_sans_drapeau', orphan: false };
  }
  if (saasClient.statut !== 'trial') {
    return { eligible: false, motif: null, reason: `statut_${saasClient.statut}`, orphan: false };
  }
  if (!saasClient.dateInscription) {
    return { eligible: false, motif: null, reason: 'date_inscription_absente', orphan: true };
  }
  if (hasPaidSubscription || hasPaidSubscriptionInvoice) {
    return { eligible: false, motif: null, reason: 'abonnement_payant_detecte', orphan: false };
  }
  const trialEnd = new Date(saasClient.dateInscription).getTime() + TRIAL_DURATION_MS;
  const eligibleAt = trialEnd + params.trial_deletion_delay_days * 24 * 60 * 60 * 1000;
  if (Number.isNaN(trialEnd)) {
    return { eligible: false, motif: null, reason: 'date_inscription_invalide', orphan: true };
  }
  if (now.getTime() >= eligibleAt) {
    return { eligible: true, motif: 'essai_expire_non_converti', reason: null, orphan: false };
  }
  return { eligible: false, motif: null, reason: 'delai_blocage_non_atteint', orphan: false };
}

export function trialDatesFor(dateInscription, delayDays) {
  const start = new Date(dateInscription).getTime();
  if (Number.isNaN(start)) return { dateFinEssai: null, dateSuppressionEligible: null };
  const dateFinEssai = new Date(start + TRIAL_DURATION_MS);
  return {
    dateFinEssai,
    dateSuppressionEligible: new Date(dateFinEssai.getTime() + delayDays * 24 * 60 * 60 * 1000),
  };
}

// ---------------------------------------------------------------------------
// Suppression ordonnée d'une entreprise (enfants d'abord, entreprises en dernier)
// ---------------------------------------------------------------------------
// Liste dérivée de l'inventaire live des tables (88 tables, vérifié le
// 27 nov. 2026) : les FK n'ont pas de ON DELETE CASCADE, l'ordre est
// donc explicite. Les tables sans colonne entreprise_id sont traitées
// par sous-requête (ligne_inventaires_tournants, import_records,
// webhook_deliveries) ou par e-mail (inscriptions_en_attente, adresse
// unique de l'entreprise). Tables globales jamais touchées :
// plans_abonnement, saas_commerciaux, devises, permissions, parametres_plateforme.
const DELETE_BY_ENTREPRISE_ID = [
  // Feuilles : lignes et journaux d'abord.
  'lignes_ecriture',
  'histo_generation',
  'facture_items',
  'facture_achat_items',
  'commande_items',
  'commandes_achat_items',
  'lignes_reception',
  'bon_livraison_items',
  'devis_items',
  'retours_marchandises_items',
  'valorisations_stock',
  'mouvements_stock',
  'stock_par_entrepot',
  'stock_pending',
  'logistique_pending',
  'couts_logistiques_commande',
  'alertes_stock',
  // Paiements, remboursements, trésorerie, audits.
  'paiements',
  'paiements_fournisseurs',
  'remboursements_employes',
  'approvals_depenses',
  'ajustements_tiers',
  'historique_emails',
  'transactions_tresorerie',
  'audit_logs',
  'audit_connexions',
  'sessions',
  // password_reset_tokens et saas_ventes N'ONT PAS de colonne
  // entreprise_id en base live (vérifié 27 nov. 2026) : elles sont
  // supprimées par sous-requête dans deleteEnterpriseData, pas ici.
  'lite_idempotency',
  'export_history',
  'api_keys',
  'backup_jobs',
  'fiches_paie',
  'avances_salaire',
  // Documents et parents directs.
  'retours_marchandises',
  'inventaires_tournants',
  'import_batches',
  'factures_achat',
  'commandes_achat',
  'bons_reception',
  'bons_livraison',
  'commandes',
  'devis',
  'factures',
  'depenses',
  'ecritures',
  'ecritures_recurrentes',
  // Tiers et référentiels.
  'employes',
  'fournisseurs',
  'clients',
  'produits',
  'entrepots',
  'categories_depenses',
  'categories_stock',
  'amortissements',
  'cessions_immobilisations',
  'immobilisations',
  'categories_immobilisations',
  // Trésorerie et comptabilité.
  'rapprochement_lignes_bancaires',
  'rapprochements_bancaires',
  'comptes_bancaires',
  'soldes_comptes',
  'comptes_comptables',
  'journaux',
  'plans_comptables',
  'comptes',
  'parametres_comptables',
  'parametres_fiscaux',
  'declarations_fiscales',
  // SaaS et divers.
  'backup_configs',
  'webhook_subscriptions',
  'import_mapping_templates',
  'produit_prix',
  'taux_change',
  'factures_abonnement',
  'abonnements',
  'saas_clients',
  'users',
];

async function deleteRows(tx, table, entrepriseId, column = 'entreprise_id') {
  const result = await tx.execute(sql.raw(
    `DELETE FROM ${table} WHERE ${column} = ${Number(entrepriseId)}`,
  ));
  return Number(result?.rowCount ?? 0);
}

// Supprime l'entreprise et toutes ses données dans la transaction
// fournie. Retourne les compteurs par table. L'appelant journalise
// dans suppressions_entreprises DANS la même transaction (avant le
// DELETE entreprises) : échec = annulation complète, journal compris.
export async function deleteEnterpriseData(tx, entrepriseId, entrepriseEmail = null) {
  const id = Number(entrepriseId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Identifiant entreprise invalide.');
  if (id === PLATFORM_OWNER_ENTREPRISE_ID) throw new Error('L’entreprise de la plateforme (id 1) ne peut jamais être supprimée.');
  const counts = {};
  const deletedCount = (result) => Number(result?.rowCount ?? 0);
  // Tables sans entreprise_id, par sous-requête sur le parent.
  counts.ligne_inventaires_tournants = deletedCount(await tx.execute(sql.raw(
    `DELETE FROM ligne_inventaires_tournants WHERE inventaire_id IN (SELECT id FROM inventaires_tournants WHERE entreprise_id = ${id})`,
  )));
  counts.import_records = deletedCount(await tx.execute(sql.raw(
    `DELETE FROM import_records WHERE batch_id IN (SELECT id FROM import_batches WHERE entreprise_id = ${id})`,
  )));
  counts.webhook_deliveries = deletedCount(await tx.execute(sql.raw(
    `DELETE FROM webhook_deliveries WHERE subscription_id IN (SELECT id FROM webhook_subscriptions WHERE entreprise_id = ${id})`,
  )));
  // password_reset_tokens : pas de colonne entreprise_id — clé par
  // l'utilisateur (user_id). saas_ventes : pas de colonne entreprise_id —
  // clés par le client SaaS (client_id) et l'abonnement (abonnement_id).
  // Les deux doivent être supprimées AVANT users / abonnements /
  // saas_clients (plus bas dans la liste).
  counts.password_reset_tokens = deletedCount(await tx.execute(sql.raw(
    `DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE entreprise_id = ${id})`,
  )));
  // email_verification_codes : pas de colonne entreprise_id — clé par
  // l'utilisateur (user_id). Supprimée AVANT users (plus bas).
  counts.email_verification_codes = deletedCount(await tx.execute(sql.raw(
    `DELETE FROM email_verification_codes WHERE user_id IN (SELECT id FROM users WHERE entreprise_id = ${id})`,
  )));
  counts.saas_ventes = deletedCount(await tx.execute(sql.raw(
    `DELETE FROM saas_ventes WHERE client_id IN (SELECT id FROM saas_clients WHERE entreprise_id = ${id}) OR abonnement_id IN (SELECT id FROM abonnements WHERE entreprise_id = ${id})`,
  )));
  // Inscriptions en attente : pas de colonne entreprise ; l'e-mail de
  // l'entreprise est unique (adresse démo ou d'inscription).
  if (entrepriseEmail) {
    const [emailRow] = await tx.execute(sql`SELECT count(*)::int AS n FROM inscriptions_en_attente WHERE email = ${entrepriseEmail}`).then((r) => r?.rows || r || []);
    await tx.execute(sql`DELETE FROM inscriptions_en_attente WHERE email = ${entrepriseEmail}`);
    counts.inscriptions_en_attente = Number(emailRow?.n || 0);
  }
  // audit_connexions et sessions utilisent enterprise_id (et non entreprise_id).
  counts.audit_connexions = await deleteRows(tx, 'audit_connexions', id, 'enterprise_id');
  counts.sessions = await deleteRows(tx, 'sessions', id, 'enterprise_id');
  for (const table of DELETE_BY_ENTREPRISE_ID) {
    if (table === 'audit_connexions' || table === 'sessions') continue;
    counts[table] = await deleteRows(tx, table, id);
  }
  counts.entreprises = await deleteRows(tx, 'entreprises', id, 'id');
  return counts;
}

async function countEnterpriseContent(tx, entrepriseId) {
  const id = Number(entrepriseId);
  const [row] = await tx.execute(sql`
    SELECT
      (SELECT count(*)::int FROM clients WHERE entreprise_id = ${id}) AS clients,
      (SELECT count(*)::int FROM factures WHERE entreprise_id = ${id}) AS factures,
      (SELECT count(*)::int FROM ecritures WHERE entreprise_id = ${id}) AS ecritures,
      (SELECT count(*)::int FROM users WHERE entreprise_id = ${id}) AS users,
      (SELECT count(*)::int FROM produits WHERE entreprise_id = ${id}) AS produits,
      (SELECT count(*)::int FROM depenses WHERE entreprise_id = ${id}) AS depenses,
      (SELECT count(*)::int FROM comptes_comptables WHERE entreprise_id = ${id}) AS comptes_comptables
  `).then((r) => r?.rows || r || []);
  return row || {};
}

// ---------------------------------------------------------------------------
// Recherche des candidats (lecture seule)
// ---------------------------------------------------------------------------
export async function findPurgeCandidates(params, now = new Date(), executor = db) {
  const rows = await executor.execute(sql`
    SELECT e.id, e.nom, e.email, e.is_demo, e.created_at,
      sc.id AS saas_client_id, sc.statut, sc.source, sc.date_inscription,
      EXISTS (SELECT 1 FROM abonnements a JOIN plans_abonnement p ON p.id = a.plan_id
        WHERE a.entreprise_id = e.id AND a.statut = 'actif' AND p.prix > 0) AS has_paid_subscription,
      EXISTS (SELECT 1 FROM factures_abonnement fa
        WHERE fa.entreprise_id = e.id AND fa.statut = 'payee') AS has_paid_subscription_invoice
    FROM entreprises e
    LEFT JOIN saas_clients sc ON sc.entreprise_id = e.id
    WHERE e.id <> ${PLATFORM_OWNER_ENTREPRISE_ID}
    ORDER BY e.created_at ASC
  `).then((r) => r?.rows || r || []);
  const candidats = [];
  const orphelins = [];
  const exclus = [];
  for (const row of rows) {
    const candidate = {
      entrepriseId: Number(row.id),
      entrepriseNom: row.nom,
      entrepriseEmail: row.email,
      isDemo: row.is_demo === true,
      createdAt: row.created_at,
      saasClient: row.saas_client_id ? {
        id: Number(row.saas_client_id),
        statut: row.statut,
        source: row.source,
        dateInscription: row.date_inscription,
      } : null,
      hasPaidSubscription: row.has_paid_subscription === true,
      hasPaidSubscriptionInvoice: row.has_paid_subscription_invoice === true,
    };
    const verdict = classifyPurgeCandidate(candidate, params, now);
    const base = { ...candidate, ...verdict };
    if (candidate.isDemo) {
      const retentionMs = params.demo_retention_days * 24 * 60 * 60 * 1000;
      base.dateSuppressionEligible = candidate.createdAt
        ? new Date(new Date(candidate.createdAt).getTime() + retentionMs).toISOString() : null;
    } else if (candidate.saasClient?.dateInscription) {
      const dates = trialDatesFor(candidate.saasClient.dateInscription, params.trial_deletion_delay_days);
      base.dateFinEssai = dates.dateFinEssai?.toISOString() || null;
      base.dateSuppressionEligible = dates.dateSuppressionEligible?.toISOString() || null;
      base.dateBlocage = base.dateFinEssai;
    }
    if (verdict.eligible) candidats.push(base);
    else if (verdict.orphan) orphelins.push(base);
    else exclus.push(base);
  }
  // Comptes jamais vérifiés (28 nov. 2026) : une entreprise inscrite dont
  // AUCUN utilisateur n'a vérifié son e-mail est supprimée après 7 jours
  // (UNVERIFIED_PURGE_DAYS). Même bascule que le reste de la purge
  // (trial_purge_enabled) : tant que le flag est faux, le cron 03:00 reste
  // un dry-run, aucune suppression réelle. Jamais l'entreprise 1, jamais
  // une démo, jamais une entreprise avec une vente confirmée ou un
  // abonnement payant. Une entreprise déjà candidate par un autre motif
  // (essai expiré) n'est pas ajoutée deux fois.
  const dejaCandidates = new Set(candidats.map((c) => c.entrepriseId));
  for (const unverified of await listUnverifiedCandidates(executor)) {
    const verdict = isEligibleForUnverifiedPurge(unverified, { now });
    if (!verdict.eligible || dejaCandidates.has(unverified.id)) continue;
    candidats.push({
      entrepriseId: unverified.id,
      entrepriseNom: unverified.nom,
      entrepriseEmail: unverified.email,
      isDemo: false,
      createdAt: unverified.dateInscription,
      saasClient: null,
      hasPaidSubscription: unverified.hasPaidSubscription,
      hasPaidSubscriptionInvoice: false,
      eligible: true,
      motif: UNVERIFIED_MOTIF,
      reason: null,
      orphan: false,
      dateSuppressionEligible: verdict.eligibleAt?.toISOString() || null,
    });
  }
  return { candidats, orphelins, exclus, params: { ...params } };
}

// ---------------------------------------------------------------------------
// Comptes jamais vérifiés (28 nov. 2026)
// ---------------------------------------------------------------------------

export async function listUnverifiedCandidates(executor = db) {
  const result = await executor.execute(sql`
    SELECT e.id AS id, e.nom AS nom, e.email AS email,
      e.created_at AS "dateInscription", e.is_demo AS "isDemo",
      EXISTS (
        SELECT 1 FROM users u
        WHERE u.entreprise_id = e.id AND u.email_verified_at IS NOT NULL
      ) AS "hasVerifiedUser",
      EXISTS (
        SELECT 1 FROM saas_ventes v
        JOIN saas_clients sc ON sc.id = v.client_id
        WHERE sc.entreprise_id = e.id AND v.statut = 'confirmée'
      ) AS "hasConfirmedSale",
      EXISTS (
        SELECT 1 FROM abonnements a
        JOIN plans_abonnement p ON p.id = a.plan_id
        WHERE a.entreprise_id = e.id AND p.prix > 0
      ) AS "hasPaidSubscription"
    FROM entreprises e
    WHERE e.id <> 1
      AND e.is_demo = false
    ORDER BY e.created_at ASC
  `);
  const rows = result.rows || result || [];
  return rows.map((row) => ({
    ...row,
    id: Number(row.id),
    isDemo: row.isDemo === true,
    hasVerifiedUser: row.hasVerifiedUser === true,
    hasConfirmedSale: row.hasConfirmedSale === true,
    hasPaidSubscription: row.hasPaidSubscription === true,
  }));
}

export function isEligibleForUnverifiedPurge(candidate, { delayDays = UNVERIFIED_PURGE_DAYS, now = new Date() } = {}) {
  if (!candidate || !Number.isSafeInteger(Number(candidate.id))) {
    return { eligible: false, reason: 'candidat-manquant' };
  }
  if (Number(candidate.id) === 1) return { eligible: false, reason: 'entreprise-1-protegee' };
  if (candidate.isDemo) return { eligible: false, reason: 'demo' };
  if (candidate.hasVerifiedUser) return { eligible: false, reason: 'email-verifie' };
  if (candidate.hasConfirmedSale) return { eligible: false, reason: 'vente-confirmee' };
  if (candidate.hasPaidSubscription) return { eligible: false, reason: 'abonnement-payant' };
  const inscription = new Date(candidate.dateInscription);
  if (!Number.isFinite(inscription.getTime())) return { eligible: false, reason: 'inscription-inconnue' };
  const eligibleAt = new Date(inscription.getTime() + Number(delayDays) * 24 * 60 * 60 * 1000);
  if (now < eligibleAt) return { eligible: false, reason: 'delai-non-atteint', eligibleAt };
  return { eligible: true, reason: 'eligible', eligibleAt, dateInscription: inscription };
}

// ---------------------------------------------------------------------------
// Purge (cron + endpoint admin manuel partagent ce service)
// ---------------------------------------------------------------------------
export async function purgeExpiredTrials({ dryRun = true, ids = null, supprimePar = 'systeme:purge-essais', now = new Date(), executor = db } = {}) {
  const params = await getPlatformParams(executor);
  const { candidats, orphelins } = await findPurgeCandidates(params, now, executor);
  let selection = candidats;
  if (Array.isArray(ids) && ids.length) {
    const wanted = new Set(ids.map(Number));
    selection = candidats.filter((c) => wanted.has(c.entrepriseId));
  }
  selection = selection.slice(0, PURGE_LIMIT_PER_RUN);
  const result = {
    dryRun: Boolean(dryRun),
    params,
    trouves: candidats.length,
    orphelins: orphelins.map((o) => ({ entrepriseId: o.entrepriseId, entrepriseNom: o.entrepriseNom, raison: o.reason })),
    traites: selection.length,
    supprimes: [],
    ignores: [],
    erreurs: [],
  };
  if (dryRun) {
    result.supprimes = selection.map((c) => ({ entrepriseId: c.entrepriseId, entrepriseNom: c.entrepriseNom, motif: c.motif, simulation: true }));
    console.log(JSON.stringify({ purge: 'dry-run', trouves: result.trouves, traites: result.traites, orphelins: result.orphelins.length }));
    return result;
  }
  for (const candidat of selection) {
    try {
      const outcome = await executor.transaction(async (tx) => {
        // Re-vérification ligne par ligne, sous verrou : si une
        // condition a changé entre la sélection et la suppression
        // (ex. l'admin vient de convertir le client), on saute.
        const [entreprise] = await tx.execute(sql`
          SELECT id, nom, email, is_demo, created_at FROM entreprises WHERE id = ${candidat.entrepriseId} FOR UPDATE
        `).then((r) => r?.rows || r || []);
        if (!entreprise) return { skipped: 'entreprise_introuvable' };
        const [saasClient] = await tx.execute(sql`
          SELECT id, statut, source, date_inscription FROM saas_clients WHERE entreprise_id = ${candidat.entrepriseId} FOR UPDATE
        `).then((r) => r?.rows || r || []);
        const [paid] = await tx.execute(sql`
          SELECT
            EXISTS (SELECT 1 FROM abonnements a JOIN plans_abonnement p ON p.id = a.plan_id
              WHERE a.entreprise_id = ${candidat.entrepriseId} AND a.statut = 'actif' AND p.prix > 0) AS has_paid_subscription,
            EXISTS (SELECT 1 FROM factures_abonnement fa
              WHERE fa.entreprise_id = ${candidat.entrepriseId} AND fa.statut = 'payee') AS has_paid_subscription_invoice
        `).then((r) => r?.rows || r || []);
        let recheck;
        if (candidat.motif === UNVERIFIED_MOTIF) {
          // Comptes jamais vérifiés : re-vérification dédiée (la
          // classification essais/démos ne connaît pas ce motif).
          const fresh = (await listUnverifiedCandidates(tx)).find((c) => c.id === candidat.entrepriseId);
          const verdict = isEligibleForUnverifiedPurge(fresh, { now });
          recheck = { eligible: verdict.eligible, motif: UNVERIFIED_MOTIF, reason: verdict.reason };
        } else {
          recheck = classifyPurgeCandidate({
            entrepriseId: Number(entreprise.id),
            isDemo: entreprise.is_demo === true,
            createdAt: entreprise.created_at,
            saasClient: saasClient ? { statut: saasClient.statut, source: saasClient.source, dateInscription: saasClient.date_inscription } : null,
            hasPaidSubscription: paid?.has_paid_subscription === true,
            hasPaidSubscriptionInvoice: paid?.has_paid_subscription_invoice === true,
          }, params, now);
        }
        if (!recheck.eligible || recheck.motif !== candidat.motif) {
          return { skipped: recheck.reason || 'plus_eligible' };
        }
        const details = await countEnterpriseContent(tx, candidat.entrepriseId);
        const dates = candidat.motif === 'essai_expire_non_converti' && saasClient?.dateInscription
          ? trialDatesFor(saasClient.dateInscription, params.trial_deletion_delay_days)
          : candidat.motif === UNVERIFIED_MOTIF && entreprise.created_at
            ? {
              dateFinEssai: null,
              dateSuppressionEligible: new Date(new Date(entreprise.created_at).getTime() + UNVERIFIED_PURGE_DAYS * 24 * 60 * 60 * 1000),
            }
            : { dateFinEssai: null, dateSuppressionEligible: null };
        const delayApplique = candidat.motif === 'demo_expiree'
          ? params.demo_retention_days
          : candidat.motif === UNVERIFIED_MOTIF ? UNVERIFIED_PURGE_DAYS : params.trial_deletion_delay_days;
        await tx.execute(sql`
          INSERT INTO suppressions_entreprises
            (application, entreprise_id, entreprise_nom, entreprise_email, motif,
             date_inscription, date_fin_essai, date_blocage, date_suppression_eligible,
             delai_jours_applique, supprime_par, details)
          VALUES ('comptaorion-lite', ${candidat.entrepriseId}, ${entreprise.nom}, ${entreprise.email},
            ${recheck.motif}, ${saasClient?.date_inscription || entreprise.created_at || null},
            ${dates.dateFinEssai || null}, ${dates.dateFinEssai || null},
            ${dates.dateSuppressionEligible || null}, ${delayApplique}, ${supprimePar},
            ${JSON.stringify(details)}::jsonb)
        `);
        const deleted = await deleteEnterpriseData(tx, candidat.entrepriseId, entreprise.email);
        return { deleted: { ...details, tables: deleted } };
      });
      if (outcome.skipped) {
        result.ignores.push({ entrepriseId: candidat.entrepriseId, entrepriseNom: candidat.entrepriseNom, raison: outcome.skipped });
      } else {
        result.supprimes.push({ entrepriseId: candidat.entrepriseId, entrepriseNom: candidat.entrepriseNom, motif: candidat.motif, details: outcome.deleted });
      }
    } catch (error) {
      result.erreurs.push({ entrepriseId: candidat.entrepriseId, entrepriseNom: candidat.entrepriseNom, erreur: error?.message || String(error) });
    }
  }
  // Nettoyage du compteur anti-abus (lignes de plus de 7 jours).
  try {
    await executor.execute(sql`DELETE FROM demo_creations WHERE created_at < now() - interval '7 days'`);
  } catch (error) {
    console.warn('Nettoyage demo_creations impossible:', error?.message || error);
  }
  console.log(JSON.stringify({
    purge: 'executee', dryRun: false, trouves: result.trouves,
    supprimes: result.supprimes.length, ignores: result.ignores.length,
    erreurs: result.erreurs.length, orphelins: result.orphelins.length,
  }));
  return result;
}

// ---------------------------------------------------------------------------
// Garde anti-abus de la route démo publique : 5 créations par IP et par jour.
// ---------------------------------------------------------------------------
export async function checkDemoRateLimit(ipAddress, executor = db) {
  const ip = String(ipAddress || 'inconnue').slice(0, 45);
  const [row] = await executor.execute(sql`
    SELECT count(*)::int AS n FROM demo_creations
    WHERE ip_address = ${ip} AND created_at >= date_trunc('day', now())
  `).then((r) => r?.rows || r || []);
  const count = Number(row?.n || 0);
  if (count >= DEMO_RATE_LIMIT_PER_DAY) {
    throw Object.assign(new Error('Limite de démonstrations atteinte pour aujourd’hui (5 par jour). Réessayez demain.'), { status: 429, code: 'DEMO_RATE_LIMITED' });
  }
  return count;
}

export async function recordDemoCreation(ipAddress, executor) {
  const ip = String(ipAddress || 'inconnue').slice(0, 45);
  await executor.execute(sql`INSERT INTO demo_creations (ip_address) VALUES (${ip})`);
}
