import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Forfaits publics Lite (Cap, 27 nov. 2026) : la page /guide est publique et
// doit afficher les deux forfaits décidés, en dur (les lignes
// plans_abonnement en base sont des brouillons actif=false — on ne les
// utilise pas ici). Si un prix ou une limite change, ce test doit être mis
// à jour en même temps que UserGuide.jsx.

const guidePath = new URL(
  '../../../artifacts/comptaorion-lite/src/UserGuide.jsx',
  import.meta.url
);
const loginPath = new URL(
  '../../../artifacts/comptaorion-lite/src/pages/Login.jsx',
  import.meta.url
);
const appPath = new URL(
  '../../../artifacts/comptaorion-lite/src/App.tsx',
  import.meta.url
);

const guide = readFileSync(guidePath, 'utf8');
const login = readFileSync(loginPath, 'utf8');
const app = readFileSync(appPath, 'utf8');

test('la page publique /guide affiche les deux forfaits décidés', () => {
  assert.match(guide, /Services/);
  assert.match(guide, /2 500/);
  assert.match(guide, /Équipe/);
  assert.match(guide, /10 000/);
  assert.match(guide, /FCFA \/ mois/);
});

test('la page publique /guide affiche les limites décidées de chaque forfait', () => {
  assert.match(guide, /3 utilisateurs/);
  assert.match(guide, /3 Go/);
  assert.match(guide, /10 utilisateurs/);
  assert.match(guide, /10 Go/);
  assert.match(guide, /Assistance prioritaire/);
});

test('la page publique /guide rappelle l’essai et les 2 mois offerts', () => {
  assert.match(guide, /30 jours/);
  assert.match(guide, /2 mois offerts/);
});

test('la section forfaits est ancrée et liée depuis la page de connexion', () => {
  assert.match(guide, /id="forfaits"/);
  assert.match(login, /\/guide#forfaits/);
});

test('la route /guide reste publique (aucune garde d’authentification)', () => {
  assert.match(app, /<Route path="\/guide" component=\{UserGuide\} \/>/);
});
