import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateReconciliationBalances,
  normalizeStatementLines,
  suggestStatementMatches,
} from '../src/services/bankReconciliation.js';

test('valide les lignes importées et conserve le signe crédit/débit', () => {
  const lines = normalizeStatementLines([
    { lineNumber: 1, date: '2026-11-02', description: 'Virement client', reference: 'FAC-12', amount: 1250.5 },
    { lineNumber: 2, date: '2026-11-03', description: 'Frais bancaires', amount: -12.5 },
  ], { dateDebut: '2026-11-01', dateFin: '2026-11-30' });

  assert.deepEqual(lines.map(({ lineNumber, amount }) => ({ lineNumber, amount })), [
    { lineNumber: 1, amount: 1250.5 },
    { lineNumber: 2, amount: -12.5 },
  ]);
});

test('refuse les lignes hors période, les dates impossibles et les numéros répétés', () => {
  assert.throws(() => normalizeStatementLines([
    { lineNumber: 1, date: '2026-11-31', description: 'Invalide', amount: 10 },
  ], { dateDebut: '2026-11-01', dateFin: '2026-11-30' }), /date/i);

  assert.throws(() => normalizeStatementLines([
    { lineNumber: 1, date: '2026-11-01', amount: 10 },
    { lineNumber: 1, date: '2026-11-02', amount: -10 },
  ], { dateDebut: '2026-11-01', dateFin: '2026-11-30' }), /répété/i);
});

test('suggère une correspondance exacte mais laisse les correspondances ambiguës à vérifier', () => {
  const transactions = [
    {
      id: 1,
      dateTransaction: '2026-11-05',
      type: 'encaissement',
      montant: '1250.00',
      numeroPiece: 'FAC-12',
      rapproche: false,
      rapprochementId: null,
    },
    {
      id: 2,
      dateTransaction: '2026-11-05',
      type: 'encaissement',
      montant: '1250.00',
      numeroPiece: 'FAC-13',
      rapproche: false,
      rapprochementId: null,
    },
    {
      id: 3,
      dateTransaction: '2026-11-05',
      type: 'encaissement',
      montant: '1250.00',
      numeroPiece: 'FAC-14',
      rapproche: false,
      rapprochementId: null,
    },
  ];
  const suggested = suggestStatementMatches([
    { lineNumber: 1, date: '2026-11-06', reference: 'FAC-12', amount: 1250 },
    { lineNumber: 2, date: '2026-11-05', reference: '', amount: 1250 },
  ], transactions);

  assert.equal(suggested[0].suggestedTransactionId, 1);
  assert.equal(suggested[1].suggestedTransactionId, null);
});

test('n’attribue jamais deux lignes au même mouvement et respecte le signe', () => {
  const transactions = [{
    id: 8,
    dateTransaction: '2026-11-10',
    type: 'decaissement',
    montant: '75.00',
    rapproche: false,
    rapprochementId: null,
  }];
  const suggestions = suggestStatementMatches([
    { lineNumber: 1, date: '2026-11-10', amount: 75, description: 'Débit' },
    { lineNumber: 2, date: '2026-11-10', amount: -75, description: 'Débit fournisseur' },
  ], transactions);

  assert.equal(suggestions[0].suggestedTransactionId, null);
  assert.equal(suggestions[1].suggestedTransactionId, 8);
});

test('le solde ajusté tient compte des opérations enregistrées mais en attente', () => {
  const balances = calculateReconciliationBalances({
    openingBalance: 1000,
    statementBalance: 1100,
    selectedTransactionIds: [1],
    transactions: [
      { id: 1, type: 'encaissement', montant: '100', rapproche: true, rapprochementId: 5 },
      { id: 2, type: 'decaissement', montant: '30', rapproche: false, rapprochementId: null },
      { id: 3, type: 'encaissement', montant: '20', rapproche: false, rapprochementId: null },
    ],
  });

  assert.deepEqual(balances, {
    bookBalance: 1090,
    adjustedStatementBalance: 1090,
    outstandingNet: -10,
    difference: 0,
    outstandingCount: 2,
  });
});
