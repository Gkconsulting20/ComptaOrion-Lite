-- Migration 2026-11-27 — Aligne les descriptions des plans sur le code déployé
-- (complément de 20261127_fusion_plans_services_equipe.sql, déjà appliquée).
-- Services : l'ancien texte citait le forfait Solo (supprimé par la fusion).
-- Équipe : le texte en base citait encore le forfait Commerce (renommé Services
-- le 27 nov. 2026). C'est exactement la mise à jour que POST /plans/proposals
-- appliquerait lui-même à son prochain appel (comparaison par nom).
-- Appliquée sur la base live le 27 nov. 2026 ; md5(description_features)
-- vérifiés identiques au code après application.

-- Aligne description_features sur le code déployé (7f8e420).
-- Services : l'ancien texte citait le forfait Solo (supprimé).
-- Équipe : le texte en base citait encore le forfait Commerce (renommé Services le 27 nov. 2026).
-- C'est exactement la mise à jour que POST /plans/proposals appliquerait lui-même.
UPDATE plans_abonnement SET description_features = 'FONCTIONNALITÉS INCLUSES
• Pour les prestataires de services : professions libérales, consultants, artisans de service, en petite équipe. Pas de négoce — ni stock, ni achats de marchandises
• Tableau de bord et suivi quotidien de l’activité
• Ventes de prestations multi-lignes, factures, clients et reçus
• Catalogue de prestations et tarifs (sans stock)
• Dépenses, approbations et remboursements des employés
• Caisse et banque : encaissements et décaissements suivis (chèques exclus)
• Gestion de l’activité partagée entre plusieurs utilisateurs (jusqu’à 3)
• Gestion partagée des ventes de prestations, clients et dépenses
• TVA au taux choisi par l’entreprise (0 %, 18 % ou personnalisé)
• État des résultats, bilan financier, clôture d’exercice et impression des rapports
• Analyse de ponctualité des paiements avec score indicatif, jamais décision automatique de crédit
• Saisie différée hors connexion et synchronisation au retour du réseau
• Saisie de facture ou reçu par photo, avec vérification avant enregistrement (Groq et connexion requis)
• Assistance par courriel' WHERE nom = 'Services — brouillon';
UPDATE plans_abonnement SET description_features = 'FONCTIONNALITÉS INCLUSES
• Pour les prestataires de services, en équipe. Pas de négoce — ni stock, ni achats de marchandises
• Toutes les fonctions du forfait Services
• Gestion d’équipe étendue (jusqu’à 10 utilisateurs) et assistance prioritaire
• Gestion partagée des ventes de prestations, clients et dépenses
• TVA au taux choisi par l’entreprise (0 %, 18 % ou personnalisé)
• État des résultats, bilan financier et clôture d’exercice
• Travail hors connexion avec synchronisation au retour du réseau
• Saisie de facture ou reçu par photo, avec vérification avant enregistrement (Groq et connexion requis)
• Assistance prioritaire par courriel' WHERE nom = 'Équipe — brouillon';
