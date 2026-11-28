// ============================================================
// LIMITES DES FORFAITS — UTILISATEURS & STOCKAGE
// ============================================================
// Décision du fondateur (27 nov. 2026) : Lite Services 2 500 FCFA/mois
// (3 utilisateurs, 3 Go) / Équipe 10 000 FCFA/mois (10 utilisateurs,
// 10 Go, assistance prioritaire), essai 30 jours puis 2 mois offerts.
// La page publique /guide « Nos forfaits » énonce déjà ces limites ;
// ce module les fait APPLIQUER par le logiciel.
//
// Modèle suivi : Orion Santé — à la création, si le plan est atteint,
// refus explicite en 403 (« Limite du plan ... atteinte ... Passez à
// un plan supérieur pour en ajouter. »).
//
// Règles Lite (contraintes Cap, 28 nov. 2026) :
// - Les limites s'appliquent au plan COURANT de l'entreprise, c'est-
//   à-dire à son abonnement actif (table `abonnements` → plan dans
//   `plans_abonnement`). Sans abonnement actif, l'entreprise est en
//   essai : elle n'est PAS bloquée.
// - Les entreprises de démonstration (`entreprises.is_demo`) ne sont
//   PAS bloquées.
// - Le propriétaire de la plateforme (admin@orionexa.net, même règle
//   que trial-access.js) n'est PAS bloqué.
// - Une limite à NULL sur le plan = dimension non limitée.
// - Le stockage mesuré est la somme des tailles de fichiers suivies
//   en base : import_batches, backup_jobs, export_history (seules
//   tables avec une taille de fichier). Les photos IA ne sont jamais
//   conservées (« Photo bytes are neither saved nor logged ») et le
//   logo est un fichier unique remplacé à chaque envoi : le contrôle
//   du logo porte donc sur la taille du fichier entrant, pas sur un
//   cumul disque.
//
// Points d'application (28 nov. 2026) :
// - Stockage : POST /api/import/upload (import.js) et POST /api/logo
//   (upload.js) — ces deux routeurs ne sont pas montés dans app.js à
//   ce jour : le contrôle est en place dans leur code et prendra effet
//   dès leur montage. Aucun autre point de consommation de stockage
//   persistant n'existe dans Lite.
// - Utilisateurs : il n'existe AUCUN point d'ajout d'utilisateur à
//   une entreprise existante dans Lite (les utilisateurs ne sont créés
//   qu'avec leur entreprise : inscription, inscription publique,
//   démo). `verifierLimiteUtilisateurs` est le contrôle à brancher sur
//   le futur point d'invitation/ajout ; il est couvert par tests.
// - La création d'abonnement (saas-offre.js) n'est pas bloquée : un
//   plan brouillon (actif=false) y est déjà refusé, et une entreprise
//   en essai peut dépasser la limite du plan qu'on lui attribue —
//   c'est l'ajout ultérieur qui sera refusé.

import { and, eq } from 'drizzle-orm';
import {
  abonnements,
  backupJobs,
  entreprises,
  exportHistory,
  importBatches,
  plansAbonnement,
  users,
} from './schema.js';

const OWNER_EMAIL = (process.env.SAAS_PLATFORM_OWNER_EMAIL || 'admin@orionexa.net').trim().toLowerCase();

// 1 Go = 1024^3 octets (même unité que stockage_gb des plans).
export const OCTETS_PAR_GO = 1024 * 1024 * 1024;

// Erreur métier portée par un dépassement de limite de forfait
// (statut HTTP joint, comme erreurAbonnement dans saas-offre.js).
export function erreurLimitePlan(message) {
  const erreur = new Error(message);
  erreur.statut = 403;
  erreur.code = 'PLAN_LIMIT_REACHED';
  return erreur;
}

function entierOuNull(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return null;
  const nombre = Number(valeur);
  return Number.isSafeInteger(nombre) && nombre >= 0 ? nombre : null;
}

function enGo(octets) {
  const go = Number(octets) / OCTETS_PAR_GO;
  return `${go % 1 === 0 ? String(go) : go.toFixed(2)} Go`;
}

// Nombre d'utilisateurs actifs de l'entreprise (un compte désactivé
// ne consomme pas de siège). Le filtre `actif` est appliqué en JS en
// plus du WHERE, pour que le comptage reste exact si la colonne vaut
// NULL sur d'anciennes lignes (traitées comme actives).
export async function compterUtilisateursActifs(database, entrepriseId) {
  const lignes = await database.select()
    .from(users)
    .where(and(eq(users.entrepriseId, Number(entrepriseId)), eq(users.actif, true)));
  return lignes.filter((ligne) => ligne.actif !== false).length;
}

// Stockage consommé par l'entreprise, en octets (somme des tailles de
// fichiers suivies en base — voir l'en-tête du module).
export async function mesurerStockageOctets(database, entrepriseId) {
  const idEntreprise = Number(entrepriseId);
  let total = 0;
  for (const table of [importBatches, backupJobs, exportHistory]) {
    const lignes = await database.select()
      .from(table)
      .where(eq(table.entrepriseId, idEntreprise));
    for (const ligne of lignes) {
      const taille = Number(ligne.tailleFichier);
      if (Number.isFinite(taille) && taille > 0) total += taille;
    }
  }
  return total;
}

// Résout les limites du plan COURANT de l'entreprise.
// Retourne { illimite, source, planNom, planId, limiteUtilisateurs,
// stockageGb } où `source` vaut 'proprietaire-plateforme', 'demo',
// 'essai', 'abonnement' ou 'abonnement-sans-plan'.
export async function resoudreLimitesPlan(database, entrepriseId, user = {}) {
  const sansLimite = (source) => ({
    illimite: true,
    source,
    planNom: null,
    planId: null,
    limiteUtilisateurs: null,
    stockageGb: null,
  });

  const email = String(user.email || '').trim().toLowerCase();
  if (user.role === 'admin' && email === OWNER_EMAIL) {
    return sansLimite('proprietaire-plateforme');
  }

  const [entreprise] = await database.select()
    .from(entreprises)
    .where(eq(entreprises.id, Number(entrepriseId)))
    .limit(1);
  if (entreprise?.isDemo) {
    return sansLimite('demo');
  }

  // Seul un abonnement au statut 'actif' porte un plan courant (le
  // filtre statut est appliqué en JS en plus du WHERE, comme pour le
  // comptage des utilisateurs — voir compterUtilisateursActifs).
  const lignesAbonnement = await database.select()
    .from(abonnements)
    .where(eq(abonnements.entrepriseId, Number(entrepriseId)))
    .limit(1);
  const abonnement = lignesAbonnement.find((ligne) => ligne.statut === 'actif');
  if (!abonnement) {
    return sansLimite('essai');
  }

  const [plan] = await database.select()
    .from(plansAbonnement)
    .where(eq(plansAbonnement.id, abonnement.planId))
    .limit(1);
  if (!plan) {
    return sansLimite('abonnement-sans-plan');
  }

  return {
    illimite: false,
    source: 'abonnement',
    planNom: plan.nom,
    planId: plan.id,
    limiteUtilisateurs: entierOuNull(plan.limiteUtilisateurs),
    stockageGb: entierOuNull(plan.stockageGb),
  };
}

// Refuse (403, modèle Orion Santé) l'ajout d'un utilisateur quand le
// plan courant est atteint. Retourne les limites résolues et le nombre
// actuel d'utilisateurs quand l'ajout est autorisé.
export async function verifierLimiteUtilisateurs(database, entrepriseId, user = {}) {
  const limites = await resoudreLimitesPlan(database, entrepriseId, user);
  const utilisateursActuels = await compterUtilisateursActifs(database, entrepriseId);
  const resultat = { ...limites, utilisateursActuels };
  if (
    !limites.illimite
    && limites.limiteUtilisateurs !== null
    && utilisateursActuels >= limites.limiteUtilisateurs
  ) {
    throw erreurLimitePlan(
      `Limite du plan « ${limites.planNom} » atteinte (${limites.limiteUtilisateurs} utilisateurs maximum). Passez à un plan supérieur pour en ajouter.`,
    );
  }
  return resultat;
}

// Refuse (403, modèle Orion Santé) un ajout de `octetsAAjouter` octets
// quand le stockage du plan courant serait dépassé. Retourne les
// limites résolues et le stockage actuel quand l'ajout est autorisé.
export async function verifierLimiteStockage(database, entrepriseId, octetsAAjouter, user = {}) {
  const limites = await resoudreLimitesPlan(database, entrepriseId, user);
  const stockageOctetsUtilises = await mesurerStockageOctets(database, entrepriseId);
  const resultat = { ...limites, stockageOctetsUtilises };
  const ajout = Number(octetsAAjouter);
  if (
    !limites.illimite
    && limites.stockageGb !== null
    && Number.isFinite(ajout) && ajout > 0
    && stockageOctetsUtilises + ajout > limites.stockageGb * OCTETS_PAR_GO
  ) {
    throw erreurLimitePlan(
      `Limite du plan « ${limites.planNom} » atteinte (${limites.stockageGb} Go de stockage maximum, ${enGo(stockageOctetsUtilises)} déjà utilisés). Passez à un plan supérieur ou libérez de l’espace pour continuer.`,
    );
  }
  return resultat;
}

// Vue d'ensemble des limites et de la consommation courante, sans
// refuser (affichage / diagnostic).
export async function limitesPourEntreprise(database, entrepriseId, user = {}) {
  const limites = await resoudreLimitesPlan(database, entrepriseId, user);
  const [utilisateursActuels, stockageOctetsUtilises] = await Promise.all([
    compterUtilisateursActifs(database, entrepriseId),
    mesurerStockageOctets(database, entrepriseId),
  ]);
  return { ...limites, utilisateursActuels, stockageOctetsUtilises };
}
