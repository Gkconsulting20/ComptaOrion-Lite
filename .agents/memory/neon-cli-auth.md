---
name: Connexion Neon dans Shell distant
description: Vérifier l'authentification Neon CLI dans un Shell Replit distant.
---

Dans le Shell Replit distant, la réussite apparente de la page OAuth ne garantit pas que le CLI est authentifié : le callback local vers `127.0.0.1` peut expirer. De plus, `neon init -y` peut écrire un lien `.neon` hors ligne sans vérifier le projet référencé.

**Why:** l’utilisateur a signalé une connexion terminée, mais `neon profile list` indiquait toujours aucun compte et les commandes de vérification ont expiré pendant l’attente d’authentification. Une URL Neon a ensuite confirmé que l’ID précédemment supposé invalide correspond bien à un projet existant.

**How to apply:** avant `neon deploy`, vérifier que `neon profile list` affiche un compte authentifié et que le projet/branche existe réellement. Traiter un lien écrit hors ligne comme non vérifié, sans déduire que l’ID est faux. En cas d’échec récurrent du callback, ne pas répéter les tentatives aveuglément; utiliser une voie d’identification sécurisée et ne jamais demander de coller une clé dans le chat.
