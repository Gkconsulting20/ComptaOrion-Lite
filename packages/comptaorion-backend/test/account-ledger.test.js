import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThirdPartyLedger } from '../src/services/accountLedger.js';

test('un paiement client reste distinct d’un avoir de retour de marchandise', () => {
  const ledger = buildThirdPartyLedger({
    partyType: 'client',
    invoices: [{ id: 1, numeroFacture: 'F-1', dateFacture: '2026-02-01', totalTTC: '100' }],
    payments: [{ id: 2, datePaiement: '2026-02-02', montant: '50', modePaiement: 'especes' }],
    returns: [{ id: 3, numero: 'AV-1', dateRetour: '2026-02-03', totalTTC: '20' }],
  });

  assert.deepEqual(ledger.totaux, { factures: 100, paiements: 50, retours: 20, solde: 30 });
  assert.deepEqual(ledger.mouvements.map(({ type, libelle, montant }) => [type, libelle, montant]), [
    ['facture', 'Facture client', 100],
    ['paiement', 'Paiement client reçu', 50],
    ['retour', 'Avoir client — retour de marchandise', 20],
  ]);
});

test('les paiements fournisseur et retours réduisent séparément le montant à payer', () => {
  const ledger = buildThirdPartyLedger({
    partyType: 'fournisseur',
    invoices: [{ id: 1, numeroFacture: 'A-1', dateFacture: '2026-02-01', totalTTC: 200 }],
    payments: [{ id: 2, datePaiement: '2026-02-02', montant: 80 }],
    returns: [{ id: 3, numero: 'AVF-1', dateRetour: '2026-02-03', totalTTC: 30 }],
  });

  assert.deepEqual(ledger.totaux, { factures: 200, paiements: 80, retours: 30, solde: 90 });
  assert.equal(ledger.mouvements[1].type, 'paiement');
  assert.equal(ledger.mouvements[2].type, 'retour');
});
