# ComptaOrion Lite — projet indépendant

Cette copie provient du logiciel existant. Elle n'est reliée ni au serveur ni
à la base de données de l'ERP. L'ERP d'origine n'est pas modifié.

## Inclus
Interface Lite seule, ventes multi-articles, clients/dettes, paiements,
dépenses, stock, reçus WhatsApp, file hors connexion et anti-duplication.
Le serveur réutilise les services métier et le schéma existants pour préserver
les transactions. Le schéma conserve des tables ERP par compatibilité ; ce
n'est pas encore une réduction complète du modèle comptable.
Les interfaces ERP, routes IA, abonnement et administration ne sont pas exposées.
Pas de compte administrateur automatique ni de mot de passe par défaut.

## Import dans un nouveau projet
1. Importer ce ZIP dans un NOUVEAU projet Replit.
2. Créer une NOUVELLE base PostgreSQL vide, dédiée à Lite.
3. Dans les secrets DU NOUVEAU projet, configurer DATABASE_URL vers cette base,
   JWT_SECRET et JWT_REFRESH_SECRET avec de nouvelles valeurs aléatoires.
   Ne jamais réutiliser l'URL de base ou les secrets JWT de l'ERP.
4. Exécuter `npm run install:all`, puis `npm run db:push`.
   Cette commande ne doit viser que la nouvelle base vide ; examiner les
   propositions du moteur de migration et ne jamais forcer une suppression.
5. Exécuter `npm run dev` et créer le premier compte depuis Connexion/Inscription.
6. Pour la production : `npm run build` puis `npm start`.

La route racine ouvre Lite. `/lite` reste compatible.
Les envois WhatsApp sont manuels, via liens de partage ; aucun bot payant.
L'IA n'est pas montée sur ce serveur, même si une clé OpenAI est présente.
Les courriels nécessitent une configuration SendGrid propre au nouveau projet.

## Vérifications avant publication
Valider sur la nouvelle base : inscription, connexion, vente multi-articles,
stock, dette/paiement, dépense, reçu, coupure réseau et reprise sans doublon.
Le build et les tests de code ne remplacent pas ces essais d'intégration.
Seules les ventes et dépenses sont mises en file hors connexion.
Le panier ouvert n'est pas encore sauvegardé après fermeture de l'écran.
