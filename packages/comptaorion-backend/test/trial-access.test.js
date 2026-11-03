import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithDatabaseContext } from '../src/db.js';
import { evaluateSaasAccess, getTrialEnd, trialAccessMiddleware } from '../src/trial-access.js';

test('un essai expire exactement 30 jours après son inscription', () => {
  const started = new Date('2026-01-01T12:00:00.000Z');
  assert.equal(getTrialEnd(started).toISOString(), '2026-01-31T12:00:00.000Z');
  assert.equal(evaluateSaasAccess({
    statut: 'trial',
    dateInscription: started,
  }, new Date('2026-01-31T11:59:59.999Z')).allowed, true);
  assert.deepEqual(evaluateSaasAccess({
    statut: 'trial',
    dateInscription: started,
  }, new Date('2026-01-31T12:00:00.000Z')), {
    allowed: false,
    code: 'TRIAL_EXPIRED',
    trialEndsAt: '2026-01-31T12:00:00.000Z',
  });
});

test('les espaces payants actifs restent autorisés; les espaces suspendus sont bloqués', () => {
  assert.deepEqual(evaluateSaasAccess({ statut: 'actif' }), {
    allowed: true,
    status: 'actif',
    trialEndsAt: null,
  });
  assert.deepEqual(evaluateSaasAccess({ statut: 'suspendu' }), {
    allowed: false,
    code: 'ACCOUNT_INACTIVE',
  });
});

test('le middleware refuse les opérations d’un essai expiré', async () => {
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{
            entrepriseId: 246,
            statut: 'trial',
            dateInscription: new Date('2026-01-01T00:00:00.000Z'),
          }],
        }),
      }),
    }),
  };
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextCalled = false;

  await runWithDatabaseContext({ db: fakeDb, pool: {} }, async () => {
    await trialAccessMiddleware({
      user: { id: 123, entrepriseId: 246, email: 'client@example.test', role: 'admin' },
    }, response, () => { nextCalled = true; });
  });

  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'TRIAL_EXPIRED');
  assert.equal(response.body.trialEndsAt, '2026-01-31T00:00:00.000Z');
});
