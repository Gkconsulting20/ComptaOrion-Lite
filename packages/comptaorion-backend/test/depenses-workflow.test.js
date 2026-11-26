import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runWithDatabaseContext } from '../src/db.js';
import { depenses } from '../src/schema.js';

process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';
const { default: depensesRouter } = await import('../src/routes/dépenses.js');

// Workflow d'approbation des dépenses (Lite) — exercice 2026,
// entreprise test 13, dépense n° 21 : « Avance frais mission -
// decembre 2026 », 15 000 FCFA, catégorie Transport (id 8).
// Erreurs corrigées : l'approbation ne créait aucune écriture (la
// charge n'atteignait jamais le résultat) ; le remboursement créait
// D 421 / C 57 valide=false ; et « 0.00 » + 15000 = « 0.0015000 »
// (concaténation de chaîne) donnait montantRembourse 0,00 et statut
// « partiellement_remboursée » au lieu de « remboursée ».
// Le test utilise une base factice : aucune connexion à la base live.

const DEPENSE = {
  id: 21,
  entrepriseId: 13,
  employeId: 13,
  categorieId: 8,
  montant: '15000.00',
  dateDepense: '2026-12-15',
  description: 'Avance frais mission - decembre 2026',
  statut: 'en_attente',
  montantApprouve: '0.00',
  montantRembourse: '0.00',
};
const CATEGORIE_TRANSPORT = { id: 8, entrepriseId: 13, nom: 'Transport' };
const COMPTE_624 = { id: 44, entrepriseId: 13, numero: '624', nom: 'Frais de transport et de déplacements', actif: true };
const COMPTE_421 = { id: 45, entrepriseId: 13, numero: '421', nom: 'Personnel - Rémunérations dues', actif: true };
const COMPTE_57 = { id: 46, entrepriseId: 13, numero: '57', nom: 'Caisse (compte principal)', actif: true };
const JOURNAL_OD = { id: 3, entrepriseId: 13, code: 'OD', nom: 'Journal des opérations diverses' };
const JOURNAL_CA = { id: 4, entrepriseId: 13, code: 'CA', nom: 'Journal de Caisse' };

function fakeDb({ selectRows = [], depense = DEPENSE, employe = null } = {}) {
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
      depenses: { findFirst: async () => depense },
      employes: { findFirst: async () => employe },
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
            returning: async () => [{ id: 1, ...values }],
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

function lignesEcriture(fake) {
  return fake.insertions.filter((i) => i.rows?.compteComptableId !== undefined).map((i) => i.rows);
}

test('approbation manager : étape suivante créée, aucune écriture comptable', async () => {
  const fake = fakeDb();
  await withApi(fake, async (request) => {
    const res = await request('POST', '/depenses/approve/21/manager', { statut: 'approuvée', userId: 13 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message, "Dépense approuvée pour l'étape: manager");
    const nextStep = fake.insertions.find((i) => i.rows?.etape === 'comptable');
    assert.ok(nextStep, 'étape comptable attendue');
    assert.equal(nextStep.rows.statut, 'en_attente');
    assert.equal(fake.insertions.filter((i) => i.rows?.numeroPiece === 'DEP-21').length, 0);
    // La dépense elle-même ne doit pas être marquée approuvée (seule la
    // ligne d'approbation manager l'est) : la charge n'est créée qu'à
    // l'étape comptable.
    assert.equal(fake.updates.filter((u) => u.table === depenses && u.values?.statut === 'approuvée').length, 0);
  });
});

test('approbation comptable : la charge entre au résultat (OD D 624 / C 421, valide)', async () => {
  // File des lectures : catégorie, compte de charge 624, compte 421,
  // garde DEP-21, journal OD, paramètres, compteur d'écritures,
  // validation des 2 lignes.
  const fake = fakeDb({
    selectRows: [
      [CATEGORIE_TRANSPORT], [COMPTE_624], [COMPTE_421], [], [JOURNAL_OD], [], [{ count: '3' }],
      [COMPTE_624], [COMPTE_421],
    ],
  });
  await withApi(fake, async (request) => {
    const res = await request('POST', '/depenses/approve/21/comptable', { statut: 'approuvée', userId: 13 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message, "Dépense approuvée pour l'étape: comptable");

    const ecriture = fake.insertions.find((i) => i.rows?.numeroPiece === 'DEP-21');
    assert.ok(ecriture, 'écriture de charge DEP-21 attendue');
    assert.equal(ecriture.rows.valide, true);
    assert.equal(ecriture.rows.journalId, JOURNAL_OD.id);
    assert.equal(ecriture.rows.libelle, 'Charge approuvée - Avance frais mission - decembre 2026');

    const lignes = lignesEcriture(fake);
    const debitCharge = lignes.find((l) => l.compteComptableId === COMPTE_624.id);
    const creditAvance = lignes.find((l) => l.compteComptableId === COMPTE_421.id);
    assert.equal(debitCharge.debit, '15000.00');
    assert.equal(debitCharge.credit, '0.00');
    assert.equal(creditAvance.debit, '0.00');
    assert.equal(creditAvance.credit, '15000.00');

    const updateDepense = fake.updates.find((u) => u.table === depenses && u.values?.statut === 'approuvée');
    assert.ok(updateDepense, 'dépense marquée approuvée');
    assert.equal(updateDepense.values.montantApprouve, '15000.00');
  });
});

test('remboursement : valide=true, montant 15 000 (nombre, pas « 0.0015000 »), statut remboursée', async () => {
  // File des lectures : compte 421, compte 57, journal CA, paramètres,
  // compteur d'écritures, validation des 2 lignes.
  const fake = fakeDb({
    depense: { ...DEPENSE, statut: 'approuvée', montantApprouve: '15000.00', montantRembourse: '0.00' },
    selectRows: [[COMPTE_421], [COMPTE_57], [JOURNAL_CA], [], [{ count: '7' }], [COMPTE_421], [COMPTE_57]],
  });
  await withApi(fake, async (request) => {
    const res = await request('POST', '/depenses/remboursement', {
      entrepriseId: 13,
      depenseId: 21,
      montantRembourse: 15000,
      dateRemboursement: '2026-12-16',
      methodePaiement: 'especes',
      userId: 13,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // La base factice renvoie la valeur telle qu'insérée (nombre) ;
    // Postgres renvoie la décimale en chaîne « 15000.00 ».
    assert.equal(Number(body.montantRembourse), 15000);

    // Le total remboursé est un NOMBRE : 0 + 15000, pas la chaîne
    // « 0.0015000 » que donnait « 0.00 » + 15000.
    const updateDepense = fake.updates.find((u) => u.values?.montantRembourse !== undefined);
    assert.ok(updateDepense, 'mise à jour de la dépense attendue');
    assert.equal(updateDepense.values.montantRembourse, 15000);
    assert.equal(typeof updateDepense.values.montantRembourse, 'number');
    assert.equal(updateDepense.values.statut, 'remboursée');

    const ecriture = fake.insertions.find((i) => i.rows?.numeroPiece === 'RMB-100');
    assert.ok(ecriture, 'écriture de remboursement attendue');
    assert.equal(ecriture.rows.valide, true);
    assert.equal(ecriture.rows.journalId, JOURNAL_CA.id);

    const lignes = lignesEcriture(fake);
    const debitAvance = lignes.find((l) => l.compteComptableId === COMPTE_421.id);
    const creditCaisse = lignes.find((l) => l.compteComptableId === COMPTE_57.id);
    assert.equal(debitAvance.debit, '15000.00');
    assert.equal(creditCaisse.credit, '15000.00');
  });
});

test('remboursement partiel : statut partiellement_remboursée et montant cumulé', async () => {
  const fake = fakeDb({
    depense: { ...DEPENSE, statut: 'approuvée', montantApprouve: '15000.00', montantRembourse: '5000.00' },
    selectRows: [[COMPTE_421], [COMPTE_57], [JOURNAL_CA], [], [{ count: '7' }], [COMPTE_421], [COMPTE_57]],
  });
  await withApi(fake, async (request) => {
    const res = await request('POST', '/depenses/remboursement', {
      entrepriseId: 13,
      depenseId: 21,
      montantRembourse: 5000,
      dateRemboursement: '2026-12-16',
      methodePaiement: 'especes',
      userId: 13,
    });
    assert.equal(res.status, 200);
    const updateDepense = fake.updates.find((u) => u.values?.montantRembourse !== undefined);
    assert.equal(updateDepense.values.montantRembourse, 10000);
    assert.equal(updateDepense.values.statut, 'partiellement_remboursée');
  });
});
