// ============================================================
// OFFRE COMMERCIALE — 2 MOIS GRATUITS SUR L'ABONNEMENT
// ============================================================
// Décision du fondateur (20 nov. 2026) : chaque nouvel abonnement
// payant inclut 2 mois gratuits — offre agressive pour gagner des
// clients. L'essai gratuit reste à 30 jours (voir trial-access.js,
// NON modifié par cette offre).
//
// Modèle retenu (identique à Orion Santé) :
// - Les 2 mois gratuits font partie de la durée : fin d'abonnement
//   = début + durée (la durée ne change pas).
// - Le client paie prix mensuel × (durée − 2) ; la facturation
//   commence au 3e mois (dateDebutFacturation = début + 2 mois).
// - La commission du commercial (10 % par défaut) est calculée sur
//   le montant payé et n'est due que quand le client paie, donc à
//   partir du début de facturation (dateEcheanceCommission).
// - MRR : une entreprise en période gratuite ne contribue pas ; une
//   fois la facturation commencée, elle contribue à hauteur du prix
//   mensuel de son plan.
// - Durée ≤ 2 mois : montant 0, commission 0, vente à 0 FCFA.
//
// Les lignes déjà en base (sans mois_gratuits ni
// date_debut_facturation) sont traitées comme sans mois gratuit :
// date_debut_facturation = date_debut, donc le MRR ne change pas
// pour elles.

import { eq } from 'drizzle-orm';
import { abonnements, plansAbonnement, saasClients, saasCommerciaux, saasVentes } from './schema.js';

// Nombre de mois gratuits offerts sur chaque nouvel abonnement payant.
export const MOIS_GRATUITS_ABONNEMENT = 2;

// Taux de commission par défaut d'un commercial (10 %), comme dans
// le reste du module de commercialisation.
export const TAUX_COMMISSION_DEFAUT = 0.10;

// Nombre de mois effectivement payés par le client sur un abonnement
// de `dureeEnMois` mois, compte tenu des mois gratuits.
export function moisPayants(dureeEnMois, moisGratuits = MOIS_GRATUITS_ABONNEMENT) {
  const duree = Number(dureeEnMois);
  const gratuits = Number(moisGratuits);
  if (!Number.isFinite(duree) || !Number.isFinite(gratuits)) return 0;
  return Math.max(0, Math.trunc(duree) - Math.trunc(gratuits));
}

// Ajoute `nbMois` mois calendaires à une date (même sémantique que
// le `setMonth` déjà utilisé dans le code des abonnements).
export function ajouterMois(dateEntree, nbMois) {
  const date = new Date(dateEntree);
  date.setMonth(date.getMonth() + nbMois);
  return date;
}

// Formate une date au format AAAA-MM-JJ (format des colonnes `date`).
export function versDateISO(dateEntree) {
  return new Date(dateEntree).toISOString().slice(0, 10);
}

// Date de début de facturation = début de l'abonnement + mois gratuits.
export function dateDebutFacturation(dateDebut, moisGratuits = MOIS_GRATUITS_ABONNEMENT) {
  return versDateISO(ajouterMois(dateDebut, moisGratuits));
}

// Montant total payé par le client : prix mensuel × mois payants.
// Arrondi à 2 décimales (les montants sont stockés en NUMERIC(10,2)).
export function montantPayant(prixMensuel, dureeEnMois, moisGratuits = MOIS_GRATUITS_ABONNEMENT) {
  const prix = Number(prixMensuel);
  if (!Number.isFinite(prix) || prix < 0) return 0;
  return Math.round(prix * moisPayants(dureeEnMois, moisGratuits) * 100) / 100;
}

// Commission due au commercial sur un montant payé.
export function commissionSur(montant, taux = TAUX_COMMISSION_DEFAUT) {
  const base = Number(montant);
  const rate = Number(taux);
  if (!Number.isFinite(base) || !Number.isFinite(rate) || base <= 0 || rate <= 0) return 0;
  return Math.round(base * rate * 100) / 100;
}

// Calcule tous les éléments de l'offre pour un nouvel abonnement.
export function calculerOffreAbonnement({ prixMensuel, dureeEnMois, dateDebut, moisGratuits = MOIS_GRATUITS_ABONNEMENT }) {
  const debut = new Date(dateDebut);
  const payants = moisPayants(dureeEnMois, moisGratuits);
  const facturation = dateDebutFacturation(debut, moisGratuits);
  const expiration = versDateISO(ajouterMois(debut, dureeEnMois));
  return {
    moisGratuits,
    moisPayants: payants,
    montantTotal: montantPayant(prixMensuel, dureeEnMois, moisGratuits),
    dateDebutFacturation: facturation,
    dateExpiration: expiration,
    entierementGratuit: payants === 0,
  };
}

// Erreur métier portée par la création d'abonnement (statut HTTP joint).
export function erreurAbonnement(message, statut = 400) {
  const erreur = new Error(message);
  erreur.statut = statut;
  return erreur;
}

// ============================================================
// CRÉATION D'UN ABONNEMENT PAYANT (chemin administrateur)
// ============================================================
// Utilisée par la route d'administration (saas-admin.js et
// saas-platform-admin.js). Règles préservées du code existant :
// l'entreprise doit être enregistrée comme client SaaS et avoir un
// commercial assigné (sinon 400) ; le plan doit exister (sinon 404).
// La création met le client SaaS en statut 'actif' et enregistre
// automatiquement la vente confirmée correspondante.
export async function creerAbonnementPayant(db, { entrepriseId, planId, dateDebut, dureeEnMois, source = 'commercial' }) {
  const idEntreprise = parseInt(entrepriseId, 10);
  const idPlan = parseInt(planId, 10);
  const duree = parseInt(dureeEnMois, 10);
  if (!Number.isSafeInteger(idEntreprise) || idEntreprise < 1) {
    throw erreurAbonnement('Identifiant d’entreprise invalide.');
  }
  if (!Number.isSafeInteger(idPlan) || idPlan < 1) {
    throw erreurAbonnement('Identifiant de plan invalide.');
  }
  if (!Number.isSafeInteger(duree) || duree < 1) {
    throw erreurAbonnement('La durée de l’abonnement doit être d’au moins 1 mois.');
  }
  const debut = new Date(dateDebut);
  if (Number.isNaN(debut.getTime())) {
    throw erreurAbonnement('La date de début est invalide.');
  }

  const [clientSaas] = await db.select()
    .from(saasClients)
    .where(eq(saasClients.entrepriseId, idEntreprise))
    .limit(1);
  if (!clientSaas) {
    throw erreurAbonnement(
      'Cette entreprise n’est pas enregistrée comme client SaaS. Veuillez d’abord créer un client SaaS pour cette entreprise.',
    );
  }
  if (!clientSaas.commercialId) {
    throw erreurAbonnement(
      'Ce client SaaS n’a pas de commercial assigné. L’automatisation des ventes requiert un commercial assigné.',
    );
  }

  const [plan] = await db.select()
    .from(plansAbonnement)
    .where(eq(plansAbonnement.id, idPlan))
    .limit(1);
  if (!plan) {
    throw erreurAbonnement('Plan non trouvé', 404);
  }
  if (plan.actif === false) {
    throw erreurAbonnement('Ce plan n’est plus actif.');
  }

  const offre = calculerOffreAbonnement({
    prixMensuel: plan.prix,
    dureeEnMois: duree,
    dateDebut: debut,
  });

  const [commercial] = await db.select()
    .from(saasCommerciaux)
    .where(eq(saasCommerciaux.id, clientSaas.commercialId))
    .limit(1);
  const tauxCommission = commercial ? TAUX_COMMISSION_DEFAUT : 0;
  const commission = commissionSur(offre.montantTotal, tauxCommission);

  const [abonnement] = await db.insert(abonnements).values({
    entrepriseId: idEntreprise,
    planId: idPlan,
    statut: 'actif',
    dateDebut: debut,
    dateExpiration: new Date(offre.dateExpiration),
    prochainRenouvellement: new Date(offre.dateExpiration),
    montantMensuel: plan.prix,
    moisGratuits: offre.moisGratuits,
    dateDebutFacturation: new Date(offre.dateDebutFacturation),
  }).returning();

  // Vente confirmée automatique : le montant et la commission ne sont
  // dus qu’à partir du début de facturation (dateEcheanceCommission),
  // après les mois gratuits.
  const labelGratuit = offre.entierementGratuit
    ? ` (entièrement gratuit — ${offre.moisGratuits} mois offerts)`
    : ` (${offre.moisGratuits} mois gratuits, facturation dès le ${offre.dateDebutFacturation})`;
  await db.insert(saasVentes).values({
    commercialId: clientSaas.commercialId,
    clientId: clientSaas.id,
    abonnementId: abonnement.id,
    montantVente: offre.montantTotal,
    commission,
    statut: 'confirmée',
    source,
    notes: `Vente automatique - Abonnement ${plan.nom} (${duree} mois)${labelGratuit}`,
    dateEcheanceCommission: new Date(offre.dateDebutFacturation),
  });

  await db.update(saasClients)
    .set({ statut: 'actif', updatedAt: new Date() })
    .where(eq(saasClients.id, clientSaas.id));

  return { abonnement, plan, clientSaas, offre, commission };
}
