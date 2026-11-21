import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runWithDatabaseContext } from '../src/db.js';

process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';
const { default: clotureRouter } = await import('../src/routes/cloture-exercice.js');

// Clôture d'exercice (Lite, services uniquement) — routes extraites de
// routes/comptabilite.js (non monté) et exposées via app.js sous /api.
// Le test utilise une base factice : aucune connexion à la base live.

// Entreprise factice : un loyer de 25 000 payé en espèces en 2025
// (écriture n°10 : D 613 25 000 / C 57 25 000) => perte de 25 000 à
// reporter sur le compte 129.
const COMPTES = [
  { id: 1, numero: '613', nom: 'Loyers' },
  { id: 2, numero: '701', nom: 'Ventes de prestations' },
  { id: 3, numero: '57', nom: 'Caisse' },
  { id: 4, numero: '101', nom: 'Capital social' },
  { id: 5, numero: '129', nom: "Résultat de l'exercice (perte)" },
];
const ECRITURES_2025 = [{ id: 10 }];
const LIGNES_2025 = [
  { compteComptableId: 1, debit: '25000', credit: '0', ecritureId: 10 },
  { compteComptableId: 3, debit: '0', credit: '25000', ecritureId: 10 },
];

function fakeDb({ selectRows = [], journaux = [] } = {}) {
  const insertions = [];
  let nextId = 100;
  const queue = [...selectRows];
  const journauxQueue = [...journaux];
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(queue.shift() || []),
    then: (resolve, reject) => Promise.resolve(queue.shift() || []).then(resolve, reject),
  };
  return {
    insertions,
    query: {
      comptesComptables: { findMany: async () => COMPTES },
      journaux: { findFirst: async () => journauxQueue.shift() || null },
    },
    select: () => chain,
    insert: (table) => ({
      values: (rows) => {
        insertions.push({ table, rows });
        return { returning: async () => [{ id: nextId++ }] };
      },
    }),
  };
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
  app.use('/api', clotureRouter);
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

test('les routes de clôture sont montées : elles ne retournent plus 404', async () => {
  await withApi(fakeDb(), async (request) => {
    // Sans année, la route répond 400 (elle est atteinte) — pas 404.
    const preview = await request('GET', '/cloture-exercice/preview');
    assert.equal(preview.status, 400);
    assert.equal((await preview.json()).error, 'Année requise');

    const execution = await request('POST', '/cloture-exercice', {});
    assert.equal(execution.status, 400);
    assert.equal((await execution.json()).error, 'Année requise');
  });
});

test("l'aperçu de clôture d'une entreprise en perte reporte le résultat en 129", async () => {
  const fake = fakeDb({ selectRows: [ECRITURES_2025, [], LIGNES_2025] });
  await withApi(fake, async (request) => {
    const response = await request('GET', '/cloture-exercice/preview?annee=2025');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.annee, 2025);
    assert.equal(body.comptesResultat.totalCharges, 25000);
    assert.equal(body.comptesResultat.totalProduits, 0);
    assert.equal(body.resultatNet, -25000);
    assert.equal(body.typeResultat, 'perte');
    assert.equal(body.compteResultat, '129');
    assert.deepEqual(
      body.comptesBilan.map((c) => [c.numero, c.solde]),
      [['57', -25000]],
    );
  });
});

test("l'exécution de la clôture d'une entreprise en perte crée CLO-2025-001 et AN-2026-001 équilibrées", async () => {
  const fake = fakeDb({
    selectRows: [ECRITURES_2025, LIGNES_2025],
    journaux: [{ id: 1, code: 'OD' }, { id: 2, code: 'AN' }],
  });
  await withApi(fake, async (request) => {
    const response = await request('POST', '/cloture-exercice', { annee: 2025 });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.details.resultatNet, -25000);
    assert.equal(body.details.typeResultat, 'perte');
    assert.equal(body.details.compteResultat, '129');
    assert.equal(body.details.ecritureCloture.numero, 'CLO-2025-001');
    assert.equal(body.details.ecritureOuverture.numero, 'AN-2026-001');
    assert.equal(body.details.ecritureOuverture.totalDebit, 25000);
    assert.equal(body.details.ecritureOuverture.totalCredit, 25000);

    // L'écriture de clôture solde le 613 et reporte la perte en 129.
    const ecritures = fake.insertions.filter((i) => i.rows?.numeroEcriture);
    assert.equal(ecritures.length, 2);
    const lignes = fake.insertions.filter((i) => Array.isArray(i.rows) && i.rows[0]?.ecritureId);
    assert.equal(lignes.length, 2);
    const lignesCloture = lignes[0].rows;
    assert.deepEqual(
      lignesCloture.map((l) => [l.compteComptableId, Number(l.debit), Number(l.credit)]),
      [[1, 0, 25000], [5, 25000, 0]],
    );
    const lignesOuverture = lignes[1].rows;
    assert.deepEqual(
      lignesOuverture.map((l) => [l.compteComptableId, Number(l.debit), Number(l.credit)]),
      [[3, 0, 25000], [5, 25000, 0]],
    );
  });
});
