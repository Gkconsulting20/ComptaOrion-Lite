---
name: IA et configuration de Lite
description: Nouvelle demande IA et accompagnement nécessaire pour les clés de configuration.
---

L’utilisateur demande désormais des agents IA calculant le credit score des clients basé sur les paiements et entrant automatiquement des données. Cette demande remplace la consigne initiale de garder l’IA désactivée.

**Why:** l’utilisateur a explicitement changé le périmètre de Lite.

**How to apply:** conserver ces deux usages; le format photo a été choisi, voir la note dédiée à la saisie photo.

L’utilisateur ne veut pas « replit ia avec open AI » et demande des modèles « flash rapide et open source ».

**Why:** l’utilisateur a explicitement refusé la proposition OpenAI.

**How to apply:** ne pas configurer OpenAI; distinguer Gemini Flash des modèles ouverts et préciser le mode d’hébergement avant d’activer un fournisseur.

Pour les clés de ce logiciel, montrer à l’utilisateur quoi faire au lieu de lui demander des clés qu’il ne connaît pas.

**Why:** l’utilisateur a répété qu’il ne connaît pas les valeurs demandées et préfère des instructions concrètes.

**How to apply:** expliquer la création de nouvelles valeurs et leur enregistrement sécurisé étape par étape; ne pas renvoyer simplement le même formulaire de secrets.

Les réponses Groq en mode JSON seul peuvent échouer avec `json_validate_failed` malgré une consigne JSON correcte.

**Why:** constaté sur une explication réelle des paiements; le schéma de sortie strict a permis de terminer le même parcours.

**How to apply:** garder les schémas stricts pour les résultats structurés, puis contrôler les valeurs métier côté serveur. Ne pas remplacer cette protection par une confiance dans le texte généré.
