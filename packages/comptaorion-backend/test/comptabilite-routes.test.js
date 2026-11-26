import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runWithDatabaseContext } from '../src/db.js';

process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';
const { default: comptabiliteRouter } = await import('../src/routes/comptabilite.js');
const { default: impotsRouter } = await import('../src/routes/impots.js');

// Routes comptabilité et TVA (Lite) — exercice 2026 : /comptabilite/*
// (journaux, grand livre, bilan, compte de résultat) et /impots/tva/resume
// répondaient 404 « Route non disponible dans Lite » : les routeurs
// existaient mais n'étaient montés nulle part dans app.js.
// Le test utilise une base factice : aucune connexion à la base live.

function fakeDb({ selectRows = [], executeRows = [], comptes = [], journaux = [], lignes = [] } = {}) {
  const selectQueue = [...selectRows];
  const executeQueue = [...executeRows];
  const chain = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    groupBy: () => Promise.resolve(selectQueue.shift() || []),
    orderBy: () => Promise.resolve(selectQueue.shift() || []),
    limit: () => Promise.resolve(selectQueue.shift() || []),
    then: (resolve, reject) => Promise.resolve(selectQueue.shift() || []).then(resolve, reject),
  };
  const fake = {
    query: {
      comptesComptables: { findMany: async () => comptes },
      journaux: { findMany: async () => journaux },
      entreprises: { findFirst: async () => ({ nom: 'Entreprise test' }) },
      lignesEcritures: { findMany: async () => lignes },
    },
    select: () => chain,
    execute: async () => executeQueue.shift() || { rows: [] },
    insert: () => ({
      values: (rows) => ({
        returning: async () => [Array.isArray(rows) ? rows[0] : rows].map((row, i) => ({ id: 100 + i, ...row })),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
  fake.transaction = async (cb) => cb(fake);
  return fake;
}

async function withApi(fake, routers, run) {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { id: 13, entrepriseId: 13 };
    req.userId = 13;
    req.entrepriseId = 13;
    return runWithDatabaseContext({ db: fake, pool: {} }, next);
  });
  for (const [path, router] of routers) app.use(path, router);
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

test('app.js monte /api/comptabilite et /api/impots', async () => {
  const { default: app } = await import('../src/app.js');
  const layers = app._router?.stack || [];
  const mounted = (prefix) => layers.some((layer) =>
    layer.regexp?.test(`${prefix}/x`) && Array.isArray(layer.handle?.stack));
  assert.ok(mounted('/api/comptabilite'), 'routeur comptabilite monté attendu');
  assert.ok(mounted('/api/impots'), 'routeur impots monté attendu');
});

test('GET /comptabilite/rapports/bilan : un 129 débiteur diminue le passif (signe corrigé)', async () => {
  // Équilibré : D 57 130 000 + D 411 30 000 + D 129 50 000 = 210 000 ;
  // C 101 200 000 + C 443 10 000 = 210 000. Avec Math.abs, le passif
  // vaudrait 200 000 + 50 000 + 10 000 = 260 000 (bilan faux).
  const comptes = [
    { id: 1, numero: '101', nom: 'Capital social' },
    { id: 2, numero: '129', nom: "Résultat de l'exercice (perte)" },
    { id: 3, numero: '57', nom: 'Caisse' },
    { id: 4, numero: '411', nom: 'Clients' },
    { id: 5, numero: '443', nom: 'État - TVA facturée' },
  ];
  const fake = fakeDb({
    comptes,
    executeRows: [{ rows: [
      { compte_comptable_id: 1, total_debit: '0', total_credit: '200000' },
      { compte_comptable_id: 2, total_debit: '50000', total_credit: '0' },
      { compte_comptable_id: 3, total_debit: '130000', total_credit: '0' },
      { compte_comptable_id: 4, total_debit: '30000', total_credit: '0' },
      { compte_comptable_id: 5, total_debit: '0', total_credit: '10000' },
    ] }],
  });
  await withApi(fake, [['/api/comptabilite', comptabiliteRouter]], async (request) => {
    const res = await request('GET', '/comptabilite/rapports/bilan?dateDebut=2026-01-01&dateFin=2026-12-31');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.actif.total, 160000);
    assert.equal(body.passif.total, 160000);
    assert.equal(body.equilibre, true);
    const perte = body.passif.capitaux.find((ligne) => ligne.numero === '129');
    assert.equal(perte.solde, 50000);
  });
});

test('GET /comptabilite/bilan : découvert bancaire en dettes, 129 en moins, résultat intégré', async () => {
  // Équilibré : D 218 150 000 + D 411 80 000 + D 129 50 000 = 280 000 ;
  // C 101 200 000 + C 443 30 000 + C 57 50 000 (découvert) = 280 000.
  const comptes = [
    { id: 1, numero: '101', nom: 'Capital social' },
    { id: 2, numero: '129', nom: "Résultat de l'exercice (perte)" },
    { id: 3, numero: '57', nom: 'Caisse' },
    { id: 4, numero: '411', nom: 'Clients' },
    { id: 5, numero: '443', nom: 'État - TVA facturée' },
    { id: 6, numero: '218', nom: 'Autres immobilisations corporelles' },
  ];
  const lignes = [
    { compteId: 6, debit: '150000', credit: '0' },
    { compteId: 4, debit: '80000', credit: '0' },
    { compteId: 2, debit: '50000', credit: '0' },
    { compteId: 1, debit: '0', credit: '200000' },
    { compteId: 5, debit: '0', credit: '30000' },
    { compteId: 3, debit: '0', credit: '50000' },
  ];
  // File des lectures : écritures AN-* (aucune ouverture), puis lignes.
  const fake = fakeDb({ comptes, selectRows: [[], lignes] });
  await withApi(fake, [['/api/comptabilite', comptabiliteRouter]], async (request) => {
    const res = await request('GET', '/comptabilite/bilan?dateDebut=2026-01-01&dateFin=2026-12-31');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.actif.total, 230000);
    assert.equal(body.passif.total, 230000);
    assert.equal(body.resultatNet, 0);
    assert.equal(body.actif.tresorerie.length, 0);
    const decouvert = body.passif.dettes.find((ligne) => ligne.compte === '57');
    assert.ok(decouvert, 'découvert classé en dettes attendu');
    assert.equal(decouvert.montant, 50000);
  });
});

test('GET /comptabilite/bilan après clôture sans dateDebut : 1 912 000, pas le double', async () => {
  const comptes = [
    { id: 1, numero: '101', nom: 'Capital social' },
    { id: 2, numero: '120', nom: "Résultat de l'exercice (bénéfice)" },
    { id: 3, numero: '57', nom: 'Caisse' },
    { id: 4, numero: '411', nom: 'Clients' },
    { id: 5, numero: '421', nom: 'Personnel - Rémunérations dues' },
    { id: 6, numero: '443', nom: 'État - TVA facturée' },
  ];
  const lignes = [
    { compteId: 3, debit: '1790800', credit: '0' },
    { compteId: 4, debit: '106200', credit: '0' },
    { compteId: 5, debit: '15000', credit: '0' },
    { compteId: 1, debit: '0', credit: '200000' },
    { compteId: 2, debit: '0', credit: '1424000' },
    { compteId: 6, debit: '0', credit: '288000' },
  ];
  const fake = fakeDb({
    comptes,
    selectRows: [[{ id: 50, numeroEcriture: 'AN-2027-001', dateEcriture: '2027-01-01' }], lignes],
  });
  await withApi(fake, [['/api/comptabilite', comptabiliteRouter]], async (request) => {
    const res = await request('GET', '/comptabilite/bilan?dateFin=2027-01-31');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.actif.total, 1912000);
    assert.equal(body.passif.total, 1912000);
  });
});

test('GET /comptabilite/* : journaux, journal général, écritures, résultat, grand livre, balance, compte de résultat', async () => {
  const comptes = [
    { id: 1, numero: '701', nom: 'Ventes de marchandises' },
    { id: 2, numero: '613', nom: 'Locations et charges locatives' },
    { id: 3, numero: '411', nom: 'Clients' },
  ];
  const fake = fakeDb({
    comptes,
    journaux: [{ id: 1, code: 'VT', nom: 'Journal des Ventes', type: 'ventes' }],
    lignes: [{ debit: '118000', credit: '0' }],
    executeRows: [
      { rows: [{ id: 1, date_ecriture: '2026-01-15', numero_piece: 'FACT-1', libelle: 'Vente', total_debit: '118000', total_credit: '118000' }] },
      { rows: [{ id: 1, date_ecriture: '2026-01-15', numero_piece: 'F1', libelle: 'Vente', journal_code: 'VT', journal_nom: 'Journal des Ventes', compte_numero: '411', compte_nom: 'Clients', ligne_libelle: 'Client', debit: '118000', credit: '0' }] },
      { rows: [
        { compte_comptable_id: 1, total_debit: '0', total_credit: '1600000' },
        { compte_comptable_id: 2, total_debit: '150000', total_credit: '0' },
      ] },
    ],
    selectRows: [
      [{ id: 1, numeroEcriture: 'VT-2026-00001', dateEcriture: '2026-01-15', reference: 'F1', description: 'Vente', valide: true, journalId: 1, journalCode: 'VT', journalNom: 'Journal des Ventes', createdAt: '2026-01-15' }],
      [{ id: 1, compteComptableId: 3, compteNumero: '411', compteNom: 'Clients', debit: '118000', credit: '0', libelle: 'Vente', dateEcriture: '2026-01-15', reference: 'F1', journalCode: 'VT', journalNom: 'Journal des Ventes' }],
      [{ compteId: 3, debit: '118000', credit: '0', compteNumero: '411', compteNom: 'Clients', compteType: 'actif' }],
      [{ compteId: 1, debit: '0', credit: '1600000' }, { compteId: 2, debit: '150000', credit: '0' }],
    ],
  });
  await withApi(fake, [['/api/comptabilite', comptabiliteRouter]], async (request) => {
    const periode = '?dateDebut=2026-01-01&dateFin=2026-12-31';
    const journaux = await request('GET', `/comptabilite/rapport-journaux${periode}`);
    assert.equal(journaux.status, 200);
    assert.equal((await journaux.json()).totaux.nombreEcritures, 1);

    const journalGeneral = await request('GET', `/comptabilite/rapports/journal-general${periode}`);
    assert.equal(journalGeneral.status, 200);
    assert.equal((await journalGeneral.json()).totaux.nombreEcritures, 1);

    const ecritures = await request('GET', `/comptabilite/ecritures${periode}`);
    assert.equal(ecritures.status, 200);
    assert.equal((await ecritures.json()).length, 1);

    const resultat = await request('GET', `/comptabilite/rapports/resultat${periode}`);
    assert.equal(resultat.status, 200);
    assert.equal((await resultat.json()).resultatNet, 1450000);

    const grandLivre = await request('GET', `/comptabilite/grand-livre${periode}`);
    assert.equal(grandLivre.status, 200);
    assert.equal((await grandLivre.json()).comptes.length, 1);

    const balance = await request('GET', '/comptabilite/balance');
    assert.equal(balance.status, 200);
    assert.equal((await balance.json()).equilibre, false);

    const compteResultat = await request('GET', `/comptabilite/compte-resultat${periode}`);
    assert.equal(compteResultat.status, 200);
    assert.equal((await compteResultat.json()).resultatNet, 1450000);
  });
});

test('POST /impots/declarations/tva : la TVA est lue sur totalTVA, pas montantTVA', async () => {
  // Avant correctif, le select sur factures.montantTVA (colonne
  // inexistante) faisait échouer la déclaration en 500 — même bug que
  // côté ComptaOrion (insert into declarations_fiscales).
  const fake = fakeDb({
    selectRows: [
      [{ id: 1, entrepriseId: 13, pays: 'Togo', administrationNom: 'OTR', connexionActive: true }],
      [{ totalTTC: '118000', totalHT: '100000', montantTVA: '18000' }],
    ],
  });
  await withApi(fake, [['/api/impots', impotsRouter]], async (request) => {
    const res = await request('POST', '/impots/declarations/tva', { periode: '2026-01' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.calculs.tvaCollectee, 18000);
    assert.equal(body.data.calculs.montantHT, 100000);
    assert.equal(body.data.calculs.nombreFactures, 1);
  });
});

test('GET /impots/tva/resume : TVA collectée et déductible depuis les écritures', async () => {
  const fake = fakeDb({ executeRows: [{ rows: [{ montant: '288000' }] }, { rows: [{ montant: '0' }] }] });
  await withApi(fake, [['/api/impots', impotsRouter]], async (request) => {
    const res = await request('GET', '/impots/tva/resume?dateDebut=2026-01-01&dateFin=2026-12-31');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.tvaCollectee, 288000);
    assert.equal(body.tvaDeductible, 0);
    assert.equal(body.tvaADecaisser, 288000);
  });
});
