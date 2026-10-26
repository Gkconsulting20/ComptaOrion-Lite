import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { runWithDatabaseContext } from '../src/db.js';
import { signDraft, photoExpenseDescription, cleanDraft } from '../src/services/photoDraft.js';

process.env.JWT_SECRET ||= 'photo-confirm-test-key-not-for-production';
const { default: router } = await import('../src/routes/ai.js');
const dialect = new PgDialect();
const draft = cleanDraft({ description: 'Repas', montant: 25.5, dateDepense: '2026-10-16', reference: 'R1', fournisseur: 'Restaurant', devise: 'EUR' });
const existing = (id, entrepriseId = 9, value = draft) => ({ id, entrepriseId, description: photoExpenseDescription(value), montant: String(value.montant), dateDepense: value.dateDepense });

// Transactional adapter exercises the real HTTP route, SQL tenant predicates,
// rollback, replay, and expense/audit path without an external database/provider.
async function withApi(initial, run) {
  let state = {
    depenses: initial,
    lite_idempotency: [],
    categories_depenses: [],
    approvals_depenses: [],
    audit_logs: [],
    comptes_comptables: [
      { id: 1, entrepriseId: 9, numero: '62', nom: 'Autres charges externes' },
      { id: 2, entrepriseId: 9, numero: '57', nom: 'Caisse' },
    ],
    journaux: [],
    ecritures: [],
    lignes_ecriture: [],
    parametres_comptables: [],
  };
  const queries = [];
  const connection = (current, transaction = false) => ({
    select() {
      let table, predicate, lock = false;
      const read = () => {
        const query = predicate ? dialect.sqlToQuery(predicate) : { sql: '', params: [] };
        queries.push({ table, ...query, lock, transaction });
        if (table === 'entreprises') return [{ id: 9, devise: 'EUR' }];
        if (table === 'depenses') {
          assert.match(query.sql, /entreprise_id/);
          return current.depenses.filter(row => row.entrepriseId === query.params[0]);
        }
        if (table === 'lite_idempotency') return current[table].filter(row => row.idempotencyKey === query.params[0]);
        if (table === 'comptes_comptables') {
          const prefix = query.params.find(value => typeof value === 'string' && value.endsWith('%'))?.slice(0, -1);
          return current[table].filter(row =>
            row.entrepriseId === query.params[0] && (!prefix || row.numero.startsWith(prefix))
          );
        }
        if (table === 'journaux') return current[table].filter(row => row.entrepriseId === query.params[0] && row.code === query.params[1]);
        if (table === 'parametres_comptables') return current[table].filter(row => row.entrepriseId === query.params[0]);
        return current[table] || [];
      };
      const chain = {
        from(value) { table = getTableName(value); return chain; },
        where(value) { predicate = value; return chain; },
        for(value) { assert.equal(value, 'update'); lock = true; return chain; },
        limit() { return Promise.resolve(read().slice(0, 1)); },
        then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); },
      };
      return chain;
    },
    insert(table) {
      const name = getTableName(table);
      let value;
      const chain = {
        values(row) { value = row; return chain; },
        onConflictDoNothing() { return chain; },
        returning() {
          assert.ok(queries.some(q => q.lock && q.transaction), 'company locked before writes');
          if (name === 'lite_idempotency' && current[name].some(row => row.idempotencyKey === value.idempotencyKey)) return Promise.resolve([]);
          const row = { id: 100 + current[name].length, ...value };
          current[name].push(row);
          return Promise.resolve([row]);
        },
        then(resolve, reject) { return chain.returning().then(resolve, reject); },
      };
      return chain;
    },
    update(table) {
      const name = getTableName(table);
      return { set: values => ({ where: async predicate => {
        const query = dialect.sqlToQuery(predicate);
        for (const row of current[name]) if (row.entrepriseId === query.params[0] && row.idempotencyKey === query.params[1]) Object.assign(row, values);
      } }) };
    },
  });
  const fake = {
    select: (...args) => connection(state).select(...args),
    async transaction(fn) {
      const pending = structuredClone(state);
      const result = await fn(connection(pending, true));
      state = pending;
      return result;
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.entrepriseId = 9; req.user = { id: 7 };
    runWithDatabaseContext({ db: fake, pool: { query: async () => ({ rows: [] }) } }, next);
  });
  app.use('/api/ai', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const confirm = async (hash, value = draft, review = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true, draftToken: signDraft(hash.repeat(64), 9, 7), draft: value, ...review }),
    });
    return { status: response.status, body: await response.json() };
  };
  try { await run(confirm, () => state, queries); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('nouvelle photo : conflit sans écriture, choix distinct explicite, puis rejeu après réponse perdue', async () => {
  await withApi([existing(1)], async (confirm, state) => {
    const conflict = await confirm('b');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'PHOTO_DUPLICATES');
    assert.equal(conflict.body.matches[0].id, 1);
    for (const table of ['lite_idempotency', 'categories_depenses', 'approvals_depenses', 'audit_logs']) assert.equal(state()[table].length, 0);
    assert.equal((await confirm('b', draft, { duplicateChoice: 'create-new' })).status, 409);
    const saved = await confirm('b', draft, { duplicateChoice: 'create-new', reviewToken: conflict.body.reviewToken });
    assert.equal(saved.status, 200);
    assert.equal(state().depenses.length, 2);
    assert.equal(state().audit_logs.length, 1);
    const replay = await confirm('b'); // no new override required for a committed operation
    assert.deepEqual(replay, saved);
    assert.equal(state().depenses.length, 2);
    assert.equal(state().audit_logs.length, 1);
  });
});
test('autres entreprises invisibles; une dépense indépendante est enregistrée sans choix supplémentaire', async () => {
  await withApi([existing(1, 10)], async (confirm, state, queries) => {
    assert.equal((await confirm('a')).status, 200);
    assert.equal(state().depenses.length, 2);
    assert.equal(state().ecritures.length, 1);
    assert.equal(state().lignes_ecriture.length, 2);
    assert.equal(state().ecritures[0].valide, false);
    assert.equal(state().lignes_ecriture.reduce((total, line) => total + Number(line.debit), 0), 25.5);
    assert.equal(state().lignes_ecriture.reduce((total, line) => total + Number(line.credit), 0), 25.5);
    assert.ok(queries.filter(q => q.table === 'depenses').every(q => q.params[0] === 9));
  });
});
test('sans référence, deux dépenses identiques sont préservées; une nouvelle correspondance invalide le choix précédent', async () => {
  const noRef = { ...draft, reference: '', fournisseur: '' };
  await withApi([existing(1, 9, noRef), existing(2, 9, noRef)], async (confirm, state) => {
    const conflict = await confirm('a', noRef);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.matches.length, 2);
    const review = { duplicateChoice: 'create-new', reviewToken: conflict.body.reviewToken };
    assert.equal((await confirm('a', { ...noRef, description: 'Description corrigée' }, review)).status, 409);
    assert.equal((await confirm('b', noRef, review)).status, 409); // different photo
    state().depenses.push(existing(3, 9, noRef)); // another writer between review and save
    const refreshed = await confirm('a', noRef, review);
    assert.equal(refreshed.status, 409);
    assert.equal(refreshed.body.matches.length, 3);
    assert.equal(state().depenses.length, 3);
    assert.equal((await confirm('a', noRef, { duplicateChoice: 'create-new', reviewToken: refreshed.body.reviewToken })).status, 200);
    assert.equal(state().depenses.length, 4);
  });
});
