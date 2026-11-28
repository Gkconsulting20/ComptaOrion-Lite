import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OCTETS_PAR_GO,
  compterUtilisateursActifs,
  erreurLimitePlan,
  limitesPourEntreprise,
  mesurerStockageOctets,
  resoudreLimitesPlan,
  verifierLimiteStockage,
  verifierLimiteUtilisateurs,
} from '../src/plan-limits.js';
import {
  abonnements,
  backupJobs,
  entreprises,
  exportHistory,
  importBatches,
  plansAbonnement,
  users,
} from '../src/schema.js';

// Limites des forfaits Lite (Cap, 27 nov. 2026) :
// Services 2 500 FCFA/mois (3 utilisateurs, 3 Go) / Équipe 10 000
// FCFA/mois (10 utilisateurs, 10 Go). Modèle de refus : Orion Santé
// (403 « Limite du plan ... atteinte ... »).
// Contraintes : essai, démo et propriétaire de la plateforme ne sont
// jamais bloqués. Les plans Lite sont des brouillons en base
// (actif=false) et aucune entreprise ne porte d'abonnement actif :
// l'enforcement est donc testé ici sur des bases factices.

const GO = OCTETS_PAR_GO;
const PROPRIETAIRE = { id: 1, email: 'admin@orionexa.net', role: 'admin' };
const ADMIN_AUTRE = { id: 9, email: 'commercial@orionexa.net', role: 'admin' };
const EMPLOYE = { id: 5, email: 'user@entreprise.tg', role: 'employee' };

const PLAN_SERVICES = { id: 2, nom: 'Services', prix: '2500', limiteUtilisateurs: 3, stockageGb: 3, actif: false };
const PLAN_EQUIPE = { id: 3, nom: 'Équipe', prix: '10000', limiteUtilisateurs: 10, stockageGb: 10, actif: false };
const ABO_SERVICES = { id: 1, entrepriseId: 42, planId: 2, statut: 'actif' };
const ABO_EQUIPE = { id: 2, entrepriseId: 42, planId: 3, statut: 'actif' };
const ABO_EXPIRE = { id: 3, entrepriseId: 42, planId: 2, statut: 'expire' };
const ENTREPRISE = { id: 42, nom: 'Test', isDemo: false };
const ENTREPRISE_DEMO = { id: 43, nom: 'Démo', isDemo: true };

const nbUtilisateurs = (n) => Array.from({ length: n }, (_, i) => ({ id: 100 + i, entrepriseId: 42, actif: true }));

// Fausse base au style des autres tests (chaînes select/from/where) :
// where() renvoie les lignes de la table (awaitable) avec une méthode
// limit() pour les lectures à une seule ligne.
function stubDb({ entreprise = ENTREPRISE, abonnement = null, plan = null, utilisateurs = [], imports = [], backups = [], exports = [] } = {}) {
  const lignesPour = (table) => (
    table === entreprises ? (entreprise ? [entreprise] : [])
    : table === abonnements ? (abonnement ? [abonnement] : [])
    : table === plansAbonnement ? (plan ? [plan] : [])
    : table === users ? utilisateurs
    : table === importBatches ? imports
    : table === backupJobs ? backups
    : table === exportHistory ? exports
    : []
  );
  return {
    select: () => ({
      from: (table) => ({
        where: () => {
          const lignes = lignesPour(table);
          lignes.limit = async () => lignes.slice(0, 1);
          return lignes;
        },
        limit: async () => lignesPour(table).slice(0, 1),
      }),
    }),
  };
}

test('erreurLimitePlan porte un 403 avec le code PLAN_LIMIT_REACHED', () => {
  const erreur = erreurLimitePlan('Limite atteinte.');
  assert.equal(erreur.message, 'Limite atteinte.');
  assert.equal(erreur.statut, 403);
  assert.equal(erreur.code, 'PLAN_LIMIT_REACHED');
});

test('le propriétaire de la plateforme n’est jamais limité', async () => {
  const db = stubDb({ abonnement: ABO_SERVICES, plan: PLAN_SERVICES, utilisateurs: nbUtilisateurs(99) });
  const limites = await resoudreLimitesPlan(db, 42, PROPRIETAIRE);
  assert.deepEqual(limites, {
    illimite: true, source: 'proprietaire-plateforme', planNom: null, planId: null, limiteUtilisateurs: null, stockageGb: null,
  });
  const resultat = await verifierLimiteUtilisateurs(db, 42, PROPRIETAIRE);
  assert.equal(resultat.utilisateursActuels, 99);
  await verifierLimiteStockage(db, 42, 100 * GO, PROPRIETAIRE);
});

test('un autre admin ne bénéficie pas du contournement propriétaire', async () => {
  const db = stubDb({ abonnement: ABO_SERVICES, plan: PLAN_SERVICES, utilisateurs: nbUtilisateurs(3) });
  await assert.rejects(
    verifierLimiteUtilisateurs(db, 42, ADMIN_AUTRE),
    /Limite du plan « Services » atteinte \(3 utilisateurs maximum\)/,
  );
});

test('une entreprise de démonstration n’est jamais limitée', async () => {
  const db = stubDb({ entreprise: ENTREPRISE_DEMO, abonnement: ABO_SERVICES, plan: PLAN_SERVICES, utilisateurs: nbUtilisateurs(99) });
  assert.equal((await resoudreLimitesPlan(db, 43, EMPLOYE)).source, 'demo');
  await verifierLimiteUtilisateurs(db, 43, EMPLOYE);
  await verifierLimiteStockage(db, 43, 100 * GO, EMPLOYE);
});

test('sans abonnement actif, l’entreprise est en essai et n’est pas limitée', async () => {
  const db = stubDb({ utilisateurs: nbUtilisateurs(50) });
  assert.equal((await resoudreLimitesPlan(db, 42, EMPLOYE)).source, 'essai');
  await verifierLimiteUtilisateurs(db, 42, EMPLOYE);
  await verifierLimiteStockage(db, 42, 100 * GO, EMPLOYE);

  const dbExpire = stubDb({ abonnement: ABO_EXPIRE, plan: PLAN_SERVICES, utilisateurs: nbUtilisateurs(50) });
  assert.equal((await resoudreLimitesPlan(dbExpire, 42, EMPLOYE)).source, 'essai');
  await verifierLimiteUtilisateurs(dbExpire, 42, EMPLOYE);
});

test('abonnement actif : les limites du plan sont résolues', async () => {
  const db = stubDb({ abonnement: ABO_SERVICES, plan: PLAN_SERVICES });
  assert.deepEqual(await resoudreLimitesPlan(db, 42, EMPLOYE), {
    illimite: false, source: 'abonnement', planNom: 'Services', planId: 2, limiteUtilisateurs: 3, stockageGb: 3,
  });
  const dbEquipe = stubDb({ abonnement: ABO_EQUIPE, plan: PLAN_EQUIPE });
  const limitesEquipe = await resoudreLimitesPlan(dbEquipe, 42, EMPLOYE);
  assert.equal(limitesEquipe.planNom, 'Équipe');
  assert.equal(limitesEquipe.limiteUtilisateurs, 10);
  assert.equal(limitesEquipe.stockageGb, 10);
});

test('utilisateurs Services : 2 passent, le 3e est refusé en 403 (modèle Santé)', async () => {
  const dbOk = stubDb({ abonnement: ABO_SERVICES, plan: PLAN_SERVICES, utilisateurs: nbUtilisateurs(2) });
  const resultat = await verifierLimiteUtilisateurs(dbOk, 42, EMPLOYE);
  assert.equal(resultat.utilisateursActuels, 2);
  assert.equal(resultat.limiteUtilisateurs, 3);

  const dbPlein = stubDb({ abonnement: ABO_SERVICES, plan: PLAN_SERVICES, utilisateurs: nbUtilisateurs(3) });
  await assert.rejects(
    verifierLimiteUtilisateurs(dbPlein, 42, EMPLOYE),
    (erreur) => {
      assert.equal(erreur.statut, 403);
      assert.match(erreur.message, /Limite du plan « Services » atteinte \(3 utilisateurs maximum\)\. Passez à un plan supérieur pour en ajouter\./);
      return true;
    },
  );
});

test('utilisateurs Équipe : 9 passent, le 10e est refusé en 403', async () => {
  const dbOk = stubDb({ abonnement: ABO_EQUIPE, plan: PLAN_EQUIPE, utilisateurs: nbUtilisateurs(9) });
  assert.equal((await verifierLimiteUtilisateurs(dbOk, 42, EMPLOYE)).utilisateursActuels, 9);
  const dbPlein = stubDb({ abonnement: ABO_EQUIPE, plan: PLAN_EQUIPE, utilisateurs: nbUtilisateurs(10) });
  await assert.rejects(
    verifierLimiteUtilisateurs(dbPlein, 42, EMPLOYE),
    /Limite du plan « Équipe » atteinte \(10 utilisateurs maximum\)/,
  );
});

test('seuls les utilisateurs actifs consomment un siège', async () => {
  const db = stubDb({
    abonnement: ABO_SERVICES,
    plan: PLAN_SERVICES,
    utilisateurs: [
      ...nbUtilisateurs(2),
      { id: 200, entrepriseId: 42, actif: false },
      { id: 201, entrepriseId: 42, actif: false },
    ],
  });
  assert.equal(await compterUtilisateursActifs(db, 42), 2);
  assert.equal((await verifierLimiteUtilisateurs(db, 42, EMPLOYE)).utilisateursActuels, 2);
});

test('stockage Services : 2 Go utilisés + 0,5 Go passe, + 0,2 Go au-delà de 2,9 Go est refusé', async () => {
  const imports = [{ tailleFichier: 2 * GO }];
  const dbOk = stubDb({ abonnement: ABO_SERVICES, plan: PLAN_SERVICES, imports });
  const resultat = await verifierLimiteStockage(dbOk, 42, Math.floor(0.5 * GO), EMPLOYE);
  assert.equal(resultat.stockageOctetsUtilises, 2 * GO);

  const dbPlein = stubDb({
    abonnement: ABO_SERVICES,
    plan: PLAN_SERVICES,
    imports: [{ tailleFichier: Math.floor(2.9 * GO) }],
  });
  await assert.rejects(
    verifierLimiteStockage(dbPlein, 42, Math.floor(0.2 * GO), EMPLOYE),
    (erreur) => {
      assert.equal(erreur.statut, 403);
      assert.match(erreur.message, /Limite du plan « Services » atteinte \(3 Go de stockage maximum/);
      return true;
    },
  );
});

test('stockage Équipe : 9,5 Go utilisés + 0,4 Go passe, + 0,6 Go est refusé', async () => {
  const dbOk = stubDb({ abonnement: ABO_EQUIPE, plan: PLAN_EQUIPE, imports: [{ tailleFichier: Math.floor(9.5 * GO) }] });
  await verifierLimiteStockage(dbOk, 42, Math.floor(0.4 * GO), EMPLOYE);
  const dbPlein = stubDb({ abonnement: ABO_EQUIPE, plan: PLAN_EQUIPE, imports: [{ tailleFichier: Math.floor(9.5 * GO) }] });
  await assert.rejects(
    verifierLimiteStockage(dbPlein, 42, Math.floor(0.6 * GO), EMPLOYE),
    /Limite du plan « Équipe » atteinte \(10 Go de stockage maximum/,
  );
});

test('mesurerStockageOctets cumule imports, sauvegardes et exports', async () => {
  const db = stubDb({
    imports: [{ tailleFichier: 1000000 }, { tailleFichier: null }],
    backups: [{ tailleFichier: 2000000 }],
    exports: [{ tailleFichier: 500000 }, { tailleFichier: 'non-numérique' }],
  });
  assert.equal(await mesurerStockageOctets(db, 42), 3500000);
});

test('une limite à NULL sur le plan ne bloque pas cette dimension', async () => {
  const planSansLimites = { id: 9, nom: 'Sur mesure', prix: '0', limiteUtilisateurs: null, stockageGb: null, actif: true };
  const db = stubDb({
    abonnement: { id: 9, entrepriseId: 42, planId: 9, statut: 'actif' },
    plan: planSansLimites,
    utilisateurs: nbUtilisateurs(50),
    imports: [{ tailleFichier: 50 * GO }],
  });
  const limites = await resoudreLimitesPlan(db, 42, EMPLOYE);
  assert.equal(limites.illimite, false);
  assert.equal(limites.limiteUtilisateurs, null);
  assert.equal(limites.stockageGb, null);
  await verifierLimiteUtilisateurs(db, 42, EMPLOYE);
  await verifierLimiteStockage(db, 42, 10 * GO, EMPLOYE);
});

test('limitesPourEntreprise renvoie la vue d’ensemble sans refuser', async () => {
  const db = stubDb({
    abonnement: ABO_SERVICES,
    plan: PLAN_SERVICES,
    utilisateurs: nbUtilisateurs(3),
    imports: [{ tailleFichier: 3 * GO }],
  });
  assert.deepEqual(await limitesPourEntreprise(db, 42, EMPLOYE), {
    illimite: false,
    source: 'abonnement',
    planNom: 'Services',
    planId: 2,
    limiteUtilisateurs: 3,
    stockageGb: 3,
    utilisateursActuels: 3,
    stockageOctetsUtilises: 3 * GO,
  });
});
