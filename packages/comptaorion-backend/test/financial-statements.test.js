import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinancialStatements } from '../src/services/financialStatements.js';

test('builds a profit and loss statement and a balanced balance sheet from SYSCOHADA account movements', () => {
  const report = buildFinancialStatements({
    dateDebut: '2026-01-01',
    dateFin: '2026-12-31',
    incomeRows: [
      { numero: '701', nom: 'Ventes', debit: '0', credit: '600' },
      { numero: '621', nom: 'Services extérieurs', debit: '200', credit: '0' },
    ],
    balanceRows: [
      { numero: '512', nom: 'Banque', debit: '700', credit: '0' },
      { numero: '411', nom: 'Clients', debit: '100', credit: '0' },
      { numero: '101', nom: 'Capital', debit: '0', credit: '340' },
      { numero: '401', nom: 'Fournisseurs', debit: '0', credit: '60' },
    ],
    quality: { nombreEcritures: 3, ecrituresNonValidees: 1, ecrituresNonEquilibrees: 0 },
  });

  assert.equal(report.etatResultat.totalProduits, 600);
  assert.equal(report.etatResultat.totalCharges, 200);
  assert.equal(report.etatResultat.resultatNet, 400);
  assert.equal(report.bilan.totalActif, 800);
  assert.equal(report.bilan.totalPassif, 800);
  assert.equal(report.bilan.equilibre, true);
  assert.equal(report.qualite.ecrituresNonValidees, 1);
});

test('reports an out-of-balance difference instead of hiding it', () => {
  const report = buildFinancialStatements({
    dateDebut: '2026-01-01',
    dateFin: '2026-06-30',
    incomeRows: [],
    balanceRows: [{ numero: '512', nom: 'Banque', debit: 500, credit: 0 }],
    quality: {},
  });

  assert.equal(report.bilan.totalActif, 500);
  assert.equal(report.bilan.totalPassif, 0);
  assert.equal(report.bilan.ecart, 500);
  assert.equal(report.bilan.equilibre, false);
});
