import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runWithDatabaseContext } from '../src/db.js';
import { comptesBancaires, transactionsTresorerie } from '../src/schema.js';
import { enregistrerEncaissementTresorerie, getOrCreateCaisseAccount } from '../src/services/tresorerieService.js';

process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';
const { default: facturesRouter } = await import('../src/routes/factures.js');

// Trésorerie vide malgré les encaissements (Lite) — exercice 2026,
// entreprise test 13 : 1 781 800 FCFA encaissés, 0 ligne dans
// transactions_tresorerie. Causes : POST /factures/:id/paiement
// n'écrivait que si un compteBancaireId était fourni, et
// POST /factures/lite-sale (vente comptant) n'écrivait jamais.
// Le test utilise une base factice : aucune connexion à la base live.

const COMPTE_57 = { id: 46, entrepriseId: 13, numero: '57', nom: 'Caisse (compte principal)', actif: true };
const COMPTE_411 = { id: 47, entrepriseId: 13, numero: '411', nom: 'Clients', actif: true };
const COMPTE_701 = { id: 48, entrepriseId: 13, numero: '701', nom: 'Ventes de marchandises', actif: true };
const COMPTE_443 = { id: 49, entrepriseId: 13, numero: '443', nom: 'État - TVA facturée', actif: true };
const JOURNAL_CA = { id: 4, entrepriseId: 13, code: 'CA', nom: 'Journal de Caisse' };
const JOURNAL_VT = { id: 5, entrepriseId: 13, code: 'VT', nom: 'Journal des Ventes' };
const CAISSE = { id: 77, entrepriseId: 13, nomCompte: 'Caisse', type: 'caisse', compteComptableId: 46, soldeActuel: '0', actif: true };
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

async function withApi(fake, run) {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { id: 13, entrepriseId: 13 };
    req.userId = 13;
    req.entrepriseId = 13;
    return runWithDatabaseContext({ db: fake, pool: {} }, next);
  });
  app.use('/api/factures', facturesRouter);
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

const BASE_ENCAISSEMENT = {
  entrepriseId: 13,
  montant: 118000,
  dateTransaction: '2026-02-10',
  reference: 'PAI-11',
  numeroPiece: 'FACT-2026-13-0002',
  modePaiement: 'especes',
  description: 'Paiement facture FACT-2026-13-0002',
  tiersNom: 'Mensah Kossi',
  userId: 13,
};

test('espèces sans compte : le compte « Caisse » est créé puis l’encaissement est inscrit', async () => {
  // File : recherche caisse (absente), compte comptable 57.
  const fake = fakeDb({ selectRows: [[], [COMPTE_57]] });
  const created = await runWithDatabaseContext({ db: fake, pool: {} }, () =>
    enregistrerEncaissementTresorerie({ ...BASE_ENCAISSEMENT, executor: fake }));
  assert.ok(created, 'transaction attendue');
  assert.equal(created.type, 'encaissement');
  assert.equal(created.montant, '118000.00');

  const caisseInsert = fake.insertions.find((i) => i.table === comptesBancaires);
  assert.ok(caisseInsert, 'création du compte Caisse attendue');
  assert.equal(caisseInsert.rows.nomCompte, 'Caisse');
  assert.equal(caisseInsert.rows.type, 'caisse');
  assert.equal(caisseInsert.rows.compteComptableId, COMPTE_57.id);

  const mouvement = fake.insertions.find((i) => i.table === transactionsTresorerie);
  assert.ok(mouvement, 'mouvement de trésorerie attendu');
  assert.equal(mouvement.rows.type, 'encaissement');
  assert.equal(mouvement.rows.montant, '118000.00');
  assert.equal(mouvement.rows.compteBancaireId, 100);
  assert.equal(mouvement.rows.numeroPiece, 'FACT-2026-13-0002');
  assert.equal(fake.updates.filter((u) => u.table === comptesBancaires).length, 1);
});

test('espèces avec une Caisse existante : réutilisée, pas de doublon', async () => {
  const fake = fakeDb({ selectRows: [[CAISSE]] });
  const created = await runWithDatabaseContext({ db: fake, pool: {} }, () =>
    enregistrerEncaissementTresorerie({ ...BASE_ENCAISSEMENT, executor: fake }));
  assert.ok(created);
  assert.equal(fake.insertions.filter((i) => i.table === comptesBancaires).length, 0);
  const mouvement = fake.insertions.find((i) => i.table === transactionsTresorerie);
  assert.equal(mouvement.rows.compteBancaireId, CAISSE.id);
});

test('virement avec compte désigné : le compte est utilisé ; sans compte : rien n’est écrit', async () => {
  const withBank = fakeDb({ selectRows: [[BANQUE]] });
  const created = await runWithDatabaseContext({ db: withBank, pool: {} }, () =>
    enregistrerEncaissementTresorerie({ ...BASE_ENCAISSEMENT, modePaiement: 'virement', compteBancaireId: 78, executor: withBank }));
  assert.ok(created);
  assert.equal(withBank.insertions.find((i) => i.table === transactionsTresorerie).rows.compteBancaireId, BANQUE.id);

  const withoutBank = fakeDb();
  const skipped = await runWithDatabaseContext({ db: withoutBank, pool: {} }, () =>
    enregistrerEncaissementTresorerie({ ...BASE_ENCAISSEMENT, modePaiement: 'virement', executor: withoutBank }));
  assert.equal(skipped, null);
  assert.equal(withoutBank.insertions.length, 0);
});

test('chèque : rien n’est écrit (le dépôt alimentera la trésorerie)', async () => {
  const fake = fakeDb();
  const skipped = await runWithDatabaseContext({ db: fake, pool: {} }, () =>
    enregistrerEncaissementTresorerie({ ...BASE_ENCAISSEMENT, modePaiement: 'cheque', executor: fake }));
  assert.equal(skipped, null);
  assert.equal(fake.insertions.length, 0);
});

test('compte bancaire désigné introuvable : 400, pas de mouvement', async () => {
  const fake = fakeDb({ selectRows: [[]] });
  await assert.rejects(
    runWithDatabaseContext({ db: fake, pool: {} }, () =>
      enregistrerEncaissementTresorerie({ ...BASE_ENCAISSEMENT, modePaiement: 'virement', compteBancaireId: 999, executor: fake })),
    (error) => error.status === 400 && /introuvable/.test(error.message),
  );
  assert.equal(fake.insertions.length, 0);
});

test('getOrCreateCaisseAccount : crée la Caisse liée au 57, puis la réutilise', async () => {
  const fake = fakeDb({ selectRows: [[], [COMPTE_57], [CAISSE]] });
  const created = await runWithDatabaseContext({ db: fake, pool: {} }, () =>
    getOrCreateCaisseAccount({ entrepriseId: 13, executor: fake }));
  assert.equal(created.nomCompte, 'Caisse');
  assert.equal(created.compteComptableId, COMPTE_57.id);
  const reused = await runWithDatabaseContext({ db: fake, pool: {} }, () =>
    getOrCreateCaisseAccount({ entrepriseId: 13, executor: fake }));
  assert.equal(reused.id, CAISSE.id);
  assert.equal(fake.insertions.filter((i) => i.table === comptesBancaires).length, 1);
});

const FACTURE_CREDIT = {
  id: 15, entrepriseId: 13, numeroFacture: 'FACT-2026-13-0002', clientId: 16,
  statut: 'envoyee', dateFacture: '2026-01-20', totalHT: '100000.00', totalTVA: '18000.00',
  totalTTC: '118000.00', montantPaye: '0.00', soldeRestant: '118000.00',
};
const CLIENT_CREDIT = {
  id: 16, entrepriseId: 13, nom: 'Mensah Kossi', compteComptableId: null,
  escomptePourcentage: '0.00', escompteDelaiJours: 0,
};

test('POST /factures/:id/paiement en espèces sans compte : 201 et mouvement en trésorerie', async () => {
  // File : facture, client, recherche caisse (absente), compte 57,
  // compte 411, compte 57 (écriture), journal CA, paramètres,
  // compteur, validation des 2 lignes de l'écriture.
  const fake = fakeDb({
    selectRows: [
      [FACTURE_CREDIT], [CLIENT_CREDIT], [], [COMPTE_57], [COMPTE_411], [COMPTE_57],
      [JOURNAL_CA], [], [{ count: '5' }], [COMPTE_57], [COMPTE_411],
    ],
  });
  await withApi(fake, async (request) => {
    const res = await request('POST', '/factures/15/paiement', {
      montant: 118000, modePaiement: 'especes', datePaiement: '2026-02-10',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.facture.statut, 'payee');
    assert.equal(body.data.facture.soldeRestant, '0.00');

    const caisseInsert = fake.insertions.find((i) => i.table === comptesBancaires);
    assert.ok(caisseInsert, 'compte Caisse créé attendu');
    assert.equal(caisseInsert.rows.type, 'caisse');

    const mouvement = fake.insertions.find((i) => i.table === transactionsTresorerie);
    assert.ok(mouvement, 'mouvement de trésorerie attendu');
    assert.equal(mouvement.rows.type, 'encaissement');
    assert.equal(mouvement.rows.montant, '118000.00');
    assert.equal(mouvement.rows.numeroPiece, 'FACT-2026-13-0002');
    assert.equal(mouvement.rows.modePaiement, 'especes');
  });
});

test('POST /factures/lite-sale avec paiement comptant : mouvement en trésorerie', async () => {
  // File : taux TVA, dernière facture (aucune), compte 411, 701, 443
  // (écriture de vente), journal VT, paramètres, compteur, validation
  // des 3 lignes, compte 411, 57 (écriture de paiement), journal CA,
  // paramètres, compteur, validation des 2 lignes, recherche caisse
  // (absente), compte 57.
  const fake = fakeDb({
    selectRows: [
      [{ tauxTva: '18' }], [], [COMPTE_411], [COMPTE_701], [COMPTE_443], [JOURNAL_VT],
      [], [{ count: '2' }], [COMPTE_411], [COMPTE_701], [COMPTE_443],
      [COMPTE_411], [COMPTE_57], [JOURNAL_CA], [], [{ count: '6' }],
      [COMPTE_57], [COMPTE_411], [], [COMPTE_57],
    ],
  });
  await withApi(fake, async (request) => {
    const res = await request('POST', '/factures/lite-sale', {
      newClient: { nom: 'Client Comptant Janvier', telephone: '+22890000101' },
      dateFacture: '2026-01-15',
      items: [{ description: 'Conseil en gestion - janvier 2026', quantite: 1, prixUnitaire: 150000 }],
      paiement: { montant: 177000, modePaiement: 'especes', datePaiement: '2026-01-15' },
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.statut, 'payee');
    assert.equal(body.data.totalTTC, '177000.00');

    const mouvement = fake.insertions.find((i) => i.table === transactionsTresorerie);
    assert.ok(mouvement, 'mouvement de trésorerie attendu pour la vente comptant');
    assert.equal(mouvement.rows.type, 'encaissement');
    assert.equal(mouvement.rows.montant, '177000.00');
    assert.equal(mouvement.rows.modePaiement, 'especes');
  });
});
