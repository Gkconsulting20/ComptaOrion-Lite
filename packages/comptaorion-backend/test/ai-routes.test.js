import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import { runWithDatabaseContext } from '../src/db.js';
import { signDraft } from '../src/services/photoDraft.js';

process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';
const { default: aiRouter } = await import('../src/routes/ai.js');
const { idempotencyMiddleware } = await import('../src/middleware/idempotency.js');
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const dialect = new PgDialect();

async function withApi(rows, run) {
  const queries = [];
  const fake = {
    select() {
      const chain = {
        from() { return chain; },
        innerJoin(_table, predicate) { queries.push(dialect.sqlToQuery(predicate)); return chain; },
        where(predicate) { queries.push(dialect.sqlToQuery(predicate)); return chain; },
        limit() { return Promise.resolve(rows.shift() || []); },
        then(resolve, reject) { return Promise.resolve(rows.shift() || []).then(resolve, reject); },
      };
      return chain;
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { id: 7, entrepriseId: 9 }; req.entrepriseId = 9;
    return runWithDatabaseContext({ db: fake, pool: { query() { throw new Error('No write or generic idempotency allowed'); } } }, next);
  }, idempotencyMiddleware);
  app.use('/api/ai', aiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = async (path, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/ai${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try { await run(request, queries); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('préparation sans consentement et confirmation non explicite ne lisent/écrivent aucune donnée', async () => {
  await withApi([], async (request, queries) => {
    const headers = { 'X-Idempotency-Key': 'untrusted-header-123' };
    assert.equal((await request('/prepare-photo', { image, consent: false }, headers)).status, 400);
    assert.equal((await request('/confirm', { confirmed: false }, headers)).status, 400);
    assert.equal((await request('/prepare-photo', { image: 'https://internal.invalid', consent: true })).status, 400);
    assert.equal(queries.length, 0);
  });
});
test('un client d’une autre entreprise est introuvable avant lecture de factures ou appel IA', async () => {
  await withApi([[]], async (request, queries) => {
    assert.equal((await request('/payment-analysis/55', { explain: true })).status, 404);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /entreprise_id/);
    assert.deepEqual(queries[0].params, [55, 9]);
  });
});
test('client, factures et paiements sont tous filtrés par entreprise; le score seul ne dépend pas de Groq', async () => {
  await withApi([[{ id: 55 }], [], []], async (request, queries) => {
    const response = await request('/payment-analysis/55', { explain: false });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.score, null);
    assert.equal(data.explanation, null);
    assert.equal(queries.length, 4);
    for (const query of queries) {
      assert.match(query.sql, /entreprise_id/);
      assert.ok(query.params.includes(9));
    }
  });
});
test('l’analyse répétée d’une photo déjà confirmée ne contacte pas le fournisseur', async () => {
  await withApi([[{ status: 'completed' }]], async (request, queries) => {
    const response = await request('/prepare-photo', { consent: true, image });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.duplicate, true);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].params[0], 9);
    assert.match(queries[0].params[1], /^ai-photo:9:/);
  });
});
test('un brouillon étranger ou une devise différente ne peut pas créer de dépense', async () => {
  await withApi([[{ devise: 'FCFA' }]], async (request, queries) => {
    const draft = { description: 'Test', montant: 5000, dateDepense: '2026-10-16', reference: 'R1', devise: 'EUR' };
    const badToken = signDraft('a'.repeat(64), 10, 7);
    assert.equal((await request('/confirm', { confirmed: true, draftToken: badToken, draft })).status, 403);
    assert.equal(queries.length, 0);
    const token = signDraft('a'.repeat(64), 9, 7);
    assert.equal((await request('/confirm', { confirmed: true, draftToken: token, draft })).status, 400);
    assert.equal(queries.length, 1);
  });
});
