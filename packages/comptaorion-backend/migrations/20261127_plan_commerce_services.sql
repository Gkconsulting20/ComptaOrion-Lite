-- Renommage du plan Lite « Commerce » en « Services » (choix de Cap, 27 nov. 2026).
-- Le plan est un brouillon (actif=false), sans abonnement : le renommage est sans risque.
-- Idempotent : ne touche que la ligne nommée exactement 'Commerce — brouillon'.
-- Contexte : l'endpoint POST /plans/proposals compare les noms et ne met à jour
-- que descriptionFeatures ; sans ce renommage en base, il insérerait un doublon
-- 'Services — brouillon' à côté de l'ancien 'Commerce — brouillon'.
UPDATE plans_abonnement
SET nom = 'Services — brouillon'
WHERE nom = 'Commerce — brouillon';
