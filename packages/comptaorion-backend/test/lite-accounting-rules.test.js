import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBalancedJournalLines,
  buildChequeDepositLines,
  buildCustomerReceiptLines,
  buildCustomerReturnLines,
  buildSupplierPaymentLines,
  buildSupplierReturnLines,
  getCustomerReceiptAccountNumber,
} from '../src/services/liteAccountingRules.js';

test('un chèque reçu crédite le compte client via les chèques à encaisser', () => {
  assert.equal(getCustomerReceiptAccountNumber('cheque'), '513');
  assert.equal(getCustomerReceiptAccountNumber('especes'), '57');
  assert.equal(getCustomerReceiptAccountNumber('virement'), '52');
  const lines = buildCustomerReceiptLines({
    settlementAccountId: 513,
    customerAccountId: 411,
    amount: 118,
    modePaiement: 'cheque',
    reference: 'CH-7',
  });
  assert.deepEqual(lines.map((line) => [line.compteComptableId, line.debit, line.credit]), [
    [513, 118, 0], [411, 0, 118],
  ]);
  assert.deepEqual(assertBalancedJournalLines(lines), { debit: 118, credit: 118 });
});

test('règlement fournisseur débite le compte fournisseur et crédite la trésorerie', () => {
  const lines = buildSupplierPaymentLines({
    supplierAccountId: 401,
    settlementAccountId: 52,
    amount: 75,
    modePaiement: 'virement',
    reference: 'REG-2',
  });
  assert.deepEqual(lines.map((line) => [line.compteComptableId, line.debit, line.credit]), [
    [401, 75, 0], [52, 0, 75],
  ]);
  assert.deepEqual(assertBalancedJournalLines(lines), { debit: 75, credit: 75 });
});

test('retour client : annule vente et TVA, crédite le client et réintègre le stock', () => {
  const lines = buildCustomerReturnLines({
    salesAccountId: 1,
    vatAccountId: 2,
    customerAccountId: 3,
    stockAccountId: 4,
    costAccountId: 5,
    totalHT: 100,
    totalTVA: 18,
    totalTTC: 118,
    restockedCost: 70,
    reference: 'AVC-1',
  });
  assert.deepEqual(lines.map((line) => [line.debit, line.credit]), [
    [100, 0], [0, 118], [18, 0], [70, 0], [0, 70],
  ]);
  assert.deepEqual(assertBalancedJournalLines(lines), { debit: 188, credit: 188 });
});

test('retour fournisseur : débite le fournisseur et annule stock et TVA déductible', () => {
  const lines = buildSupplierReturnLines({
    supplierAccountId: 1,
    stockAccountId: 2,
    vatAccountId: 3,
    totalHT: 200,
    totalTVA: 36,
    totalTTC: 236,
    reference: 'AVF-1',
  });
  assert.deepEqual(lines.map((line) => [line.debit, line.credit]), [
    [236, 0], [0, 200], [0, 36],
  ]);
  assert.deepEqual(assertBalancedJournalLines(lines), { debit: 236, credit: 236 });
});

test('dépôt du chèque transfère 513 vers la banque sans mouvement client', () => {
  const lines = buildChequeDepositLines({
    bankAccountId: 1,
    chequeAccountId: 2,
    amount: 118,
    reference: 'CH-7',
  });
  assert.deepEqual(lines.map((line) => [line.debit, line.credit]), [[118, 0], [0, 118]]);
  assert.deepEqual(assertBalancedJournalLines(lines), { debit: 118, credit: 118 });
});

test('les écritures non équilibrées ou sans compte sont refusées', () => {
  assert.throws(() => assertBalancedJournalLines([
    { debit: 100, credit: 0 },
    { debit: 0, credit: 99 },
  ]), /non équilibrée/);
  assert.throws(() => buildCustomerReturnLines({
    salesAccountId: 1,
    customerAccountId: 2,
    totalHT: 100,
    totalTVA: 18,
    totalTTC: 118,
  }), /Compte comptable requis/);
});
