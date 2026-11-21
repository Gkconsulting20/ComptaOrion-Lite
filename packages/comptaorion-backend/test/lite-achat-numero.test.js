import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPurchaseInvoiceNumber } from '../src/services/liteAccountingRules.js';

// Non-régression (21 nov. 2026) : la numérotation des factures d'achat par
// entreprise seule (FACT-ACH-2026-0001) entrait en collision dès la 2e entreprise
// car factures_achat.numero_facture est unique GLOBALEMENT — chaque nouvelle
// entreprise était bloquée pour son 1er achat (HTTP 500). Le numéro inclut
// désormais l'entreprise, comme les factures de vente (FACT-AAAA-ENT-0001).

test('première facture d’achat d’une entreprise : séquence à 0001 avec son id', () => {
  assert.equal(buildPurchaseInvoiceNumber('2026', 11, null), 'FACT-ACH-2026-11-0001');
  assert.equal(buildPurchaseInvoiceNumber('2026', 11, undefined), 'FACT-ACH-2026-11-0001');
});

test('la séquence s’incrémente à partir de la dernière facture de la même entreprise', () => {
  assert.equal(
    buildPurchaseInvoiceNumber('2026', 11, 'FACT-ACH-2026-11-0001'),
    'FACT-ACH-2026-11-0002',
  );
  assert.equal(
    buildPurchaseInvoiceNumber('2026', 11, 'FACT-ACH-2026-11-0009'),
    'FACT-ACH-2026-11-0010',
  );
});

test('l’ancien format sans entreprise (FACT-ACH-2026-0001) ne compte pas dans la séquence', () => {
  // C’est le cas réel du 21 nov. 2026 : l’entreprise 10 possède FACT-ACH-2026-0001 ;
  // l’entreprise 11 doit repartir à 0001 avec son propre numéro, sans collision.
  assert.equal(
    buildPurchaseInvoiceNumber('2026', 11, 'FACT-ACH-2026-0001'),
    'FACT-ACH-2026-11-0001',
  );
});

test('le numéro d’une autre entreprise ne compte pas dans la séquence', () => {
  assert.equal(
    buildPurchaseInvoiceNumber('2026', 11, 'FACT-ACH-2026-10-0003'),
    'FACT-ACH-2026-11-0001',
  );
});

test('le numéro porte l’année de la facture', () => {
  assert.equal(buildPurchaseInvoiceNumber('2025', 11, null), 'FACT-ACH-2025-11-0001');
  assert.equal(
    buildPurchaseInvoiceNumber('2025', 11, 'FACT-ACH-2026-11-0007'),
    'FACT-ACH-2025-11-0001',
  );
});
