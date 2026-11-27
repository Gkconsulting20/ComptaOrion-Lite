import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runWithDatabaseContext } from '../src/db.js';

process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';
const { default: liteAccountingRouter } = await import('../src/routes/lite-accounting.js');

// Refonte « services uniquement » (Lite) : les achats fournisseurs et les
// retours de marchandises sont retirés. Les anciennes routes doivent
// répondre 404 (et non 500 ni 200), et le routeur des achats ne doit
// plus exister ni être monté.

const backendDir = path.dirname(fileURLToPath(import.meta.url));

test('le routeur des achats Lite est supprimé et n’est plus monté', () => {
  assert.equal(
    existsSync(path.join(backendDir, '..', 'src', 'routes', 'lite-purchases.js')),
    false,
    'lite-purchases.js doit être supprimé',
  );
  const appSource = readFileSync(path.join(backendDir, '..', 'src', 'app.js'), 'utf8');
  assert.ok(!appSource.includes('lite-purchases'), 'app.js ne doit plus référencer lite-purchases');
});

async function withApi(run) {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { id: 13, entrepriseId: 13 };
    req.userId = 13;
    req.entrepriseId = 13;
    return runWithDatabaseContext({ db: {}, pool: {} }, next);
  });
  app.use('/api', liteAccountingRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Route non disponible dans Lite' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (method, path, body) => fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try { await run(request); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('routes retours et fournisseurs : 404', async () => {
  await withApi(async (request) => {
    for (const [method, path, body] of [
      ['POST', '/factures/1/retours', { items: [{ itemId: 1, quantite: 1 }] }],
      ['POST', '/achats/1/retours', { items: [{ itemId: 1, quantite: 1 }] }],
      ['POST', '/achats/1/notes-credit', { totalHT: 1000, compteAjustementId: 1, motif: 'test' }],
      ['GET', '/fournisseurs/1/compte', undefined],
      ['PUT', '/fournisseurs/1/conditions-escompte', { escomptePourcentage: 0, escompteDelaiJours: 0, delaiPaiement: 30 }],
      ['GET', '/fournisseurs', undefined],
      ['GET', '/achats', undefined],
    ]) {
      const res = await request(method, path, body);
      assert.equal(res.status, 404, `${method} ${path} doit répondre 404, reçu ${res.status}`);
    }
  });
});

test('la note de débit client reste disponible (pas un retour)', async () => {
  // Sans base, la route doit échouer en 500 (erreur DB), pas en 404 :
  // la route existe toujours.
  await withApi(async (request) => {
    const res = await request('POST', '/factures/1/notes-debit', {
      totalHT: 1000, compteAjustementId: 1, motif: 'remise commerciale',
    });
    assert.notEqual(res.status, 404, 'la note de débit client ne doit pas être 404');
  });
});
