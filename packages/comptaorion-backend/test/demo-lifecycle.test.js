// Mode démo + cycle de vie essai → blocage → suppression (Lite).
// Tests unitaires sur base factice : aucune connexion à la base live.
import test from 'node:test';
import assert from 'node:assert/strict';

// demoSeed.js importe auth.js (secrets JWT obligatoires au chargement) :
// on pose les variables puis on importe dynamiquement, comme les
// autres tests du repo (depenses-workflow, saas-platform-admin).
process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';
const { buildDemoIdentifiers } = await import('../src/services/demoSeed.js');
import { evaluateSaasAccess } from '../src/trial-access.js';
import {
  classifyPurgeCandidate,
  trialDatesFor,
  getPlatformParams,
  setPlatformParam,
  findPurgeCandidates,
  purgeExpiredTrials,
  checkDemoRateLimit,
  deleteEnterpriseData,
} from '../src/services/trialLifecycle.js';
const NOW = new Date('2026-11-27T12:00:00.000Z');
const PARAMS = { trial_deletion_delay_days: 30, demo_retention_days: 7, trial_purge_enabled: false };
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

test('démo : statut actif → accès autorisé, trialEndsAt null (jamais expulsée)', () => {
  assert.deepEqual(evaluateSaasAccess({ statut: 'actif' }, NOW), {
    allowed: true, status: 'actif', trialEndsAt: null,
  });
});

test('identifiants démo : préfixés par entreprise, jamais nus (R1)', () => {
  const a = buildDemoIdentifiers(12);
  const b = buildDemoIdentifiers(13);
  assert.equal(a.clientNumber(1), 'DEMO-12-CLI-001');
  assert.notEqual(a.clientNumber(1), b.clientNumber(1));
  assert.equal(a.productReference(2), 'DEMO-12-PRD-002');
  assert.equal(a.employeeMatricule, 'DEMO-12-EMP-01');
  assert.equal(a.invoiceNumber(2026, 1), 'FACT-2026-12-0001');
  assert.notEqual(a.invoiceNumber(2026, 1), b.invoiceNumber(2026, 1));
  assert.equal(a.quoteNumber(2026, 2), 'DEV-2026-12-0002');
});

test('matrice d’éligibilité suppression (§6.3)', () => {
  const base = (overrides) => ({
    entrepriseId: 99, isDemo: false,
    saasClient: { statut: 'trial', source: 'web', dateInscription: daysAgo(61) },
    hasPaidSubscription: false, hasPaidSubscriptionInvoice: false,
    ...overrides,
  });
  // Essai expiré + 31 j de blocage → éligible (61 j = 30 essai + 31 blocage).
  assert.deepEqual(classifyPurgeCandidate(base(), PARAMS, NOW).eligible, true);
  assert.equal(classifyPurgeCandidate(base(), PARAMS, NOW).motif, 'essai_expire_non_converti');
  // Essai expiré + 29 j de blocage → non (59 j).
  assert.equal(classifyPurgeCandidate(base({ saasClient: { statut: 'trial', source: 'web', dateInscription: daysAgo(59) } }), PARAMS, NOW).eligible, false);
  // Essai en cours → non.
  assert.equal(classifyPurgeCandidate(base({ saasClient: { statut: 'trial', source: 'web', dateInscription: daysAgo(10) } }), PARAMS, NOW).eligible, false);
  // Converti (actif) → non.
  assert.equal(classifyPurgeCandidate(base({ saasClient: { statut: 'actif', source: 'web', dateInscription: daysAgo(61) } }), PARAMS, NOW).eligible, false);
  // Abonnement payant actif détecté → non (défense).
  assert.equal(classifyPurgeCandidate(base({ hasPaidSubscription: true }), PARAMS, NOW).eligible, false);
  assert.equal(classifyPurgeCandidate(base({ hasPaidSubscriptionInvoice: true }), PARAMS, NOW).eligible, false);
  // Entreprise 1 (ORIONEXA) → non, toujours.
  assert.equal(classifyPurgeCandidate(base({ entrepriseId: 1 }), PARAMS, NOW).eligible, false);
  // Démo récente → non ; démo de plus de 7 j → éligible (motif démo).
  assert.equal(classifyPurgeCandidate(base({ isDemo: true, createdAt: daysAgo(3), saasClient: null }), PARAMS, NOW).eligible, false);
  const oldDemo = classifyPurgeCandidate(base({ entrepriseId: 101, isDemo: true, createdAt: daysAgo(8), saasClient: null }), PARAMS, NOW);
  assert.equal(oldDemo.eligible, true);
  assert.equal(oldDemo.motif, 'demo_expiree');
  // Sans ligne saasClients → non + signalée (orpheline).
  const orphan = classifyPurgeCandidate(base({ saasClient: null }), PARAMS, NOW);
  assert.equal(orphan.eligible, false);
  assert.equal(orphan.orphan, true);
});

test('dates d’essai : fin d’essai et date éligible à la suppression', () => {
  const dates = trialDatesFor('2026-11-01T00:00:00.000Z', 30);
  assert.equal(dates.dateFinEssai.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(dates.dateSuppressionEligible.toISOString(), '2026-12-31T00:00:00.000Z');
});

test('paramètres plateforme : défauts quand la table est vide', async () => {
  const fakeExecutor = { execute: async () => ({ rows: [] }) };
  assert.deepEqual(await getPlatformParams(fakeExecutor), {
    trial_deletion_delay_days: 30, demo_retention_days: 7, trial_purge_enabled: false,
  });
});

test('paramètres plateforme : validation des écritures', async () => {
  await assert.rejects(setPlatformParam('cle_inconnue', '1'), /Paramètre inconnu/);
  await assert.rejects(setPlatformParam('trial_deletion_delay_days', 'abc'), /nombre de jours/);
  await assert.rejects(setPlatformParam('trial_purge_enabled', 'oui'), /true ou false/);
  const fakeExecutor = {
    execute: async () => ({ rows: [{ cle: 'trial_purge_enabled', valeur: 'true' }] }),
  };
  const row = await setPlatformParam('trial_purge_enabled', 'true', 'admin@orionexa.net', fakeExecutor);
  assert.equal(row.valeur, 'true');
});

test('garde anti-abus démo : 5 créations par IP et par jour', async () => {
  const atLimit = { execute: async () => ({ rows: [{ n: 5 }] }) };
  await assert.rejects(checkDemoRateLimit('203.0.113.7', atLimit), /Limite de démonstrations/);
  const below = { execute: async () => ({ rows: [{ n: 2 }] }) };
  assert.equal(await checkDemoRateLimit('203.0.113.7', below), 2);
});

test('suppression : l’entreprise 1 est toujours refusée', async () => {
  const fakeTx = { execute: async () => { throw new Error('ne doit pas être appelé'); } };
  await assert.rejects(deleteEnterpriseData(fakeTx, 1), /plateforme/);
});

test('suppression : password_reset_tokens et saas_ventes par sous-requête (pas de colonne entreprise_id en base live)', async () => {
  const seen = [];
  const fakeTx = {
    execute: async (query) => {
      seen.push(JSON.stringify(query?.queryChunks ?? query));
      return { rowCount: 0, rows: [] };
    },
  };
  const counts = await deleteEnterpriseData(fakeTx, 42, 'demo-test@demo.comptaorion.com');
  const sqlText = seen.join('\n');
  assert.ok(!sqlText.includes('password_reset_tokens WHERE entreprise_id'), 'password_reset_tokens ne doit pas être supprimée par entreprise_id');
  assert.ok(!sqlText.includes('saas_ventes WHERE entreprise_id'), 'saas_ventes ne doit pas être supprimée par entreprise_id');
  assert.ok(sqlText.includes('password_reset_tokens WHERE user_id IN'), 'password_reset_tokens doit être supprimée par user_id');
  assert.ok(sqlText.includes('saas_ventes WHERE client_id IN'), 'saas_ventes doit être supprimée par client_id/abonnement_id');
  assert.equal(counts.password_reset_tokens, 0);
  assert.equal(counts.saas_ventes, 0);
  assert.equal(counts.entreprises, 0);
});

test('purge dry-run : sélection des candidats sans suppression', async () => {
  const rows = [
    { id: 99, nom: 'Essai vieux', email: 'vieux@example.test', is_demo: false, created_at: daysAgo(61), saas_client_id: 1, statut: 'trial', source: 'web', date_inscription: daysAgo(61), has_paid_subscription: false, has_paid_subscription_invoice: false },
    { id: 100, nom: 'Essai récent', email: 'recent@example.test', is_demo: false, created_at: daysAgo(10), saas_client_id: 2, statut: 'trial', source: 'web', date_inscription: daysAgo(10), has_paid_subscription: false, has_paid_subscription_invoice: false },
    { id: 101, nom: 'Démo vieille', email: 'demo-abc@demo.comptaorion.com', is_demo: true, created_at: daysAgo(8), saas_client_id: 3, statut: 'actif', source: 'demo', date_inscription: daysAgo(8), has_paid_subscription: false, has_paid_subscription_invoice: false },
    { id: 102, nom: 'Orpheline', email: 'orpheline@example.test', is_demo: false, created_at: daysAgo(90), saas_client_id: null, statut: null, source: null, date_inscription: null, has_paid_subscription: false, has_paid_subscription_invoice: false },
    { id: 103, nom: 'Convertie', email: 'payante@example.test', is_demo: false, created_at: daysAgo(61), saas_client_id: 4, statut: 'actif', source: 'web', date_inscription: daysAgo(61), has_paid_subscription: false, has_paid_subscription_invoice: false },
  ];
  let calls = 0;
  const fakeExecutor = {
    execute: async () => {
      calls += 1;
      // Appel 1 : getPlatformParams (table vide → défauts) ;
      // appel 2 : findPurgeCandidates (lignes ci-dessus).
      return calls === 1 ? { rows: [] } : { rows };
    },
    transaction: async () => { throw new Error('dry-run : aucune transaction de suppression'); },
  };
  const found = await findPurgeCandidates(PARAMS, NOW, { execute: async () => ({ rows }) });
  assert.deepEqual(found.candidats.map((c) => c.entrepriseId), [99, 101]);
  assert.deepEqual(found.orphelins.map((c) => c.entrepriseId), [102]);
  const result = await purgeExpiredTrials({ dryRun: true, now: NOW, executor: fakeExecutor });
  assert.equal(result.dryRun, true);
  assert.equal(result.trouves, 2);
  assert.deepEqual(result.supprimes.map((s) => s.entrepriseId), [99, 101]);
  assert.ok(result.supprimes.every((s) => s.simulation === true));
  assert.deepEqual(result.orphelins.map((o) => o.entrepriseId), [102]);
});
