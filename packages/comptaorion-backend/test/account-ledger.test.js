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

  assert.deepEqual(ledger.totaux, {
    factures: 100, paiements: 50, retours: 20, notesDebit: 0, notesCredit: 0, escomptes: 0, solde: 30,
  });
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

  assert.deepEqual(ledger.totaux, {
    factures: 200, paiements: 80, retours: 30, notesDebit: 0, notesCredit: 0, escomptes: 0, solde: 90,
  });
  assert.equal(ledger.mouvements[1].type, 'paiement');
  assert.equal(ledger.mouvements[2].type, 'retour');
});

test('grand livre client distingue paiement, escompte et note de débit', () => {
  const ledger = buildThirdPartyLedger({
    partyType: 'client',
    invoices: [{ id: 1, dateFacture: '2026-01-01', numeroFacture: 'F-1', totalTTC: 100 }],
    payments: [{ id: 1, datePaiement: '2026-01-10', reference: 'P-1', montant: 99, escompteMontant: 1 }],
    adjustments: [{ id: 1, dateNote: '2026-01-11', numero: 'ND-1', totalTTC: 5 }],
  });
  assert.deepEqual(ledger.totaux, {
    factures: 100, paiements: 99, retours: 0, notesDebit: 5, notesCredit: 0, escomptes: 1, solde: 5,
  });
  assert.deepEqual(ledger.mouvements.map((row) => row.type), ['facture', 'paiement', 'escompte', 'note_debit']);
});

test('grand livre fournisseur distingue note de crédit qualité et escompte obtenu', () => {
  const ledger = buildThirdPartyLedger({
    partyType: 'fournisseur',
    invoices: [{ id: 1, dateFacture: '2026-02-01', numeroFacture: 'A-1', totalTTC: 120 }],
    payments: [{ id: 1, datePaiement: '2026-02-10', reference: 'R-1', montant: 99, escompteMontant: 1 }],
    adjustments: [{ id: 1, dateNote: '2026-02-11', numero: 'NC-1', totalTTC: 20 }],
  });
  assert.deepEqual(ledger.totaux, {
    factures: 120, paiements: 99, retours: 0, notesDebit: 0, notesCredit: 20, escomptes: 1, solde: 0,
  });
});
