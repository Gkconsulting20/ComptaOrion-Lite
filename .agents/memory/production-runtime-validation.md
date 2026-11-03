---
name: Vérifications de production
description: Vérifier les vrais parcours avec la base et l’interface, pas seulement le démarrage du service.
---

Une vérification de production doit inclure des parcours authentifiés qui lisent et écrivent des données, puis confirmer que le résultat apparaît dans l’interface après synchronisation ou rechargement. Une réponse de santé du serveur ne suffit pas.

**Why:** le point de santé peut répondre correctement sans interroger PostgreSQL; les problèmes de connexion, d’idempotence ou de rafraîchissement ne se voient qu’en exécutant les opérations métier.

**How to apply:** pour ComptaOrion Lite sur Cloudflare, utiliser un compte et des données explicitement marqués TEST, vérifier l’inscription, la connexion, les transactions, le stock, les états financiers et la synchronisation hors connexion, puis comparer les réponses serveur à l’affichage.
