import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runWithDatabaseContext } from '../src/db.js';

process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';
const { default: depensesRouter } = await import('../src/routes/dépenses.js');

// Gestion des employés dans le module Dépenses (Lite, services uniquement).
// Le test utilise une base factice : aucune connexion à la base live.

const EXISTING = { id: 5, entrepriseId: 9, nom: 'Konan', prenom: 'Awa', telephone: '+228 90 00 00 00', poste: 'Vendeuse', actif: true };

function fakeDb({ selectRows = [], employesList = [], updateBase = null } = {}) {
  const insertions = [];
  const updates = [];
  let nextId = 100;
  const queue = [...selectRows];
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(queue.shift() || []),
    then: (resolve, reject) => Promise.resolve(queue.shift() || []).then(resolve, reject),
  };
  const fake = {
    insertions,
    updates,
    query: {
      employes: { findMany: async () => employesList },
    },
    select: () => chain,
    insert: (table) => ({
      values: (rows) => {
        insertions.push({ table, rows });
        const single = Array.isArray(rows) ? rows[0] : rows;
        return { returning: async () => [{ id: nextId++, ...single }] };
      },
    }),
    update: (table) => ({
      set: (values) => {
        updates.push({ table, values });
        return {
          where: () => ({
            returning: async () => [{ ...(updateBase || { id: 5 }), ...values }],
          }),
        };
      },
    }),
  };
  fake.transaction = async (cb) => cb(fake);
  return fake;
}

async function withApi(fake, run) {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { id: 7, entrepriseId: 9 };
    req.userId = 7;
    req.entrepriseId = 9;
    return runWithDatabaseContext({ db: fake, pool: {} }, next);
  });
  app.use('/api/depenses', depensesRouter);
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

test('GET /depenses/employes/list renvoie les employés actifs de l’entreprise', async () => {
  const fake = fakeDb({ employesList: [EXISTING, { ...EXISTING, id: 6, nom: 'Mensah', prenom: 'Kofi' }] });
  await withApi(fake, async (request) => {
    const res = await request('GET', '/depenses/employes/list');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 2);
    assert.equal(body[0].nom, 'Konan');
  });
});

test('POST /depenses/employes crée un employé (201) et journalise l’audit', async () => {
  const fake = fakeDb();
  await withApi(fake, async (request) => {
    const res = await request('POST', '/depenses/employes', { nom: 'Konan', prenom: 'Awa', telephone: '+228 90 00 00 00', poste: 'Vendeuse' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.nom, 'Konan');
    assert.equal(body.prenom, 'Awa');
    assert.equal(body.entrepriseId, 9);
    const employeeInsert = fake.insertions.find((i) => i.rows?.nom === 'Konan');
    assert.ok(employeeInsert, 'insertion employé attendue');
    const auditInsert = fake.insertions.find((i) => i.rows?.tableName === 'employes' && i.rows?.action === 'CREATE');
    assert.ok(auditInsert, 'audit CREATE attendu');
    assert.equal(auditInsert.rows.description, 'Employé créé: Awa Konan');
  });
});

test('POST /depenses/employes refuse sans nom ou sans prénom (400)', async () => {
  const fake = fakeDb();
  await withApi(fake, async (request) => {
    const withoutNom = await request('POST', '/depenses/employes', { prenom: 'Awa' });
    assert.equal(withoutNom.status, 400);
    const withoutPrenom = await request('POST', '/depenses/employes', { nom: 'Konan' });
    assert.equal(withoutPrenom.status, 400);
    assert.equal(fake.insertions.length, 0);
  });
});

test('PUT /depenses/employes/:id modifie les champs simples et journalise l’audit', async () => {
  const fake = fakeDb({ selectRows: [[EXISTING]], updateBase: EXISTING });
  await withApi(fake, async (request) => {
    const res = await request('PUT', '/depenses/employes/5', { poste: 'Caissière', telephone: '+228 91 11 11 11' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.poste, 'Caissière');
    assert.equal(body.telephone, '+228 91 11 11 11');
    assert.equal(body.nom, 'Konan');
    const auditInsert = fake.insertions.find((i) => i.rows?.tableName === 'employes' && i.rows?.action === 'UPDATE');
    assert.ok(auditInsert, 'audit UPDATE attendu');
  });
});

test('PUT /depenses/employes/:id refuse un employé introuvable (404) ou un nom vide (400)', async () => {
  const fake = fakeDb({ selectRows: [[]] });
  await withApi(fake, async (request) => {
    const missing = await request('PUT', '/depenses/employes/999', { poste: 'Caissière' });
    assert.equal(missing.status, 404);
    const emptyNom = await request('PUT', '/depenses/employes/5', { nom: '' });
    assert.equal(emptyNom.status, 400);
  });
});

test('DELETE /depenses/employes/:id désactive l’employé (actif=false) sans supprimer la ligne', async () => {
  const fake = fakeDb({ selectRows: [[EXISTING]], updateBase: EXISTING });
  await withApi(fake, async (request) => {
    const res = await request('DELETE', '/depenses/employes/5');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.actif, false);
    assert.equal(fake.updates.length, 1);
    assert.deepEqual(fake.updates[0].values, { actif: false });
    const auditInsert = fake.insertions.find((i) => i.rows?.tableName === 'employes' && i.rows?.action === 'DELETE');
    assert.ok(auditInsert, 'audit DELETE attendu');
  });
});

test('DELETE /depenses/employes/:id refuse un employé introuvable (404)', async () => {
  const fake = fakeDb({ selectRows: [[]] });
  await withApi(fake, async (request) => {
    const res = await request('DELETE', '/depenses/employes/999');
    assert.equal(res.status, 404);
    assert.equal(fake.updates.length, 0);
  });
});
