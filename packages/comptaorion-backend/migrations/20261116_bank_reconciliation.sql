CREATE TABLE IF NOT EXISTS rapprochement_lignes_bancaires (
  id SERIAL PRIMARY KEY,
  entreprise_id INTEGER NOT NULL REFERENCES entreprises(id),
  rapprochement_id INTEGER NOT NULL REFERENCES rapprochements_bancaires(id) ON DELETE CASCADE,
  transaction_id INTEGER REFERENCES transactions_tresorerie(id),
  numero_ligne INTEGER NOT NULL,
  date_operation DATE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reference VARCHAR(255),
  montant NUMERIC(15, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rapprochement_ligne_no_unique UNIQUE (rapprochement_id, numero_ligne),
  CONSTRAINT rapprochement_transaction_unique UNIQUE (transaction_id)
);

CREATE INDEX IF NOT EXISTS rapprochement_lignes_entreprise_idx
  ON rapprochement_lignes_bancaires (entreprise_id, rapprochement_id);
