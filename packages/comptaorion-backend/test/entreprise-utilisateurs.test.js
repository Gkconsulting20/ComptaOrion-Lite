import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runWithDatabaseContext } from '../src/db.js';
import {
  abonnements,
  backupJobs,
  entreprises,
  exportHistory,
  importBatches,
  plansAbonnement,
  users,
} from '../src/schema.js';

process.env.JWT_SECRET ||= 'unit-test-access-fixture-not-for-production';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-refresh-fixture-not-for-production';

const { default: utilisateursRouter } = await import('../src/routes/entreprise-utilisateurs.js');

// Ajout d'utilisateurs à une entreprise existante (Cap, 28 nov. 2026) :
// le propriétaire admin crée le compte directement (sans e-mail, pas
// de clé SendGrid) ; la limite du forfait courant est vérifiée avant
// la création (403 PLAN_LIMIT_REACHED, modèle Orion Santé). Base
// factice, pas de base live.

const ENTREPRISE = { id: 42, nom: 'Test', isDemo: false };
const ENTREPRISE_DEMO = { id: 43, nom: 'Démo', isDemo: true };
const PLAN_SERVICES = { id: 2, nom: 'Services', prix: '2500', limiteUtilisateurs: 3, stockageGb: 3, actif: true };
const ABO_SERVICES = { id: 1, entrepriseId: 42, planId: 2, statut: 'actif' };

const nbUtilisateurs = (n) => Array.from({ length: n }, (_, i) => ({
  id: 100 + i, entrepriseId: 42, username: `user${i}`, email: `user${i}@example.test`, role: 'employee', actif: true,
}));

// Fausse base : les lectures select renvoient les lignes configurées
// par table ; les lectures de `users` passent par selectUsers(index)
// (1er appel = contrôle e-mail, 2e = contrôle username, suivants =
// comptage/liste) car la fausse base ne peut pas évaluer les WHERE.
function stubDb({
  entreprise = ENTREPRISE,
  abonnement = null,
  plan = null,
  selectUsers = () => [],
  cible = null,
} = {}) {
  const insertions = [];
  const updates = [];
  let nextId = 200;
  let appelsUsers = 0;
  const lignesPour = (table) => (
    table === entreprises ? (entreprise ? [entreprise] : [])
    : table === abonnements ? (abonnement ? [abonnement] : [])
    : table === plansAbonnement ? (plan ? [plan] : [])
    : table === users ? selectUsers(appelsUsers++)
    : table === importBatches ? []
    : table === backupJobs ? []
    : table === exportHistory ? []
    : []
  );
  const fake = {
    insertions,
    updates,
    select: () => ({
      from: (table) => ({
        where: () => {
          const lignes = lignesPour(table);
          lignes.limit = async () => lignes.slice(0, 1);
          return lignes;
        },
        limit: async () => lignesPour(table).slice(0, 1),
      }),
    }),
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
            returning: async () => [{ ...(cible || { id: 100 }), ...values }],
          }),
        };
      },
    }),
  };
  fake.transaction = async (cb) => cb(fake);
  return fake;
}

async function withApi(fake, { role = 'admin', userId = 7, entrepriseId = 42 } = {}, run) {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { id: userId, entrepriseId, role, email: 'admin@entreprise.tg' };
    req.userId = userId;
    req.entrepriseId = entrepriseId;
    return runWithDatabaseContext({ db: fake, pool: {} }, next);
  });
  app.use('/api/entreprise/utilisateurs', utilisateursRouter);
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

const NOUVEL_UTILISATEUR = {
  username: 'kossi',
  email: 'kossi@example.test',
  password: 'mot-de-passe-suffisamment-long',
  nom: 'Mensah',
  prenom: 'Kossi',
};

test('GET /entreprise/utilisateurs : liste + limites (essai = illimité)', async () => {
  const liste = nbUtilisateurs(2);
  const fake = stubDb({ selectUsers: () => liste });
  await withApi(fake, {}, async (request) => {
    const res = await request('GET', '/entreprise/utilisateurs');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.utilisateurs.length, 2);
    assert.equal(body.utilisateurs[0].username, 'user0');
    assert.equal(body.utilisateurs[0].passwordHash, undefined);
    assert.equal(body.limites.illimite, true);
    assert.equal(body.limites.source, 'essai');
    assert.equal(body.limites.utilisateursActuels, 2);
  });
});

test('POST /entreprise/utilisateurs : crée un compte employé (201)', async () => {
  const fake = stubDb({ selectUsers: () => [] });
  await withApi(fake, {}, async (request) => {
    const res = await request('POST', '/entreprise/utilisateurs', NOUVEL_UTILISATEUR);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.user.username, 'kossi');
    assert.equal(body.user.email, 'kossi@example.test');
    assert.equal(body.user.role, 'employee');
    assert.equal(body.user.actif, true);
    assert.equal(body.user.passwordHash, undefined);
    const insertion = fake.insertions.find((i) => i.table === users);
    assert.ok(insertion);
    assert.equal(insertion.rows.entrepriseId, 42);
    assert.equal(insertion.rows.role, 'employee');
    assert.match(insertion.rows.passwordHash, /^\$2[aby]\$/);
    assert.notEqual(insertion.rows.passwordHash, NOUVEL_UTILISATEUR.password);
  });
});

test('POST /entreprise/utilisateurs : 4e utilisateur sur Services (3 max) → 403 PLAN_LIMIT_REACHED', async () => {
  const fake = stubDb({
    abonnement: ABO_SERVICES,
    plan: PLAN_SERVICES,
    selectUsers: (appel) => (appel < 2 ? [] : nbUtilisateurs(3)),
  });
  await withApi(fake, {}, async (request) => {
    const res = await request('POST', '/entreprise/utilisateurs', NOUVEL_UTILISATEUR);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'PLAN_LIMIT_REACHED');
    assert.match(body.error, /Services/);
    assert.match(body.error, /3 utilisateurs maximum/);
    assert.equal(fake.insertions.length, 0);
  });
});

test('POST /entreprise/utilisateurs : 3e utilisateur sur Services (3 max) → 201', async () => {
  const fake = stubDb({
    abonnement: ABO_SERVICES,
    plan: PLAN_SERVICES,
    selectUsers: (appel) => (appel < 2 ? [] : nbUtilisateurs(2)),
  });
  await withApi(fake, {}, async (request) => {
    const res = await request('POST', '/entreprise/utilisateurs', NOUVEL_UTILISATEUR);
    assert.equal(res.status, 201);
    assert.equal(fake.insertions.length, 1);
  });
});

test('POST /entreprise/utilisateurs : non-admin → 403 ; rôle admin demandé → 400', async () => {
  const fake = stubDb({ selectUsers: () => [] });
  await withApi(fake, { role: 'employee' }, async (request) => {
    const res = await request('POST', '/entreprise/utilisateurs', NOUVEL_UTILISATEUR);
    assert.equal(res.status, 403);
  });
  const fakeAdmin = stubDb({ selectUsers: () => [] });
  await withApi(fakeAdmin, {}, async (request) => {
    const res = await request('POST', '/entreprise/utilisateurs', { ...NOUVEL_UTILISATEUR, role: 'admin' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Rôle invalide/);
    assert.equal(fakeAdmin.insertions.length, 0);
  });
});

test('POST /entreprise/utilisateurs : validations (e-mail, mot de passe, doublons, démo)', async () => {
  const fake = stubDb({ selectUsers: () => [] });
  await withApi(fake, {}, async (request) => {
    const court = await request('POST', '/entreprise/utilisateurs', { ...NOUVEL_UTILISATEUR, password: 'trop-court' });
    assert.equal(court.status, 400);
    const email = await request('POST', '/entreprise/utilisateurs', { ...NOUVEL_UTILISATEUR, email: 'pas-un-email' });
    assert.equal(email.status, 400);
  });
  const fakeEmailPris = stubDb({ selectUsers: (appel) => (appel === 0 ? [{ id: 1 }] : []) });
  await withApi(fakeEmailPris, {}, async (request) => {
    const res = await request('POST', '/entreprise/utilisateurs', NOUVEL_UTILISATEUR);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /déjà utilisé/);
    assert.equal(fakeEmailPris.insertions.length, 0);
  });
  const fakeDemo = stubDb({ entreprise: ENTREPRISE_DEMO, selectUsers: () => [] });
  await withApi(fakeDemo, { entrepriseId: 43 }, async (request) => {
    const res = await request('POST', '/entreprise/utilisateurs', NOUVEL_UTILISATEUR);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /démonstration/);
    assert.equal(fakeDemo.insertions.length, 0);
  });
});

test('PATCH /entreprise/utilisateurs/:id : désactive un employé ; protège soi-même et les admins', async () => {
  const cible = { id: 101, entrepriseId: 42, username: 'kossi', role: 'employee', actif: true };
  const fake = stubDb({
    selectUsers: () => [cible],
    cible,
  });
  await withApi(fake, {}, async (request) => {
    const res = await request('PATCH', '/entreprise/utilisateurs/101', { actif: false });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.actif, false);
    assert.equal(fake.updates[0].values.actif, false);
  });
  const fakeSoi = stubDb({ selectUsers: () => [cible], cible });
  await withApi(fakeSoi, {}, async (request) => {
    const res = await request('PATCH', '/entreprise/utilisateurs/7', { actif: false });
    assert.equal(res.status, 400);
    assert.equal(fakeSoi.updates.length, 0);
  });
  const cibleAdmin = { id: 102, entrepriseId: 42, username: 'boss', role: 'admin', actif: true };
  const fakeAdmin = stubDb({ selectUsers: () => [cibleAdmin], cible: cibleAdmin });
  await withApi(fakeAdmin, {}, async (request) => {
    const res = await request('PATCH', '/entreprise/utilisateurs/102', { actif: false });
    assert.equal(res.status, 403);
    assert.equal(fakeAdmin.updates.length, 0);
  });
  const fakeAbsent = stubDb({ selectUsers: () => [], cible: null });
  await withApi(fakeAbsent, {}, async (request) => {
    const res = await request('PATCH', '/entreprise/utilisateurs/999', { actif: false });
    assert.equal(res.status, 404);
  });
});
