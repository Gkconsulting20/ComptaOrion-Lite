import test from 'node:test';
import assert from 'node:assert/strict';
import { idempotencyMiddleware } from '../src/middleware/idempotency.js';
import { runWithDatabaseContext } from '../src/db.js';

test('la dépense Lite laisse sa route réserver la clé dans la transaction', async () => {
  const poolQueries = [];
  let nextCalled = false;
  const req = {
    method: 'POST',
    path: '/depenses/lite-create',
    get: (name) => name.toLowerCase() === 'x-idempotency-key' ? 'test-expense-key-123' : undefined,
  };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  await runWithDatabaseContext({
    db: {},
    pool: { query: async (sql) => { poolQueries.push(String(sql)); return { rowCount: 0, rows: [] }; } },
  }, () => idempotencyMiddleware(req, res, () => { nextCalled = true; }));

  assert.equal(req.idempotencyKey, 'test-expense-key-123');
  assert.equal(nextCalled, true);
  assert.equal(poolQueries.length, 1);
  assert.match(poolQueries[0], /CREATE TABLE IF NOT EXISTS lite_idempotency/);
  assert.doesNotMatch(poolQueries.join('\n'), /INSERT INTO lite_idempotency/);
  assert.equal(res.statusCode, null);
});
