---
name: Indépendance de ComptaOrion Lite
description: Contraintes de séparation avec l’ancien ERP.
---

ComptaOrion Lite doit utiliser une base de données indépendante et de nouveaux secrets. Ne réutiliser ni la base ni les secrets de l’ancien ERP.

**Why:** l’utilisateur l’a explicitement demandé pour la configuration à partir des fichiers importés.

**How to apply:** conserver cette séparation lors de toute configuration, migration ou publication.

Pour le moment, l’application et sa base de test restent sur Replit. Une base PostgreSQL Render est envisagée plus tard, mais ne doit pas être créée avant que l’utilisateur le demande.

**Why:** l’utilisateur l’a précisé le 26 octobre 2026 après avoir choisi de tester d’abord sur Replit.

**How to apply:** vérifier les parcours de test sur la base Replit actuelle; ne pas migrer, créer ou connecter Render prématurément.

Avant une inscription de test, vérifier que le schéma existe dans la base réellement utilisée par le serveur, pas seulement dans l’éditeur ou un ancien historique de configuration.

**Why:** la base de développement du serveur était vide malgré un état antérieur indiquant que le schéma Lite avait été importé.

**How to apply:** contrôler les tables via la connexion active du serveur; appliquer le schéma seulement à une base Lite confirmée vide et laisser les protections de Drizzle contre les changements destructifs activées.
