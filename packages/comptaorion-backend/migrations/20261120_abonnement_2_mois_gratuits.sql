-- Migration 2026-11-20 — Offre « 2 mois gratuits sur l'abonnement »
-- Décision du fondateur (20 nov. 2026) : chaque nouvel abonnement payant
-- inclut 2 mois gratuits ; la facturation commence au 3e mois.
-- L'essai gratuit reste à 30 jours (aucun changement côté essai).
--
-- Colonnes ajoutées (additives, sans toucher aux données existantes) :
-- - abonnements.mois_gratuits : mois gratuits offerts (2 pour les nouveaux
--   abonnements payants, 0 par défaut pour les lignes déjà en base).
-- - abonnements.date_debut_facturation : début + mois gratuits. NULL pour
--   les lignes déjà en base, traitées comme sans mois gratuit
--   (facturation dès le début) par le code et par le calcul du MRR.
-- - saas_ventes.date_echeance_commission : la commission n'est due que
--   quand le client paie vraiment, donc à partir du début de facturation.
-- Appliquer avec psql (ou `pnpm db:push`, qui régénère ces colonnes
-- depuis src/schema.js) avant de déployer le code qui les utilise.

ALTER TABLE abonnements
  ADD COLUMN IF NOT EXISTS mois_gratuits INTEGER NOT NULL DEFAULT 0;

ALTER TABLE abonnements
  ADD COLUMN IF NOT EXISTS date_debut_facturation DATE;

ALTER TABLE saas_ventes
  ADD COLUMN IF NOT EXISTS date_echeance_commission DATE;

CREATE INDEX IF NOT EXISTS abonnements_facturation_idx
  ON abonnements (date_debut_facturation);
