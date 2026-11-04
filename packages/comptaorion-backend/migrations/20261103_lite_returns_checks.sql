ALTER TABLE paiements
  ADD COLUMN IF NOT EXISTS escompte_montant NUMERIC(15, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS numero_cheque VARCHAR(100),
  ADD COLUMN IF NOT EXISTS banque_cheque VARCHAR(255),
  ADD COLUMN IF NOT EXISTS statut_cheque VARCHAR(30),
  ADD COLUMN IF NOT EXISTS date_depot_cheque DATE,
  ADD COLUMN IF NOT EXISTS compte_bancaire_depot_id INTEGER
    REFERENCES comptes_bancaires(id);

ALTER TABLE paiements_fournisseurs
  ADD COLUMN IF NOT EXISTS escompte_montant NUMERIC(15, 2) NOT NULL DEFAULT 0;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS escompte_pourcentage NUMERIC(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escompte_delai_jours INTEGER NOT NULL DEFAULT 0;

ALTER TABLE fournisseurs
  ADD COLUMN IF NOT EXISTS escompte_pourcentage NUMERIC(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escompte_delai_jours INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS retours_marchandises (
  id SERIAL PRIMARY KEY,
  entreprise_id INTEGER NOT NULL REFERENCES entreprises(id),
  type VARCHAR(20) NOT NULL,
  numero VARCHAR(100) NOT NULL,
  facture_id INTEGER REFERENCES factures(id),
  facture_achat_id INTEGER REFERENCES factures_achat(id),
  client_id INTEGER REFERENCES clients(id),
  fournisseur_id INTEGER REFERENCES fournisseurs(id),
  date_retour DATE NOT NULL,
  total_ht NUMERIC(15, 2) NOT NULL,
  total_tva NUMERIC(15, 2) NOT NULL,
  total_ttc NUMERIC(15, 2) NOT NULL,
  notes TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS retours_marchandises_client_idx
  ON retours_marchandises (entreprise_id, client_id, date_retour);
CREATE INDEX IF NOT EXISTS retours_marchandises_fournisseur_idx
  ON retours_marchandises (entreprise_id, fournisseur_id, date_retour);
CREATE UNIQUE INDEX IF NOT EXISTS retours_marchandises_numero_idx
  ON retours_marchandises (entreprise_id, numero);

CREATE TABLE IF NOT EXISTS retours_marchandises_items (
  id SERIAL PRIMARY KEY,
  entreprise_id INTEGER NOT NULL REFERENCES entreprises(id),
  retour_id INTEGER NOT NULL REFERENCES retours_marchandises(id),
  facture_item_id INTEGER REFERENCES facture_items(id),
  facture_achat_item_id INTEGER REFERENCES facture_achat_items(id),
  produit_id INTEGER REFERENCES produits(id),
  description TEXT NOT NULL,
  quantite NUMERIC(15, 3) NOT NULL,
  prix_unitaire NUMERIC(15, 2) NOT NULL,
  remise NUMERIC(5, 2) NOT NULL DEFAULT 0,
  total_ligne NUMERIC(15, 2) NOT NULL,
  reintegrer_stock BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS retours_marchandises_items_retour_idx
  ON retours_marchandises_items (entreprise_id, retour_id);

CREATE TABLE IF NOT EXISTS ajustements_tiers (
  id SERIAL PRIMARY KEY,
  entreprise_id INTEGER NOT NULL REFERENCES entreprises(id),
  type VARCHAR(30) NOT NULL,
  numero VARCHAR(100) NOT NULL,
  facture_id INTEGER REFERENCES factures(id),
  facture_achat_id INTEGER REFERENCES factures_achat(id),
  client_id INTEGER REFERENCES clients(id),
  fournisseur_id INTEGER REFERENCES fournisseurs(id),
  date_note DATE NOT NULL,
  total_ht NUMERIC(15, 2) NOT NULL,
  total_tva NUMERIC(15, 2) NOT NULL,
  total_ttc NUMERIC(15, 2) NOT NULL,
  compte_ajustement_id INTEGER NOT NULL REFERENCES comptes_comptables(id),
  motif TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ajustements_tiers_numero_idx
  ON ajustements_tiers (entreprise_id, numero);
CREATE INDEX IF NOT EXISTS ajustements_tiers_client_idx
  ON ajustements_tiers (entreprise_id, client_id, date_note);
CREATE INDEX IF NOT EXISTS ajustements_tiers_fournisseur_idx
  ON ajustements_tiers (entreprise_id, fournisseur_id, date_note);
