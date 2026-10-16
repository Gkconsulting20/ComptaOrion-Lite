# ComptaOrion Lite — GitHub et Cloudflare

Application de ventes, stock et dépenses importée, avec interface React/Vite,
API Express et PostgreSQL indépendant. La cible d'hébergement est
**Cloudflare Workers avec Static Assets**, pas un site Cloudflare Pages seul.

## Ce qui est préparé et ce qui ne l'est pas

- Configuration de construction et adaptateur Express pour Workers.
- PostgreSQL conservé : aucune conversion vers D1, aucune réutilisation de l'ancien ERP.
- Les clés et les données ne sont jamais transférées dans GitHub.
- L'inscription, la connexion et les transactions doivent encore être vérifiées
  avec les nouveaux secrets et une base joignable depuis Cloudflare.
- Groq, les agents de saisie et le score de paiement ne sont **pas encore implémentés**.
- Le mode hors connexion existant met les ventes et dépenses en attente ;
  il ne permet pas une nouvelle inscription/connexion sans réseau.
- Les détails de l'import se trouvent dans
  `artifacts/comptaorion-lite/README-import.md`.

## 1. Vérifier le paquet avant publication

Prérequis : Node.js 22 ou ultérieur, pnpm 10.26.1.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @workspace/comptaorion-backend test
pnpm --filter @workspace/comptaorion-lite run typecheck
pnpm run check:cloudflare
pnpm run check:cloudflare:runtime
```

`check:cloudflare` construit l'interface et prépare le Worker **sans le publier**.
Il ne valide pas une connexion à la base ni les fonctions métier.
`check:cloudflare:runtime` vérifie ensuite le serveur Workers local, avec des
valeurs de test publiques et sans connexion à une vraie base : accès à
l'interface, blocage sans configuration, santé API et protection des routes.

## 2. Mettre le code sur GitHub

Utiliser de préférence un dépôt **privé** nommé `comptaorion-lite`.
Ne jamais ajouter `.env`, `.dev.vars`, une sauvegarde SQL, une clé ou une archive
contenant des secrets. Aucun secret n'est nécessaire aux contrôles GitHub Actions.

## 3. Préparer PostgreSQL

Cloudflare doit pouvoir joindre une base PostgreSQL dédiée à Lite par une
connexion sécurisée. La base de développement n'est pas transférée
automatiquement lors d'un envoi sur GitHub.

- Conserver la base indépendante existante si son fournisseur autorise
  l'accès externe, ou configurer une nouvelle base Lite dédiée.
- Ne jamais saisir l'adresse ou les identifiants de la base de l'ancien ERP.
- Pour initialiser une **nouvelle base vide**, exécuter depuis un environnement
  local configuré avec son `DATABASE_URL` :

  ```sh
  pnpm --filter @workspace/comptaorion-backend run db:push
  ```

  Examiner les changements proposés ; ne pas utiliser `--force` sur une base
  contenant des données. Le déploiement du Worker ne modifie pas le schéma.

## 4. Créer le projet Cloudflare à partir de GitHub

Dans Cloudflare, ouvrir **Workers & Pages → Create → Import a repository**
(les libellés peuvent varier), puis :

1. Connecter GitHub et sélectionner le dépôt privé.
2. Choisir un projet **Worker**, avec la racine du dépôt comme répertoire.
3. Utiliser la commande de déploiement `pnpm run deploy:cloudflare`.
   La construction est définie dans `wrangler.toml`; si une commande de
   construction supplémentaire est facultative, la laisser vide pour
   éviter de construire deux fois.
4. Choisir la branche principale du dépôt.
5. Ajouter les secrets ci-dessous dans les paramètres du Worker, puis
   redéployer. Sans eux, l'interface peut s'afficher mais l'API répondra 503
   avec `configuration_required`, sans exposer de valeur secrète.

### Secrets à créer dans Cloudflare, pas dans GitHub

| Nom | Ce qu'il faut mettre |
| --- | --- |
| `DATABASE_URL` | URL de connexion PostgreSQL de la base Lite dédiée |
| `JWT_SECRET` | Nouvelle chaîne aléatoire, au moins 32 caractères |
| `JWT_REFRESH_SECRET` | Autre nouvelle chaîne aléatoire, différente de la précédente |

Pour créer deux nouvelles valeurs, exécuter **vous-même**, dans votre terminal :

```sh
node -e "const c=require('node:crypto'); for(const k of ['JWT_SECRET','JWT_REFRESH_SECRET']) console.log(k+'='+c.randomBytes(48).toString('hex'))"
```

Copier la partie après `=` dans chaque secret Cloudflare correspondant.
Ne pas envoyer les résultats dans le chat et ne pas les enregistrer dans le dépôt.
Ces clés ne sont pas à récupérer dans l'ancien ERP.

`GROQ_API_KEY` sera ajouté au moment de l'intégration Groq ; il n'est pas
nécessaire pour cette version sans agent IA.

### Alternative depuis un ordinateur connecté à votre compte Cloudflare

```sh
pnpm exec wrangler login
pnpm exec wrangler secret put DATABASE_URL
pnpm exec wrangler secret put JWT_SECRET
pnpm exec wrangler secret put JWT_REFRESH_SECRET
pnpm run deploy:cloudflare
```

Les commandes `secret put` demandent les valeurs de façon interactive.
Ne pas exécuter de publication avant d'avoir choisi le bon compte Cloudflare.

## 5. Vérifier après publication

Sur **l'URL réellement fournie par Cloudflare** :

1. Ouvrir `/api/healthz` : attendu HTTP 200 après configuration.
   Ce contrôle confirme le démarrage, pas le fonctionnement de PostgreSQL.
2. Créer un compte de test, se déconnecter puis se reconnecter.
3. Créer deux produits avec du stock ; enregistrer une vente contenant les deux.
4. Vérifier les deux diminutions de stock et le paiement enregistré.
5. Enregistrer une dépense et vérifier qu'elle reste après rechargement.
6. Après une première connexion en ligne, passer hors connexion, enregistrer
   une vente et une dépense, puis rétablir le réseau. Vérifier la disparition
   de l'attente, l'absence de doublons et la mise à jour du stock.

Ne pas considérer l'application prête pour des données réelles avant ces essais.
