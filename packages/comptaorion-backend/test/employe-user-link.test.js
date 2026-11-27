import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runWithDatabaseContext } from '../src/db.js';
import { employes, transactionsTresorerie } from '../src/schema.js';

process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';
const { default: depensesRouter } = await import('../src/routes/dépenses.js');

// Liaison annuaire ↔ compte utilisateur (Lite) : depense.employeId est
// l'id du COMPTE utilisateur, pas l'id de l'annuaire. Le remboursement
// cherche donc l'employé par userId d'abord, puis par id (repli).
// POST/PUT /depenses/employes acceptent un userId optionnel, vérifié
// (compte de la même entreprise ; null = retirer le lien). Aucune
// liaison automatique n'est imposée. Base factice, pas de base live.

const EXISTING = { id: 5, entrepriseId: 9, nom: 'Konan', prenom: 'Awa', telephone: '+228 90 00 00 00', poste: 'Vendeuse', actif: true };
const COMPTE_421 = { id: 45, entrepriseId: 13, numero: '421', nom: 'Personnel - Rémunérations dues', actif: true };
const COMPTE_57 = { id: 46, entrepriseId: 13, numero: '57', nom: 'Caisse (compte principal)', actif: true };
const JOURNAL_CA = { id: 4, entrepriseId: 13, code: 'CA', nom: 'Journal de Caisse' };

function fakeDb({ selectRows = [], employeByUser = null, employeById = null, updateBase = null } = {}) {
  const insertions = [];
  const updates = [];
  let nextId = 100;
  const queue = [...selectRows];
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(queue.shift() || []),
    then: (resolve, reject) => Promise.resolve(queue.shift() || []).then(resolve, reject),
  };
  let employeCalls = 0;
  const fake = {
    insertions,
    updates,
    query: {
      employes: {
        findFirst: async () => {
          employeCalls += 1;
          // 1er appel : recherche par userId ; 2e : repli par id.
          return employeCalls === 1 ? employeByUser : employeById;
        },
      },
      depenses: {
        findFirst: async () => ({
          id: 21, entrepriseId: 13, employeId: 13, categorieId: 8,
          montant: '15000.00', dateDepense: '2026-12-15',
          description: 'Avance frais mission - decembre 2026',
          statut: 'approuvée', montantApprouve: '15000.00', montantRembourse: '0.00',
        }),
      },
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
        return { where: () => ({ returning: async () => [{ ...(updateBase || { id: 5 }), ...values }] }) };
      },
    }),
  };
  fake.transaction = async (cb) => cb(fake);
  return fake;
}

async function withApi(fake, entrepriseId, run) {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { id: 7, entrepriseId };
    req.userId = 7;
    req.entrepriseId = entrepriseId;
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

test('POST /depenses/employes avec userId valide : lien enregistré', async () => {
  const fake = fakeDb({ selectRows: [[{ id: 7 }]] });
  await withApi(fake, 9, async (request) => {
    const res = await request('POST', '/depenses/employes', { nom: 'Konan', prenom: 'Awa', userId: 7 });
    assert.equal(res.status, 201);
    const insertion = fake.insertions.find((i) => i.rows?.nom === 'Konan');
    assert.ok(insertion);
    assert.equal(insertion.rows.userId, 7);
  });
});

test('POST /depenses/employes avec userId inconnu : 400, rien créé', async () => {
  const fake = fakeDb({ selectRows: [[]] });
  await withApi(fake, 9, async (request) => {
    const res = await request('POST', '/depenses/employes', { nom: 'Konan', prenom: 'Awa', userId: 999 });
    assert.equal(res.status, 400);
    assert.equal(fake.insertions.length, 0);
  });
});

test('PUT /depenses/employes/:id avec userId : lien posé ; avec null : lien retiré', async () => {
  const fakeLink = fakeDb({ selectRows: [[{ id: 7 }], [EXISTING]], updateBase: EXISTING });
  await withApi(fakeLink, 9, async (request) => {
    const res = await request('PUT', '/depenses/employes/5', { userId: 7 });
    assert.equal(res.status, 200);
    assert.equal(fakeLink.updates[0].values.userId, 7);
  });
  const fakeUnlink = fakeDb({ selectRows: [[EXISTING]], updateBase: EXISTING });
  await withApi(fakeUnlink, 9, async (request) => {
    const res = await request('PUT', '/depenses/employes/5', { userId: null });
    assert.equal(res.status, 200);
    assert.equal(fakeUnlink.updates[0].values.userId, null);
  });
});

test('remboursement : le nom vient de l’employé lié par userId (pas « Employé »)', async () => {
  const linked = { id: 2, entrepriseId: 13, userId: 13, nom: 'Agbodji', prenom: 'Kossi' };
  const fake = fakeDb({
    employeByUser: linked,
    employeById: null,
    selectRows: [
      [COMPTE_421], [COMPTE_57], [JOURNAL_CA], [], [{ count: '7' }], [COMPTE_421], [COMPTE_57],
      [], [], [COMPTE_57],
    ],
  });
  await withApi(fake, 13, async (request) => {
    const res = await request('POST', '/depenses/remboursement', {
      entrepriseId: 13,
      depenseId: 21,
      montantRembourse: 15000,
      dateRemboursement: '2026-12-16',
      methodePaiement: 'especes',
      userId: 13,
    });
    assert.equal(res.status, 200);
    const ecriture = fake.insertions.find((i) => i.rows?.numeroPiece === 'RMB-100');
    assert.ok(ecriture, 'écriture de remboursement attendue');
    assert.match(ecriture.rows.libelle, /Kossi Agbodji/);
    assert.doesNotMatch(ecriture.rows.libelle, /Employé -/);
    const mouvement = fake.insertions.find((i) => i.table === transactionsTresorerie);
    assert.ok(mouvement, 'décaissement attendu');
    assert.match(mouvement.rows.description, /Kossi Agbodji/);
  });
});

test('remboursement : repli par id quand aucun employé n’est lié par userId', async () => {
  const byId = { id: 13, entrepriseId: 13, userId: null, nom: 'Mensah', prenom: 'Kofi' };
  const fake = fakeDb({
    employeByUser: null,
    employeById: byId,
    selectRows: [
      [COMPTE_421], [COMPTE_57], [JOURNAL_CA], [], [{ count: '7' }], [COMPTE_421], [COMPTE_57],
      [], [], [COMPTE_57],
    ],
  });
  await withApi(fake, 13, async (request) => {
    const res = await request('POST', '/depenses/remboursement', {
      entrepriseId: 13,
      depenseId: 21,
      montantRembourse: 15000,
      dateRemboursement: '2026-12-16',
      methodePaiement: 'especes',
      userId: 13,
    });
    assert.equal(res.status, 200);
    const ecriture = fake.insertions.find((i) => i.rows?.numeroPiece === 'RMB-100');
    assert.ok(ecriture);
    assert.match(ecriture.rows.libelle, /Kofi Mensah/);
  });
});
