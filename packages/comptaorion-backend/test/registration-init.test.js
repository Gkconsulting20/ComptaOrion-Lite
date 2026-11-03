import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runWithDatabaseContext } from '../src/db.js';
import { JOURNAUX_BASE, PLAN_SYSCOHADA, initializeSyscohadaForEnterprise } from '../src/services/syscohadaService.js';

test('initialise le plan SYSCOHADA en deux insertions groupées et sans doublons', async () => {
  const insertions = [];
  let queryIndex = 0;
  const queryResults = [
    [],
    [],
    PLAN_SYSCOHADA.map(({ numero }) => ({ numero })),
    JOURNAUX_BASE.map(({ code }) => ({ code })),
  ];
  const fakeDb = {
    select: () => {
      const result = queryResults[queryIndex++];
      return { from: () => ({ where: async () => result }) };
    },
    insert: (table) => ({
      values: async (rows) => insertions.push({ table, rows }),
    }),
  };

  const result = await runWithDatabaseContext({ db: fakeDb, pool: {} }, async () => {
    const first = await initializeSyscohadaForEnterprise(1001);
    const second = await initializeSyscohadaForEnterprise(1001);
    return { first, second };
  });

  assert.equal(result.first.comptesCreés, PLAN_SYSCOHADA.length);
  assert.equal(result.first.journauxCreés, JOURNAUX_BASE.length);
  assert.equal(result.second.comptesCreés, 0);
  assert.equal(result.second.journauxCreés, 0);
  assert.equal(insertions.length, 2);
  assert.equal(insertions[0].rows.length, PLAN_SYSCOHADA.length);
  assert.equal(insertions[1].rows.length, JOURNAUX_BASE.length);
});

test('un e-mail absent reçoit une réponse de connexion générique sans audit invalide', async (t) => {
  const fakeDb = {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => {
      throw new Error('Aucune insertion d’audit ne doit être tentée sans utilisateur');
    },
  };
  const { default: authSecurityRoutes } = await import('../src/routes/auth-security.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithDatabaseContext({ db: fakeDb, pool: {} }, next));
  app.use('/api/auth-security', authSecurityRoutes);
  const server = app.listen(0);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth-security/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'absent@example.test', password: 'not-a-password' }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Email ou mot de passe incorrect' });
});
