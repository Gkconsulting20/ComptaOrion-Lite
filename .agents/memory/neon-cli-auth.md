---
name: Connexion Neon dans Shell distant
description: Vérifier l'authentification Neon CLI dans un Shell Replit distant.
---

Dans le Shell Replit distant, la réussite apparente de la page OAuth ne garantit pas que le CLI est authentifié : le callback local vers `127.0.0.1` peut expirer. De plus, `neon init -y` peut écrire un lien `.neon` hors ligne sans vérifier le projet référencé. Confirmer le profil CLI et le projet avant toute commande qui lit ou déploie les ressources.

**Why:** l’utilisateur a signalé une connexion terminée, mais `neon profile list` indiquait toujours aucun compte et `neon status` / `neon config plan` ont expiré pendant l’attente d’authentification; `neon init -y` a aussi lié un identifiant de projet inexistant sans validation.

**How to apply:** avant `neon deploy`, vérifier que `neon profile list` affiche un compte authentifié et que le projet/branche existe réellement. En cas d’échec récurrent du callback, ne pas répéter les tentatives aveuglément; utiliser une voie d’identification sécurisée et ne jamais demander de coller une clé dans le chat.
