-- Migration 2026-11-27 — Fusion des plans ComptaOrioLite en 2 plans payants
-- Décision du fondateur Cap (27 nov. 2026, « je suis d'accord avec ta
-- proposition ») : Services 2 500 XOF/mois et Équipe 10 000 XOF/mois.
-- Le plan Solo disparaît ; le Services fusionné est à 2 500 avec la
-- capacité de l'ancien Services (3 utilisateurs, 3 Go).
-- Essai 30 jours, 2 mois offerts et commission 10 % : INCHANGÉS.
--
-- Vérifié avant application : aucun abonnement ne référence plans_abonnement
-- (table abonnements vide au 27 nov. 2026), la suppression de Solo est donc
-- sans risque. Les lignes restent des brouillons (actif = false) : la
-- publication des plans se fait depuis l'Admin SaaS.
--
-- Code associé : POST /plans/proposals ne propose plus que Services et
-- Équipe et compare par nom — il ne réinsère donc pas Solo.

-- 1. Supprimer le plan Solo.
DELETE FROM plans_abonnement WHERE nom = 'Solo — brouillon';

-- 2. Services : 5 000 → 2 500 XOF (3 utilisateurs, 3 Go inchangés).
UPDATE plans_abonnement
   SET prix = '2500'
 WHERE nom = 'Services — brouillon';

-- 3. Équipe : 10 000 XOF, 10 utilisateurs, 10 Go — déjà conformes ;
--    on fige explicitement les valeurs pour rendre la migration idempotente.
UPDATE plans_abonnement
   SET prix = '10000', limite_utilisateurs = 10, stockage_gb = 10
 WHERE nom = 'Équipe — brouillon';

-- Garde-fou : après migration, exactement 2 lignes doivent subsister.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM plans_abonnement;
  IF n <> 2 THEN
    RAISE EXCEPTION 'Fusion des plans : attendu 2 lignes, trouvé %', n;
  END IF;
END $$;
