import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runWithDatabaseContext } from '../src/db.js';
import { selectActiveOpening } from '../src/services/bilanApresCloture.js';

process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';
const { default: financialReportsRouter } = await import('../src/routes/financial-reports.js');

// Bilan après clôture (Lite) — exercice 2026, entreprise test 13 :
// bilan 2026 = 1 912 000 (caisse 1 790 800, clients 106 200, 421 : 15 000,
// capital 200 000, résultat 120 : 1 424 000, TVA 443 : 288 000).
// Clôture 2026 → ouverture AN-2027-001. Sans correctif, le bilan
// janv. 2027 double-comptait : 3 824 000 = 2 × 1 912 000.
// Le test utilise une base factice : aucune connexion à la base live.

// Soldes de bilan de l'exercice 2026 (débit − crédit, tels que Postgres
// les renvoie : chaînes décimales).
const SOLDES_2026 = [
  { numero: '57', nom: 'Caisse (compte principal)', debit: '1790800', credit: '0' },
  { numero: '411', nom: 'Clients', debit: '106200', credit: '0' },
  { numero: '421', nom: 'Personnel - Rémunérations dues', debit: '15000', credit: '0' },
  { numero: '101', nom: 'Capital social', debit: '0', credit: '200000' },
  { numero: '120', nom: "Résultat de l'exercice (bénéfice)", debit: '0', credit: '1424000' },
  { numero: '443', nom: 'État - TVA facturée', debit: '0', credit: '288000' },
];

// Mêmes soldes AVANT la clôture : le compte 120 n'existe pas encore, le
// résultat de la période est ajouté par buildFinancialStatements.
const SOLDES_2026_OUVERT = SOLDES_2026.filter((row) => row.numero !== '120');

const OUVERTURE_2027 = { id: 50, numeroEcriture: 'AN-2027-001', dateEcriture: '2027-01-01' };
const CONTREPASSATION_2027 = { id: 51, numeroEcriture: 'AN-2027-001-R', dateEcriture: '2027-01-01' };
const OUVERTURE_2027_2 = { id: 52, numeroEcriture: 'AN-2027-002', dateEcriture: '2027-01-01' };

test('selectActiveOpening retient la dernière ouverture non contrepassée', () => {
  assert.deepEqual(selectActiveOpening([OUVERTURE_2027]), {
    ecritureOuvertureId: 50,
    dateEcriture: '2027-01-01',
  });
  // Après réouverture, l'ouverture contrepassée ne sert plus de base.
  assert.equal(selectActiveOpening([OUVERTURE_2027, CONTREPASSATION_2027]), null);
  // Après une 2e clôture, c'est la nouvelle ouverture qui sert de base.
  assert.deepEqual(
    selectActiveOpening([OUVERTURE_2027, CONTREPASSATION_2027, OUVERTURE_2027_2]),
    { ecritureOuvertureId: 52, dateEcriture: '2027-01-01' },
  );
  assert.equal(selectActiveOpening([]), null);
  assert.equal(selectActiveOpening([CONTREPASSATION_2027]), null);
});

function fakeDb({ selectRows = [] } = {}) {
  const queue = [...selectRows];
  const chain = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    groupBy: () => Promise.resolve(queue.shift() || []),
    orderBy: () => Promise.resolve(queue.shift() || []),
    limit: () => Promise.resolve(queue.shift() || []),
    then: (resolve, reject) => Promise.resolve(queue.shift() || []).then(resolve, reject),
  };
  const fake = {
    select: () => chain,
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
  app.use('/api/financial-reports', financialReportsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (method, path) => fetch(`${base}${path}`, { method });
  try { await run(request); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('bilan janv. 2027 après clôture 2026 : 1 912 000 équilibré, pas 3 824 000', async () => {
  // La route interroge d'abord les écritures AN-* (file 1), puis les
  // soldes de bilan (file 2, déjà filtrés par la route sur l'ouverture),
  // le compte de résultat de la période (file 3, vide en janv. 2027)
  // et la qualité des écritures (file 4).
  const fake = fakeDb({ selectRows: [[OUVERTURE_2027], SOLDES_2026, [], []] });
  await withApi(fake, async (request) => {
    const res = await request('GET', '/financial-reports?dateDebut=2027-01-01&dateFin=2027-01-31');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bilan.totalActif, 1912000);
    assert.equal(body.bilan.totalPassif, 1912000);
    assert.equal(body.bilan.equilibre, true);
    assert.equal(body.bilan.ecart, 0);
    const caisse = body.bilan.actif.find((ligne) => ligne.numero === '57');
    assert.equal(caisse.montant, 1790800);
    const capital = body.bilan.capitauxEtDettes.find((ligne) => ligne.numero === '101');
    assert.equal(capital.montant, 200000);
    assert.equal(body.etatResultat.resultatNet, 0);
  });
});

test('bilan 2026 demandé après clôture : l’ouverture 2027 ne s’applique pas', async () => {
  const fake = fakeDb({ selectRows: [[], SOLDES_2026_OUVERT, [
    { numero: '701', nom: 'Ventes de marchandises', debit: '0', credit: '1600000' },
    { numero: '613', nom: 'Locations et charges locatives', debit: '150000', credit: '0' },
    { numero: '624', nom: 'Frais de transport et de déplacements', debit: '26000', credit: '0' },
  ], []] });
  await withApi(fake, async (request) => {
    const res = await request('GET', '/financial-reports?dateDebut=2026-01-01&dateFin=2026-12-31');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bilan.totalActif, 1912000);
    assert.equal(body.bilan.totalPassif, 1912000);
    assert.equal(body.bilan.equilibre, true);
    assert.equal(body.etatResultat.resultatNet, 1424000);
  });
});

test('bilan après réouverture : sans ouverture active, l’historique complet est repris', async () => {
  const fake = fakeDb({ selectRows: [[OUVERTURE_2027, CONTREPASSATION_2027], SOLDES_2026, [], []] });
  await withApi(fake, async (request) => {
    const res = await request('GET', '/financial-reports?dateDebut=2027-01-01&dateFin=2027-01-31');
    assert.equal(res.status, 200);
    const body = await res.json();
    // Clôture et ouverture sont annulées par leurs contrepassations :
    // les soldes reprennent l'historique complet, sans double-compte.
    assert.equal(body.bilan.totalActif, 1912000);
    assert.equal(body.bilan.totalPassif, 1912000);
    assert.equal(body.bilan.equilibre, true);
  });
});

test('bilan après 2e clôture : la nouvelle ouverture AN-2027-002 sert de base', async () => {
  const fake = fakeDb({
    selectRows: [[OUVERTURE_2027, CONTREPASSATION_2027, OUVERTURE_2027_2], SOLDES_2026, [], []],
  });
  await withApi(fake, async (request) => {
    const res = await request('GET', '/financial-reports?dateDebut=2027-01-01&dateFin=2027-01-31');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bilan.totalActif, 1912000);
    assert.equal(body.bilan.totalPassif, 1912000);
    assert.equal(body.bilan.equilibre, true);
  });
});
