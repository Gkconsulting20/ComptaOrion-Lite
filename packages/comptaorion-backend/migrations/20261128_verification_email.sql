-- Vérification de l'adresse e-mail par code à 6 chiffres (28 nov. 2026)
-- Design validé par Cap le 27 nov. 2026, miroir de ComptaOrion.
-- Contexte : l'inscription crée le compte mais la connexion est refusée
-- tant que l'e-mail n'est pas vérifié ; l'essai de 30 jours démarre à la
-- vérification (saas_clients.date_inscription est réinitialisée à ce
-- moment-là). Le code est stocké HASHÉ SHA-256 uniquement, un seul code
-- actif par utilisateur, validité 15 minutes.
-- Idempotent : ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS —
-- ré-appliquer est sans effet.
-- À appliquer sur la base Neon live de ComptaOrioLite, puis vérifier la
-- colonne et la table (information_schema) avant le déploiement du Worker.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamp;

CREATE TABLE IF NOT EXISTS email_verification_codes (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  email varchar(255) NOT NULL,
  code_hash varchar(64) NOT NULL,
  statut varchar(20) NOT NULL DEFAULT 'actif',
  tentatives integer NOT NULL DEFAULT 0,
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone,
  invalidated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verification_codes_user_created_idx
  ON email_verification_codes (user_id, created_at);
CREATE INDEX IF NOT EXISTS email_verification_codes_email_created_idx
  ON email_verification_codes (email, created_at);

-- Comptes existants considérés vérifiés : la vérification ne s'applique
-- qu'aux inscriptions créées après ce déploiement. Le compte admin
-- ORIONEXA et celui de Cap (entreprise 1) ne sont jamais bloqués.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
