import test from 'node:test';
import assert from 'node:assert/strict';
import { assertQueueOwnership } from './liteDb.js';

test('une opération locale ne peut pas changer de périmètre entreprise/utilisateur', () => {
  const pending = { opId: 'lite-operation-1', scope: 'entreprise-1:user-1' };
  assert.doesNotThrow(() => assertQueueOwnership(pending, 'entreprise-1:user-1'));
  assert.throws(
    () => assertQueueOwnership(pending, 'entreprise-2:user-1'),
    /autre entreprise/,
  );
});