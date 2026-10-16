---
name: Hébergement Cloudflare
description: Cible d’hébergement, rôle de GitHub et contraintes de validation du serveur.
---

L’utilisateur veut héberger Lite sur Cloudflare, créer le dépôt GitHub puis effectuer lui-même l’envoi vers Cloudflare.

**Why:** demande explicite de l’utilisateur.

**How to apply:** préparer le code et les instructions pour GitHub et Cloudflare; ne pas publier sur Replit ou sur Cloudflare à sa place.

Conserver le serveur Express et PostgreSQL plutôt que convertir les données vers D1 par défaut.

**Why:** préserver le schéma et les transactions de l’application importée; aucun remplacement de base n’a été demandé.

**How to apply:** utiliser la compatibilité Node de Workers et une base Lite indépendante accessible depuis Cloudflare; demander un accord distinct avant toute conversion de moteur.

La réussite du bundling Wrangler ne suffit pas à confirmer la compatibilité Workers.

**Why:** une dépendance Node peut être construite sans erreur mais échouer à l’exécution à cause de sa variante navigateur.

**How to apply:** vérifier aussi le paquet dans le runtime local Workers, dont les routes API et le contexte PostgreSQL à travers Express, avant d’annoncer sa compatibilité.

Le runtime Workers local de cet environnement peut échouer sur les appels HTTPS sortants, alors que les mêmes appels réussissent avec Node, y compris dans un Worker minimal sans Express.

**Why:** cette différence a été constatée avec les appels Groq réels; modifier le code de production pour contourner le sandbox confondrait transport de test et comportement cible.

**How to apply:** distinguer les tests applicatifs avec un relais Node explicite des tests de réseau natif Cloudflare. Ne jamais présenter les premiers comme une validation du réseau du Worker publié.

Le statut sain d’une connexion GitHub de contrôle de source ne garantit pas que `gh` soit authentifié dans le Shell de cet environnement.

**Why:** le statut d’autorisation et les accès effectifs de l’outil GitHub ont divergé; les formulaires de connexion génériques n’acceptaient pas cette connexion de contrôle de source.

**How to apply:** vérifier l’accès effectif avant de promettre une création de dépôt. Si l’accès reste indisponible, guider l’utilisateur dans le panneau Git plutôt que répéter les formulaires ou demander un token dans le chat.
