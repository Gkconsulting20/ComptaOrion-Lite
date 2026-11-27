import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runWithDatabaseContext } from '../src/db.js';
import { comptesBancaires, transactionsTresorerie } from '../src/schema.js';
import { enregistrerDecaissementTresorerie, getOrCreateCaisseAccount } from '../src/services/tresorerieService.js';

process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';
const { default: depensesRouter } = await import('../src/routes/dépenses.js');

// Décaissements en trésorerie (Lite) — miroir des encaissements (79c0f51) :
// avant, les remboursements de dépenses (D 421 / C 57) et les dépenses
// directes (D charge / C 57) sortaient de la caisse sans jamais alimenter
// transactions_tresorerie. Le test utilise une base factice.

const COMPTE_57 = { id: 46, entrepriseId: 13, numero: '57', nom: 'Caisse (compte principal)', actif: true };
const COMPTE_421 = { id: 45, entrepriseId: 13, numero: '421', nom: 'Personnel - Rémunérations dues', actif: true };
const JOURNAL_CA = { id: 4, entrepriseId: 13, code: 'CA', nom: 'Journal de Caisse' };
const CAISSE = { id: 77, entrepriseId: 13, nomCompte: 'Caisse', type: 'caisse', compteComptableId: 46, soldeActuel: '1781800', actif: true };
const BANQUE = { id: 78, entrepriseId: 13, nomCompte: 'Banque principale', type: 'banque', compteComptableId: null, soldeActuel: '0', actif: true };

function fakeDb({ selectRows = [] } = {}) {
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
  const fake = {
    insertions,
    updates,
    select: () => chain,
    execute: async () => ({ rows: [] }),
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
        return { where: () => Promise.resolve([{ id: 1, ...values }]) };
      },
    }),
  };
  fake.transaction = async (cb) => cb(fake);
  return fake;
}

const BASE_DECAISSEMENT = {
  entrepriseId: 13,
  montant: 15000,
  dateTransaction: '2026-12-16',
  reference: 'RMB-2',
  numeroPiece: 'RMB-2',
  modePaiement: 'especes',
  description: 'Remboursement dépense Employé - Avance frais mission',
  categorie: 'Remboursement dépense',
  tiersNom: 'Employé',
  userId: 13,
};

test('espèces sans compte : le compte « Caisse » est créé puis le décaissement est inscrit', async () => {
  // File : déduplication (absente), recherche caisse (absente), compte 57.
  const fake = fakeDb({ selectRows: [[], [], [COMPTE_57]] });
  const created = await runWithDatabaseContext({ db: fake, pool: {} }, () =>
    enregistrerDecaissementTresorerie({ ...BASE_DECAISSEMENT, executor: fake }));
  assert.ok(created, 'transaction attendue');
  assert.equal(created.type, 'decaissement');
  assert.equal(created.montant, '15000.00');
  assert.equal(created.numeroPiece, 'RMB-2');

  const caisseInsert = fake.insertions.find((i) => i.table === comptesBancaires);
  assert.ok(caisseInsert, 'création du compte Caisse attendue');
  assert.equal(caisseInsert.rows.type, 'caisse');

  const mouvement = fake.insertions.find((i) => i.table === transactionsTresorerie);
  assert.ok(mouvement, 'mouvement de trésorerie attendu');
  assert.equal(mouvement.rows.type, 'decaissement');
  assert.equal(mouvement.rows.montant, '15000.00');
  assert.equal(mouvement.rows.compteBancaireId, 100);
  assert.equal(fake.updates.filter((u) => u.table === comptesBancaires).length, 1);
});

test('décaissement déjà enregistré pour la pièce : retourné sans doublon ni second débit', async () => {
  const existing = { id: 55, type: 'decaissement', numeroPiece: 'RMB-2', montant: '15000.00' };
  const fake = fakeDb({ selectRows: [[existing]] });
  const result = await runWithDatabaseContext({ db: fake, pool: {} }, () =>
    enregistrerDecaissementTresorerie({ ...BASE_DECAISSEMENT, executor: fake }));
  assert.equal(result.id, 55);
  assert.equal(fake.insertions.length, 0);
  assert.equal(fake.updates.length, 0);
});

test('virement avec compte désigné : le compte est utilisé ; sans compte : rien n’est écrit', async () => {
  const withBank = fakeDb({ selectRows: [[], [BANQUE]] });
  const created = await runWithDatabaseContext({ db: withBank, pool: {} }, () =>
    enregistrerDecaissementTresorerie({ ...BASE_DECAISSEMENT, modePaiement: 'virement', compteBancaireId: 78, executor: withBank }));
  assert.ok(created);
  assert.equal(withBank.insertions.find((i) => i.table === transactionsTresorerie).rows.compteBancaireId, BANQUE.id);

  const withoutBank = fakeDb({ selectRows: [[]] });
  const skipped = await runWithDatabaseContext({ db: withoutBank, pool: {} }, () =>
    enregistrerDecaissementTresorerie({ ...BASE_DECAISSEMENT, modePaiement: 'virement', executor: withoutBank }));
  assert.equal(skipped, null);
  assert.equal(withoutBank.insertions.length, 0);
});

test('chèque : rien n’est écrit', async () => {
  const fake = fakeDb();
  const skipped = await runWithDatabaseContext({ db: fake, pool: {} }, () =>
    enregistrerDecaissementTresorerie({ ...BASE_DECAISSEMENT, modePaiement: 'cheque', executor: fake }));
  assert.equal(skipped, null);
  assert.equal(fake.insertions.length, 0);
});

test('montant invalide : 400, pas de mouvement', async () => {
  const fake = fakeDb();
  await assert.rejects(
    runWithDatabaseContext({ db: fake, pool: {} }, () =>
      enregistrerDecaissementTresorerie({ ...BASE_DECAISSEMENT, montant: 0, executor: fake })),
    (error) => error.status === 400 && /positif/.test(error.message),
  );
  assert.equal(fake.insertions.length, 0);
});

// --- Route : POST /depenses/remboursement alimente la trésorerie ---

const DEPENSE = {
  id: 21,
  entrepriseId: 13,
  employeId: 13,
  categorieId: 8,
  montant: '15000.00',
  dateDepense: '2026-12-15',
  description: 'Avance frais mission - decembre 2026',
  statut: 'approuvée',
  montantApprouve: '15000.00',
  montantRembourse: '0.00',
};

function fakeDbDepenses({ selectRows = [] } = {}) {
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
  const fake = {
    insertions,
    updates,
    query: {
      depenses: { findFirst: async () => DEPENSE },
      employes: { findFirst: async () => null },
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
        return { where: () => ({ returning: async () => [{ id: 1, ...values }] }) };
      },
    }),
  };
  fake.transaction = async (cb) => cb(fake);
  return fake;
}

async function withDepensesApi(fake, run) {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { id: 13, entrepriseId: 13 };
    req.userId = 13;
    req.entrepriseId = 13;
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

test('POST /depenses/remboursement en espèces : mouvement de décaissement en trésorerie', async () => {
  // File : écriture (421, 57, journal CA, paramètres, compteur, lignes),
  // puis décaissement (déduplication absente, caisse absente, compte 57).
  const fake = fakeDbDepenses({
    selectRows: [
      [COMPTE_421], [COMPTE_57], [JOURNAL_CA], [], [{ count: '7' }], [COMPTE_421], [COMPTE_57],
      [], [], [COMPTE_57],
    ],
  });
  await withDepensesApi(fake, async (request) => {
    const res = await request('POST', '/depenses/remboursement', {
      entrepriseId: 13,
      depenseId: 21,
      montantRembourse: 15000,
      dateRemboursement: '2026-12-16',
      methodePaiement: 'especes',
      userId: 13,
    });
    assert.equal(res.status, 200);
    const mouvement = fake.insertions.find((i) => i.table === transactionsTresorerie);
    assert.ok(mouvement, 'mouvement de décaissement attendu');
    assert.equal(mouvement.rows.type, 'decaissement');
    assert.equal(mouvement.rows.montant, '15000.00');
    assert.equal(mouvement.rows.numeroPiece, 'RMB-100');
    assert.equal(mouvement.rows.categorie, 'Remboursement dépense');
    const soldeUpdate = fake.updates.find((u) => u.table === comptesBancaires);
    assert.ok(soldeUpdate, 'décrément du solde du compte attendu');
  });
});
