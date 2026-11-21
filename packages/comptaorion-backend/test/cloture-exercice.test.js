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
  const fake = {
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
  // La réouverture crée ses contrepassations dans une transaction.
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
    // Garde anti-double-clôture : aucune clôture existante (CLO, AN vides),
    // puis les écritures et lignes de l'exercice.
    selectRows: [[], [], ECRITURES_2025, LIGNES_2025],
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

// ==========================================
// GARDE ANTI-DOUBLE-CLÔTURE ET RÉOUVERTURE
// ==========================================

// État simulé après une clôture 2025 (perte 25 000) : CLO-2025-001 solde
// le 613 et reporte la perte en 129 ; AN-2026-001 reprend les soldes.
const ECRITURE_CLOTURE = {
  id: 20, numeroEcriture: 'CLO-2025-001', numeroPiece: 'CLOTURE-2025',
  dateEcriture: '2025-12-31', journalId: 1,
};
const ECRITURE_OUVERTURE = {
  id: 21, numeroEcriture: 'AN-2026-001', numeroPiece: 'OUVERTURE-2026',
  dateEcriture: '2026-01-01', journalId: 2,
};
const LIGNES_CLOTURE = [
  { compteComptableId: 1, debit: '0', credit: '25000', ecritureId: 20, libelle: 'Solde compte 613 - Loyers' },
  { compteComptableId: 5, debit: '25000', credit: '0', ecritureId: 20, libelle: "Résultat de l'exercice 2025" },
];
const LIGNES_OUVERTURE = [
  { compteComptableId: 3, debit: '0', credit: '25000', ecritureId: 21, libelle: 'Report à nouveau 57' },
  { compteComptableId: 5, debit: '25000', credit: '0', ecritureId: 21, libelle: 'Report à nouveau 129' },
];
const CONTREPASSATION_CLOTURE = {
  id: 22, numeroEcriture: 'CLO-2025-001-R', numeroPiece: 'REOUVERTURE-CLOTURE-2025-R1',
  dateEcriture: '2025-12-31', journalId: 1,
};
const MOTIF = 'Correction : exercice rouvert pour ajustement';

test('double clôture refusée : la deuxième exécution retourne 409', async () => {
  const fake = fakeDb({
    // 1re exécution : aucune clôture existante. 2e exécution : CLO-2025-001
    // existe et n\'a pas été contrepassée → garde déclenchée.
    selectRows: [[], [], ECRITURES_2025, LIGNES_2025, [ECRITURE_CLOTURE], []],
    journaux: [{ id: 1, code: 'OD' }, { id: 2, code: 'AN' }],
  });
  await withApi(fake, async (request) => {
    const premiere = await request('POST', '/cloture-exercice', { annee: 2025 });
    assert.equal(premiere.status, 200);
    assert.equal((await premiere.json()).details.ecritureCloture.numero, 'CLO-2025-001');

    const seconde = await request('POST', '/cloture-exercice', { annee: 2025 });
    assert.equal(seconde.status, 409);
    assert.equal((await seconde.json()).error, 'Exercice 2025 déjà clôturé');
  });
});

test("réouverture d'un exercice clôturé crée les contrepassations (montants inversés)", async () => {
  const fake = fakeDb({
    selectRows: [[ECRITURE_CLOTURE], [ECRITURE_OUVERTURE], LIGNES_CLOTURE, LIGNES_OUVERTURE],
    journaux: [{ id: 1, code: 'OD' }, { id: 2, code: 'AN' }],
  });
  await withApi(fake, async (request) => {
    const response = await request('POST', '/cloture-exercice/2025/reouverture', { motif: MOTIF });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.details.exercice, 2025);
    assert.equal(body.details.sequence, 1);
    assert.equal(body.details.motif, MOTIF);
    assert.equal(body.details.ecritureContrepassationCloture, 'CLO-2025-001-R');
    assert.equal(body.details.ecritureContrepassationOuverture, 'AN-2026-001-R');

    // Les deux contrepassations sont créées, avec les bonnes pièces.
    const ecritures = fake.insertions.filter((i) => i.rows?.numeroEcriture);
    assert.equal(ecritures.length, 2);
    assert.deepEqual(
      ecritures.map((i) => [i.rows.numeroEcriture, i.rows.numeroPiece]),
      [
        ['CLO-2025-001-R', 'REOUVERTURE-CLOTURE-2025-R1'],
        ['AN-2026-001-R', 'REOUVERTURE-OUVERTURE-2025-R1'],
      ],
    );
    // Les lignes sont inversées (débit ↔ crédit) par rapport aux originales.
    const lignes = fake.insertions.filter((i) => Array.isArray(i.rows) && i.rows[0]?.ecritureId);
    assert.equal(lignes.length, 2);
    const lignesContreCloture = lignes[0].rows;
    assert.deepEqual(
      lignesContreCloture.map((l) => [l.compteComptableId, Number(l.debit), Number(l.credit)]),
      [[1, 25000, 0], [5, 0, 25000]],
    );
    const lignesContreOuverture = lignes[1].rows;
    assert.deepEqual(
      lignesContreOuverture.map((l) => [l.compteComptableId, Number(l.debit), Number(l.credit)]),
      [[3, 25000, 0], [5, 0, 25000]],
    );
    // Audit de la réouverture.
    const audit = fake.insertions.filter((i) => i.rows?.action === 'REOUVERTURE_EXERCICE');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].rows.tableName, 'ecritures');
  });
});

test("réouverture d'un exercice jamais clôturé retourne 404 (motif trop court → 400)", async () => {
  const fake = fakeDb({ selectRows: [[], []] });
  await withApi(fake, async (request) => {
    const sansMotif = await request('POST', '/cloture-exercice/2025/reouverture', { motif: 'court' });
    assert.equal(sansMotif.status, 400);
    assert.match((await sansMotif.json()).error, /motif de réouverture/);

    const jamaisCloture = await request('POST', '/cloture-exercice/2025/reouverture', { motif: MOTIF });
    assert.equal(jamaisCloture.status, 404);
    assert.equal((await jamaisCloture.json()).error, "L'exercice 2025 n'a jamais été clôturé.");
  });
});

test('deuxième réouverture refusée : la clôture a déjà été contrepassée', async () => {
  const fake = fakeDb({
    selectRows: [[ECRITURE_CLOTURE, CONTREPASSATION_CLOTURE], []],
  });
  await withApi(fake, async (request) => {
    const response = await request('POST', '/cloture-exercice/2025/reouverture', { motif: MOTIF });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "L'exercice 2025 a déjà été réouvert.");
  });
});

test('nouvelle clôture après réouverture autorisée avec la séquence suivante (-002)', async () => {
  const fake = fakeDb({
    // La clôture -001 existe mais a été contrepassée → la garde laisse passer
    // et la numérotation reprend à -002 (la -001, même contrepassée, n'est
    // pas réutilisée).
    selectRows: [[ECRITURE_CLOTURE, CONTREPASSATION_CLOTURE], [ECRITURE_OUVERTURE], ECRITURES_2025, LIGNES_2025],
    journaux: [{ id: 1, code: 'OD' }, { id: 2, code: 'AN' }],
  });
  await withApi(fake, async (request) => {
    const response = await request('POST', '/cloture-exercice', { annee: 2025 });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.details.ecritureCloture.numero, 'CLO-2025-002');
    assert.equal(body.details.ecritureOuverture.numero, 'AN-2026-002');

    const ecritures = fake.insertions.filter((i) => i.rows?.numeroEcriture);
    assert.deepEqual(
      ecritures.map((i) => [i.rows.numeroEcriture, i.rows.numeroPiece]),
      [
        ['CLO-2025-002', 'CLOTURE-2025-2'],
        ['AN-2026-002', 'OUVERTURE-2026-2'],
      ],
    );
  });
});
