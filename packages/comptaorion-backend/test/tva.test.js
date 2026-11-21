import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  TAUX_TVA_DEFAUT,
  normaliserTauxTva,
  tauxTvaEntreprise,
  tauxTvaParPays,
  calculerTva,
} from '../src/utils/tva.js';

// Décision Cap, 21 nov. 2026 : taux de TVA choisi par l'utilisateur à la
// création de l'entreprise — 0 %, 18 % (défaut) ou taux personnalisé.
// 0 % est une valeur valide : il ne doit jamais retomber à 18 %.

test('normaliserTauxTva accepte 0 %, 18 % et les taux personnalisés', () => {
  assert.equal(normaliserTauxTva(0), 0);
  assert.equal(normaliserTauxTva('0'), 0);
  assert.equal(normaliserTauxTva(18), 18);
  assert.equal(normaliserTauxTva('18'), 18);
  assert.equal(normaliserTauxTva(7.5), 7.5);
  assert.equal(normaliserTauxTva('7,5'), 7.5);
  assert.equal(normaliserTauxTva(19.25), 19.25);
  assert.equal(normaliserTauxTva(100), 100);
});

test('normaliserTauxTva rejette les valeurs absentes ou hors bornes', () => {
  assert.equal(normaliserTauxTva(undefined), null);
  assert.equal(normaliserTauxTva(null), null);
  assert.equal(normaliserTauxTva(''), null);
  assert.equal(normaliserTauxTva(-1), null);
  assert.equal(normaliserTauxTva(100.01), null);
  assert.equal(normaliserTauxTva('abc'), null);
  assert.equal(normaliserTauxTva(NaN), null);
});

test('le défaut est 18 % et ne change pas', () => {
  assert.equal(TAUX_TVA_DEFAUT, 18);
  assert.equal(tauxTvaParPays('Togo'), 18);
  assert.equal(tauxTvaParPays('Bénin'), 18);
  assert.equal(tauxTvaParPays('Niger'), 19);
  assert.equal(tauxTvaParPays('Cameroun'), 19.25);
  assert.equal(tauxTvaParPays('Pays imaginaire'), 18);
});

test('tauxTvaEntreprise : 0 % reste 0 % (non-régression du bug `|| 18`)', () => {
  // Avant le correctif, `parseFloat(taux || 18)` transformait 0 % en 18 %.
  assert.equal(tauxTvaEntreprise({ tauxTva: '0.00' }), 0);
  assert.equal(tauxTvaEntreprise({ tauxTva: 0 }), 0);
  assert.equal(tauxTvaEntreprise({ tauxTva: '0' }), 0);
  assert.equal(tauxTvaEntreprise({ tauxTva: '18.00' }), 18);
  assert.equal(tauxTvaEntreprise({ tauxTva: '7.50' }), 7.5);
  assert.equal(tauxTvaEntreprise({ tauxTva: null }), 18);
  assert.equal(tauxTvaEntreprise({}), 18);
  assert.equal(tauxTvaEntreprise(null), 18);
  assert.equal(tauxTvaEntreprise({ tauxTva: 'invalide' }), 18);
});

test('calculerTva : 0 % donne 0, taux personnalisé appliqué tel quel', () => {
  // Vente / achat de 100 000 HT.
  assert.equal(calculerTva(100000, 0), 0);
  assert.equal(calculerTva(100000, 18), 18000);
  assert.equal(calculerTva(100000, 7.5), 7500);
  assert.equal(calculerTva(100000, '19.25'), 19250);
  assert.equal(calculerTva(100000, null), 0);
  // Arrondi au centime.
  assert.equal(calculerTva(199.99, 18), 36);
  assert.equal(calculerTva(0, 18), 0);
});

// ---------------------------------------------------------------------------
// POST /api/auth/register — le taux choisi est enregistré sur l'entreprise.
// ---------------------------------------------------------------------------

// Les routes d'auth exigent JWT_SECRET au chargement (comme en production).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secret-test-tva-32-caracteres-minimum';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'secret-refresh-test-tva-32-caracteres';

const { entreprises, users, saasClients } = await import('../src/schema.js');
const { runWithDatabaseContext } = await import('../src/db.js');
const { default: authRoutes } = await import('../src/routes/auth.js');

function fakeDbPourInscription(captures) {
  // Chaîne select : `.where(...)` est attendue directement (sans .limit)
  // pour la recherche d'e-mail, et avec `.limit(1)` pour le username.
  const whereResult = () => {
    const result = [];
    result.limit = async () => [];
    return result;
  };
  const select = () => ({ from: () => ({ where: () => whereResult() }) });
  const insert = (table) => ({
    values: (rows) => ({
      returning: async () => {
        const lignes = (Array.isArray(rows) ? rows : [rows]).map((row, index) => {
          if (table === entreprises) {
            const creee = { id: 999, ...row };
            captures.entreprises.push(creee);
            return creee;
          }
          if (table === users) return { id: 55, ...row };
          if (table === saasClients) {
            return { id: 7, statut: 'trial', dateInscription: new Date(), ...row };
          }
          return { id: 1000 + index, ...row };
        });
        return lignes;
      },
    }),
  });
  return {
    select,
    insert,
    transaction: async (fn) => fn({ select, insert }),
  };
}

async function inscrire(t, body, captures = { entreprises: [] }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) =>
    runWithDatabaseContext({ db: fakeDbPourInscription(captures), pool: {} }, next));
  app.use('/api/auth', authRoutes);
  const server = app.listen(0);
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json(), captures };
}

const inscriptionBase = {
  username: 'boutique-test',
  email: 'boutique@test.tg',
  password: 'mot-de-passe-tres-long-123',
  nom: 'Test',
  prenom: 'Boutique',
  entrepriseNom: 'Boutique Test TVA',
};

test('inscription avec 0 % : l’entreprise est créée avec un taux de 0', async (t) => {
  const { response, payload, captures } = await inscrire(t, { ...inscriptionBase, tauxTva: 0 });
  assert.equal(response.status, 201);
  assert.equal(captures.entreprises.length, 1);
  assert.equal(captures.entreprises[0].tauxTva, '0.00');
  assert.equal(payload.entreprise.tauxTva, '0.00');
});

test('inscription avec 18 % : l’entreprise est créée avec un taux de 18', async (t) => {
  const { response, payload, captures } = await inscrire(t, { ...inscriptionBase, tauxTva: 18 });
  assert.equal(response.status, 201);
  assert.equal(captures.entreprises[0].tauxTva, '18.00');
  assert.equal(payload.entreprise.tauxTva, '18.00');
});

test('inscription avec un taux personnalisé (7,5 %) : taux enregistré tel quel', async (t) => {
  const { response, payload, captures } = await inscrire(t, { ...inscriptionBase, tauxTva: 7.5 });
  assert.equal(response.status, 201);
  assert.equal(captures.entreprises[0].tauxTva, '7.50');
  assert.equal(payload.entreprise.tauxTva, '7.50');
});

test('inscription sans taux : le défaut 18 % est appliqué', async (t) => {
  const { response, payload, captures } = await inscrire(t, { ...inscriptionBase });
  assert.equal(response.status, 201);
  assert.equal(captures.entreprises[0].tauxTva, '18.00');
  assert.equal(payload.entreprise.tauxTva, '18.00');
});

test('inscription avec un taux invalide : refusée en 400', async (t) => {
  for (const tauxInvalide of [150, -5, 'abc']) {
    const { response, captures } = await inscrire(t, { ...inscriptionBase, tauxTva: tauxInvalide });
    assert.equal(response.status, 400);
    assert.equal(captures.entreprises.length, 0);
  }
});
