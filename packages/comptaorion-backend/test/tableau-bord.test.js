// Tableau de bord regroupé (28 nov. 2026, performance) : l'assemblage de
// la réponse reprend les enveloppes des 5 routes d'origine, pour que
// LiteApp mappe les données à l'identique. Test pur, sans base.
import test from 'node:test';
import assert from 'node:assert/strict';

import { assemblerTableauBord } from '../src/routes/tableau-bord.js';

// Même mapping que LiteApp.load() : unwrap + aplatissement facture/client.
const unwrap = (r) => r?.data?.data || r?.data || r || [];
function mapperTableauBord(body) {
  return {
    clients: unwrap(body?.clients),
    invoices: unwrap(body?.factures).map((x) => ({ ...(x.facture || x), client: x.client })),
    products: unwrap(body?.produits),
    expenses: unwrap(body?.depenses),
    daySummary: body?.jour || null,
  };
}

const clientsList = [{ id: 1, nom: 'Coopérative Agri-Sud' }, { id: 2, nom: 'Ferme des Plateaux' }];
const facturesList = [
  { facture: { id: 11, numeroFacture: 'FACT-2026-1-0001', totalTTC: '177000.00' }, client: { id: 1, nom: 'Coopérative Agri-Sud', email: null, telephone: '+228 90 11 22 33' } },
  { facture: { id: 12, numeroFacture: 'FACT-2026-1-0002', totalTTC: '88500.00' }, client: { id: 2, nom: 'Ferme des Plateaux', email: null, telephone: '+228 90 22 33 44' } },
];
const produitsList = [{ id: 5, nom: 'Tenue de comptabilité mensuelle' }];
const depensesList = [{ id: 9, description: 'Loyer boutique', montant: '180000.00' }];
const jour = { date: '2026-11-28', ventes: 265500, nombreVentes: 2, encaissements: 70000, nombrePaiements: 1, tauxTva: 18 };

test('assemblage : mêmes enveloppes que les 5 routes d’origine', () => {
  const body = assemblerTableauBord({ clientsList, facturesList, produitsList, depensesList, jour });
  assert.equal(body.success, true);
  assert.deepEqual(body.clients, { success: true, count: 2, data: clientsList });
  assert.deepEqual(body.factures, { success: true, count: 2, data: facturesList });
  assert.deepEqual(body.produits, { success: true, count: 1, data: produitsList });
  assert.deepEqual(body.depenses, depensesList);
  assert.deepEqual(body.jour, jour);
});

test('mapping LiteApp : clients, factures aplaties avec client, jour', () => {
  const body = assemblerTableauBord({ clientsList, facturesList, produitsList, depensesList, jour });
  const mapped = mapperTableauBord(body);
  assert.deepEqual(mapped.clients, clientsList);
  assert.equal(mapped.invoices.length, 2);
  assert.equal(mapped.invoices[0].numeroFacture, 'FACT-2026-1-0001');
  assert.equal(mapped.invoices[0].client.nom, 'Coopérative Agri-Sud');
  assert.equal(mapped.invoices[1].client.nom, 'Ferme des Plateaux');
  assert.deepEqual(mapped.products, produitsList);
  assert.deepEqual(mapped.expenses, depensesList);
  assert.deepEqual(mapped.daySummary, jour);
});

test('listes vides : le tableau de bord reste affichable', () => {
  const body = assemblerTableauBord({
    clientsList: [], facturesList: [], produitsList: [], depensesList: [],
    jour: { date: '2026-11-28', ventes: 0, nombreVentes: 0, encaissements: 0, nombrePaiements: 0, tauxTva: 18 },
  });
  const mapped = mapperTableauBord(body);
  assert.deepEqual(mapped.clients, []);
  assert.deepEqual(mapped.invoices, []);
  assert.deepEqual(mapped.products, []);
  assert.deepEqual(mapped.expenses, []);
  assert.equal(mapped.daySummary.ventes, 0);
});
