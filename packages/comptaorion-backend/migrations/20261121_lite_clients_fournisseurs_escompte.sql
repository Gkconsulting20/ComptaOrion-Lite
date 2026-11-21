-- ComptaOrioLite — 21 nov. 2026 — test exercice comptable novembre 2026
-- Correctif bloquant : les colonnes escompte_* manquaient dans les tables live
-- (clients / fournisseurs) alors que schema.js les déclare depuis longtemps :
-- tout SELECT/INSERT sur ces tables retournait HTTP 500, aucune vente ni
-- aucun achat ne pouvait être enregistré.
-- Même dérive trouvée ensuite sur les paiements : la colonne escompte_montant
-- manquait dans paiements et paiements_fournisseurs (le règlement d'un achat
-- et le paiement d'une vente échouaient en HTTP 500), et 5 colonnes liées
-- aux chèques manquaient dans paiements.
-- Défauts entreprises alignés : pays Togo (au lieu de Côte d'Ivoire),
-- exercice fiscal 2026 (au lieu de 2025).
-- Appliqué en direct sur la base Neon Lite (Francfort) le 21 nov. 2026.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS escompte_pourcentage numeric(5,2) NOT NULL DEFAULT '0';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS escompte_delai_jours integer NOT NULL DEFAULT 0;
ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS escompte_pourcentage numeric(5,2) NOT NULL DEFAULT '0';
ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS escompte_delai_jours integer NOT NULL DEFAULT 0;
ALTER TABLE paiements ADD COLUMN IF NOT EXISTS escompte_montant numeric(15,2) NOT NULL DEFAULT '0';
ALTER TABLE paiements ADD COLUMN IF NOT EXISTS numero_cheque varchar(100);
ALTER TABLE paiements ADD COLUMN IF NOT EXISTS banque_cheque varchar(255);
ALTER TABLE paiements ADD COLUMN IF NOT EXISTS statut_cheque varchar(30);
ALTER TABLE paiements ADD COLUMN IF NOT EXISTS date_depot_cheque date;
ALTER TABLE paiements ADD COLUMN IF NOT EXISTS compte_bancaire_depot_id integer REFERENCES comptes_bancaires(id);
ALTER TABLE paiements_fournisseurs ADD COLUMN IF NOT EXISTS escompte_montant numeric(15,2) NOT NULL DEFAULT '0';
ALTER TABLE entreprises ALTER COLUMN pays SET DEFAULT 'Togo';
ALTER TABLE entreprises ALTER COLUMN debut_annee_fiscale SET DEFAULT '2026-01-01';
ALTER TABLE entreprises ALTER COLUMN fin_annee_fiscale SET DEFAULT '2026-12-31';
