import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runWithDatabaseContext } from '../src/db.js';
import { produits } from '../src/schema.js';
import { PLAN_SYSCOHADA } from '../src/services/syscohadaService.js';

process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';
const { default: produitsRouter } = await import('../src/routes/produits.js');

// Refonte « services uniquement » (Lite) : plus de stock, plus d'achats
// de marchandises, plus de CMUP, plus de compte 310. Le catalogue
// /api/produits reste (prestations), mais sans champs de stock ; les
// routes de stock répondent 410 Gone ; le plan SYSCOHADA d'initialisation
// ne crée plus de compte Marchandises (310/311/312).

test('plan SYSCOHADA Lite : aucun compte Marchandises (310/311/312)', () => {
  const numeros = PLAN_SYSCOHADA.map((compte) => compte.numero);
  assert.ok(!numeros.includes('310'), '310 présent dans le plan');
  assert.ok(!numeros.includes('311'), '311 présent dans le plan');
  assert.ok(!numeros.includes('312'), '312 présent dans le plan');
  assert.ok(numeros.includes('57'), '57 (Caisse) doit rester dans le plan');
  assert.ok(numeros.includes('705'), '705 (prestations de services) doit rester dans le plan');
});

function fakeDb({ selectRows = [] } = {}) {
  const insertions = [];
  const queue = [...selectRows];
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(queue.shift() || []),
    offset: () => chain,
    then: (resolve, reject) => Promise.resolve(queue.shift() || []).then(resolve, reject),
  };
  const fake = {
    insertions,
    select: () => chain,
    execute: async () => ({ rows: [] }),
    insert: (table) => ({
      values: (rows) => {
        insertions.push({ table, rows });
        return { returning: async () => [{ id: 100, ...rows }] };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  };
  fake.transaction = async (cb) => cb(fake);
  return fake;
}

async function withApi(fake, run) {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { id: 13, entrepriseId: 13 };
    req.userId = 13;
    req.entrepriseId = 13;
    return runWithDatabaseContext({ db: fake, pool: {} }, next);
  });
  app.use('/api/produits', produitsRouter);
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

test('GET /produits/stock-faible : 410 Gone (alertes de stock retirées)', async () => {
  const fake = fakeDb();
  await withApi(fake, async (request) => {
    const res = await request('GET', '/produits/stock-faible');
    assert.equal(res.status, 410);
    const body = await res.json();
    assert.match(body.message, /stock/);
    assert.equal(fake.insertions.length, 0);
  });
});

test('POST /produits/:id/ajuster-stock : 410 Gone (ajustements retirés)', async () => {
  const fake = fakeDb();
  await withApi(fake, async (request) => {
    const res = await request('POST', '/produits/100/ajuster-stock', { quantite: 5, type: 'entree' });
    assert.equal(res.status, 410);
    assert.equal(fake.insertions.length, 0);
  });
});

test('POST /produits : les champs de stock sont ignorés, la prestation est créée', async () => {
  const fake = fakeDb();
  await withApi(fake, async (request) => {
    const res = await request('POST', '/produits', {
      nom: 'Consultation en gestion',
      prixVente: 50000,
      quantite: 10,
      stockMinimum: 2,
      prixAchat: 10000,
      fournisseurId: 7,
    });
    assert.equal(res.status, 201);
    const insertion = fake.insertions.find((i) => i.table === produits);
    assert.ok(insertion, 'insertion attendue');
    assert.equal(insertion.rows.nom, 'Consultation en gestion');
    assert.equal(insertion.rows.prixVente, 50000);
    assert.equal(insertion.rows.quantite, undefined);
    assert.equal(insertion.rows.stockMinimum, undefined);
    assert.equal(insertion.rows.prixAchat, undefined);
    assert.equal(insertion.rows.coutMoyen, undefined);
    assert.equal(insertion.rows.fournisseurId, undefined);
  });
});
