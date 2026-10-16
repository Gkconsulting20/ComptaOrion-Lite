---
name: Indépendance de ComptaOrion Lite
description: Contraintes de séparation avec l’ancien ERP et maintien de l’IA désactivée.
---

ComptaOrion Lite doit utiliser une base de données indépendante et de nouveaux secrets. Ne réutiliser ni la base ni les secrets de l’ancien ERP. L’IA doit rester désactivée.

**Why:** l’utilisateur l’a explicitement demandé pour la configuration à partir des fichiers importés.

**How to apply:** conserver cette séparation lors de toute configuration, migration ou publication; ne pas activer de routes ou de fournisseurs IA.
