---
name: Connexion Neon dans Shell distant
description: Vérifier l'authentification Neon CLI dans un Shell Replit distant.
---

Dans le Shell Replit distant, la réussite apparente de la page OAuth ne garantit pas que le CLI est authentifié : le callback local vers `127.0.0.1` peut expirer. Confirmer le profil CLI avant toute commande qui lit ou déploie les ressources.

**Why:** l’utilisateur a signalé une connexion terminée, mais `neon profile list` indiquait toujours aucun compte et `neon status` / `neon config plan` ont expiré pendant l’attente d’authentification.

**How to apply:** avant `neon deploy`, vérifier que `neon profile list` affiche un compte authentifié. En cas d’échec récurrent du callback, ne pas répéter les tentatives aveuglément; utiliser une voie d’identification sécurisée et ne jamais demander de coller une clé dans le chat.
