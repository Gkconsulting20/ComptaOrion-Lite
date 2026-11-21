-- ComptaOrioLite — 21 nov. 2026 — test exercice comptable novembre 2026
-- Correctif bloquant : les colonnes escompte_* manquaient dans les tables live
-- (clients / fournisseurs) alors que schema.js les déclare depuis longtemps :
-- tout SELECT/INSERT sur ces tables retournait HTTP 500, aucune vente ni
-- aucun achat ne pouvait être enregistré.
-- Défauts entreprises alignés : pays Togo (au lieu de Côte d'Ivoire),
-- exercice fiscal 2026 (au lieu de 2025).
-- Appliqué en direct sur la base Neon Lite (Francfort) le 21 nov. 2026.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS escompte_pourcentage numeric(5,2) NOT NULL DEFAULT '0';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS escompte_delai_jours integer NOT NULL DEFAULT 0;
ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS escompte_pourcentage numeric(5,2) NOT NULL DEFAULT '0';
ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS escompte_delai_jours integer NOT NULL DEFAULT 0;
ALTER TABLE entreprises ALTER COLUMN pays SET DEFAULT 'Togo';
ALTER TABLE entreprises ALTER COLUMN debut_annee_fiscale SET DEFAULT '2026-01-01';
ALTER TABLE entreprises ALTER COLUMN fin_annee_fiscale SET DEFAULT '2026-12-31';
