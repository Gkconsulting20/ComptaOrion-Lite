import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDraft, photoExpenseDescription, probablePhotoDuplicates, signDuplicateReview, acceptsDuplicateReview } from '../src/services/photoDraft.js';

const key = 'duplicate-review-test-key-not-for-production';
const draft = cleanDraft({ description: 'Repas', montant: 25.5, dateDepense: '2026-10-16', reference: 'AB-012', fournisseur: 'CAFÉ DU COIN', devise: 'EUR' });
const expense = (id, changes = {}) => ({ id, montant: '25.50', dateDepense: draft.dateDepense, description: photoExpenseDescription(draft), ...changes });

test('une nouvelle photo retrouve la référence normalisée, la date, le total et l’enseigne', () => {
  const matches = probablePhotoDuplicates({ ...draft, reference: 'ab 012', fournisseur: 'Cafe du Coin' }, [expense(2)]);
  assert.deepEqual(matches[0].reasons, ['reference', 'date', 'montant', 'fournisseur']);
  assert.equal(matches[0].fournisseur, draft.fournisseur);
});
test('les anciennes références en description et les références seules restent vérifiables', () => {
  const matches = probablePhotoDuplicates(draft, [expense(1, { description: 'Repas · Réf. AB-012', montant: '99.00', dateDepense: '2025-01-01' })]);
  assert.deepEqual(matches[0].reasons, ['reference']);
});
test('sans référence ni fournisseur, date et montant signalent un doute et jamais une fusion', () => {
  const noRef = { ...draft, reference: '', fournisseur: '' };
  const matches = probablePhotoDuplicates(noRef, [expense(1, { description: 'Repas' }), expense(2, { description: 'Transport' }), expense(3, { montant: '25.51', description: 'Repas' })]);
  assert.deepEqual(matches.map(m => m.id), [1, 2]);
  assert.deepEqual(matches[0].reasons, ['date', 'montant']);
});
test('deux achats réellement identiques restent deux correspondances distinctes, même chez des fournisseurs différents', () => {
  const rows = [expense(1), expense(2), expense(3, { description: 'Autre achat · Fournisseur : Autre · Réf. XX' })];
  assert.equal(probablePhotoDuplicates(draft, rows).length, 3);
  assert.equal(rows.length, 3);
  assert.equal(probablePhotoDuplicates({ ...draft, reference: '', dateDepense: null }, rows).length, 0);
});
test('le choix explicite est lié à la photo, au brouillon, à l’entreprise, à l’utilisateur et aux correspondances actuelles', () => {
  const matches = probablePhotoDuplicates(draft, [expense(1)]);
  const token = signDuplicateReview('photo-a', draft, matches, 9, 7, key);
  const accepts = (changes = {}) => acceptsDuplicateReview(changes.choice ?? 'create-new', changes.token ?? token, changes.hash ?? 'photo-a', changes.draft ?? draft, changes.matches ?? matches, changes.company ?? 9, changes.user ?? 7, key);
  assert.equal(accepts(), true);
  for (const changes of [{ choice: '' }, { token: 'tampered' }, { hash: 'photo-b' }, { company: 10 }, { user: 8 }, { draft: { ...draft, montant: 26 } }, { matches: [...matches, ...probablePhotoDuplicates(draft, [expense(2)])] }]) {
    assert.equal(accepts(changes), false);
  }
});
