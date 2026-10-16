import test from 'node:test';
import assert from 'node:assert/strict';
import { configurationProblems } from '../src/cloudflare-config.js';
import { db, pool, runWithDatabaseContext } from '../src/db.js';

// These strings are test fixtures, never application signing keys.
const valid = {
  DATABASE_URL: 'postgresql://test:fixture@database.invalid/lite',
  JWT_SECRET: 'test-access-fixture-not-a-real-secret',
  JWT_REFRESH_SECRET: 'test-refresh-fixture-not-a-real-secret',
};

test('Cloudflare exige la base et les deux clés sans exposer leurs valeurs', () => {
  assert.equal(configurationProblems({}).length, 3);
  assert.deepEqual(configurationProblems(valid), []);
  const problems = configurationProblems({ ...valid, JWT_SECRET: 'short' });
  assert.match(problems.join(), /JWT_SECRET trop court/);
  assert.ok(!problems.join().includes('short'));
});

test('Cloudflare refuse des clés identiques et une base non PostgreSQL', () => {
  assert.ok(configurationProblems({ ...valid, JWT_REFRESH_SECRET: valid.JWT_SECRET }).length);
  assert.ok(configurationProblems({ ...valid, DATABASE_URL: 'https://database.invalid' }).length);
});

test('les requêtes concurrentes ont des contextes PostgreSQL séparés', async () => {
  const makeContext = (id) => ({
    db: { id, read() { return this.id; } },
    pool: { id, query() { return this.id; } },
  });
  const result = await Promise.all([1, 2].map((id) =>
    runWithDatabaseContext(makeContext(id), async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { id: db.read(), pool: pool.query() };
    })));
  assert.deepEqual(result, [{ id: 1, pool: 1 }, { id: 2, pool: 2 }]);
});

test('le contexte de requête est restauré après une erreur', async () => {
  await runWithDatabaseContext({ db: { id: 'outer' } }, async () => {
    await assert.rejects(runWithDatabaseContext({ db: { id: 'inner' } }, async () => {
      throw new Error('fixture failure');
    }));
    assert.equal(db.id, 'outer');
  });
});
