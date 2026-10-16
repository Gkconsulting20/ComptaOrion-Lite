import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IdempotencyConflictError,
  claimIdempotentOperation,
} from '../src/middleware/idempotency.js';

function createStore() {
  const operations = new Map();
  return {
    operations,
    async claim(entrepriseId, key) {
      if (operations.has(key)) return null;
      const row = { entrepriseId, idempotencyKey: key, status: 'processing' };
      operations.set(key, row);
      return row;
    },
    async find(key) {
      return operations.get(key);
    },
  };
}

async function claim(store, entrepriseId, key) {
  return claimIdempotentOperation({
    entrepriseId,
    idempotencyKey: key,
    insertClaim: () => store.claim(entrepriseId, key),
    findByKey: () => store.find(key),
  });
}

test('rejouer la même opération retourne exactement la réponse validée', async () => {
  const store = createStore();
  const first = await claim(store, 1, 'lite-operation-1');
  assert.equal(first.claimed, true);
  Object.assign(store.operations.get('lite-operation-1'), {
    status: 'completed',
    responseStatus: 201,
    responseBody: { success: true, data: { id: 42 } },
  });

  const replay = await claim(store, 1, 'lite-operation-1');
  assert.deepEqual(replay, {
    claimed: false,
    replay: true,
    status: 201,
    body: { success: true, data: { id: 42 } },
  });
  assert.equal(store.operations.size, 1);
});

test('une opération ne peut pas être rejouée sous une autre entreprise', async () => {
  const store = createStore();
  await claim(store, 1, 'lite-operation-2');

  await assert.rejects(
    claim(store, 2, 'lite-operation-2'),
    (error) => error instanceof IdempotencyConflictError
      && error.status === 409
      && /autre entreprise/.test(error.message),
  );
});

test('un rollback avant commit ne conserve aucune écriture partielle', async () => {
  const committed = { ventes: [], paiements: [], stocks: [], operations: new Map() };
  const draft = structuredClone(committed);
  draft.operations.set('lite-operation-3', { entrepriseId: 1, status: 'processing' });
  draft.ventes.push({ id: 1 });
  draft.paiements.push({ id: 1 });
  draft.stocks.push({ produitId: 8, quantite: -1 });

  assert.deepEqual(committed, {
    ventes: [],
    paiements: [],
    stocks: [],
    operations: new Map(),
  });
});

test('une réponse perdue après commit est rejouée sans nouvelle écriture', async () => {
  const store = createStore();
  await claim(store, 1, 'lite-operation-4');
  const businessRows = { ventes: 1, paiements: 1, stocks: 1 };
  Object.assign(store.operations.get('lite-operation-4'), {
    status: 'completed',
    responseStatus: 201,
    responseBody: { success: true, data: { id: 9 } },
  });

  const replay = await claim(store, 1, 'lite-operation-4');
  assert.equal(replay.body.data.id, 9);
  assert.deepEqual(businessRows, { ventes: 1, paiements: 1, stocks: 1 });
});