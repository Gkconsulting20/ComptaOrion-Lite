---
name: Indépendance de ComptaOrion Lite
description: Contraintes de séparation avec l’ancien ERP.
---

ComptaOrion Lite doit utiliser une base de données indépendante et de nouveaux secrets. Ne réutiliser ni la base ni les secrets de l’ancien ERP.

**Why:** l’utilisateur l’a explicitement demandé pour la configuration à partir des fichiers importés.

**How to apply:** conserver cette séparation lors de toute configuration, migration ou publication.

La base principale de Lite est désormais sur Neon. L’utilisateur a précisé que les clients n’ont pas encore commencé les essais et que le logiciel est encore en correction.

**Why:** après avoir envisagé Render et une branche de test séparée, l’utilisateur a demandé d’appliquer la migration du rapprochement sur la base principale.

**How to apply:** vérifier la connexion active plutôt que supposer une base Replit. Cette autorisation portait sur la migration du rapprochement, pas sur toutes les futures migrations. Ne pas créer ou connecter Render sans nouvelle demande.

Avant une inscription de test, vérifier que le schéma existe dans la base réellement utilisée par le serveur, pas seulement dans l’éditeur ou un ancien historique de configuration.

**Why:** la base de développement du serveur était vide malgré un état antérieur indiquant que le schéma Lite avait été importé.

**How to apply:** contrôler les tables via la connexion active du serveur; appliquer le schéma seulement à une base Lite confirmée vide et laisser les protections de Drizzle contre les changements destructifs activées.
