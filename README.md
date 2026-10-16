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
- Assistant photo Groq : facture d'achat/reçu → brouillon de dépense modifiable →
  confirmation explicite, sans conservation de l'image par Lite.
- Score de paiement calculé sans IA, avec formule et limites visibles; explication
  Groq facultative, sans décision automatique de crédit.
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
| `GROQ_API_KEY` | Clé d'un compte Groq autorisé à utiliser `qwen/qwen3.8-27b` (fonctions IA seulement) |

Pour créer deux nouvelles valeurs, exécuter **vous-même**, dans votre terminal :

```sh
node -e "const c=require('node:crypto'); for(const k of ['JWT_SECRET','JWT_REFRESH_SECRET']) console.log(k+'='+c.randomBytes(48).toString('hex'))"
```

Copier la partie après `=` dans chaque secret Cloudflare correspondant.
Ne pas envoyer les résultats dans le chat et ne pas les enregistrer dans le dépôt.
Ces clés ne sont pas à récupérer dans l'ancien ERP.

Pour Groq, ouvrir **https://console.groq.com → API Keys → Create API Key**.
Enregistrer la nouvelle clé dans les secrets du serveur Replit de développement,
puis séparément dans les secrets chiffrés du Worker Cloudflare. Les secrets Replit
ne sont pas transférés par GitHub. Ne pas préfixer cette clé par `VITE_`.
Sans clé, les fonctions classiques et le score restent disponibles; l'analyse
photo et l'explication affichent une erreur explicite.

Le seul modèle autorisé est **Qwen 3.8 27B** d'Alibaba
(`qwen/qwen3.8-27b`), vérifié dans `/models` du compte configuré avant chaque
appel. Aucun basculement vers un modèle OpenAI. Le chemin compatible
`/openai/v1` appartient à l'API Groq, pas à un service OpenAI.
Licence vérifiée : **Apache 2.0**, [texte du modèle](https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/LICENSE).
[Capacités vision Groq](https://console.groq.com/docs/model/qwen/qwen3.8-27b).
Ce modèle est en préversion chez Groq; sa disponibilité et ses quotas peuvent
changer. La licence du modèle ne rend pas le service Groq gratuit.

### Alternative depuis un ordinateur connecté à votre compte Cloudflare

```sh
pnpm exec wrangler login
pnpm exec wrangler secret put DATABASE_URL
pnpm exec wrangler secret put JWT_SECRET
pnpm exec wrangler secret put JWT_REFRESH_SECRET
pnpm exec wrangler secret put GROQ_API_KEY
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

## 6. Utiliser et vérifier les assistants

### Saisie depuis une photo

Dans **Assistant**, choisir une photo JPEG, PNG ou WebP (4 Mio maximum).
Masquer au préalable les noms, coordonnées, comptes bancaires et autres éléments
inutiles. L'envoi exige un accord explicite; sélectionner une photo seul ne
déclenche aucun appel. Groq reçoit uniquement cette image et les instructions
d'extraction, jamais le carnet clients ni les données de l'entreprise.
La politique de traitement/rétention de Groq reste applicable :
[Your Data](https://console.groq.com/docs/your-data).

Relire et corriger le total TTC, la description, la date, la référence et la
devise. Les valeurs incertaines restent vides. La devise doit correspondre à la
devise comptable de l'entreprise (FCFA/XOF sont équivalents ici); aucune conversion
automatique. Cocher ensuite la confirmation et enregistrer. Le résultat est une
**dépense en attente**, pas une vente, un paiement client ni une facture fournisseur
avec ses lignes. Aucun fichier, brouillon ou octet d'image n'est stocké dans
PostgreSQL, dans la file hors ligne ou dans le stockage du navigateur par Lite.

Les jetons de brouillon expirent après deux heures et sont liés à l'utilisateur
et à l'entreprise. Le hash de l'image donne une clé d'idempotence stable : une
double confirmation ou une nouvelle analyse du même fichier ne crée pas une
deuxième dépense. Cette protection ne reconnaît pas deux photographies différentes
du même papier : vérifier les dépenses existantes avant confirmation.
Si le réseau coupe pendant l'enregistrement, conserver le brouillon et réessayer :
le serveur rejoue le résultat existant. L'assistant ne fonctionne pas hors ligne.

### Score descriptif des paiements

Dans **Clients & dettes → Analyse des paiements par client**, choisir un client,
y compris sans dette restante. L'API lit tout son historique, non les seules
factures visibles sur la première page. Les requêtes filtrent explicitement
l'entreprise pour le client, les factures et les paiements.

Formule : `50 × taux réglé + 30 × part ponctuelle + 20 × (1 − min(retard moyen, 60)/60)`.
Le taux réglé est pondéré par les montants. La ponctualité et le retard moyen sont
calculés par facture échue; le retard d'une facture non soldée court jusqu'au jour
du calcul (dates calendaires UTC). Les brouillons, annulations, factures futures,
non échues, sans échéance ou aux historiques incohérents ne contribuent pas au
score. Les montants réglés doivent être rapprochés des paiements affectés.
Les paiements sans facture ne sont pas attribués arbitrairement.
Sans historique évaluable, aucun score n'est affiché; moins de cinq factures
donne une couverture limitée. Aucun champ de limite de crédit n'est modifié.

**Expliquer avec Groq** est une action séparée : seuls le score, les contributions,
les nombres de factures, la couverture et les retards agrégés sont envoyés, sans
identifiants, noms, coordonnées, dates exactes ni montants. L'explication n'altère
jamais le calcul. Si Groq est indisponible, le score et ses limites restent visibles.

Vérifier sur le Worker configuré : une photo de test sans données réelles,
absence de dépense avant confirmation, correction, confirmation, rechargement,
réessai sans doublon; puis client payé à temps, client partiellement payé/en retard,
client sans historique et refus d'accès depuis une autre entreprise.
Les tests unitaires et le smoke test Workers n'utilisent pas de données clients
réelles et ne remplacent pas ces vérifications avec la base et la clé configurées.

### Contrôle d'intégration local, optionnel

Avec les secrets de **développement Lite** configurés et le bundle construit
par `pnpm run check:cloudflare`, fournir une image PNG synthétique contenant
« Reçu achat, Transport, Total TTC 5000 FCFA, Date 2026-10-16 » :

```sh
node scripts/check-ai-worker.mjs generated-artifacts/recu-test.png
```

Ce contrôle appelle réellement Groq, écrit dans une entreprise de test nouvellement
créée et supprime uniquement ses propres lignes à la fin. Ne pas le lancer sur la
base de l'ancien ERP ni avec une pièce réelle. Il vérifie le score, son explication,
l'isolation, l'extraction, l'absence d'écriture avant accord et les réessais.

Dans cet environnement de travail, les requêtes HTTPS sortantes natives de
`workerd` vers Groq échouent, même pour un Worker minimal sans Express.
Une option **explicite, réservée aux tests** permet de faire passer ces requêtes
par Node, sans simuler les réponses du fournisseur :

```sh
node scripts/check-ai-worker.mjs generated-artifacts/recu-test.png --node-egress
```

Le parcours réel a été vérifié avec ce relais, ainsi que dans l'aperçu navigateur.
Cela valide le comportement applicatif dans le runtime local, **pas le réseau
sortant natif du Worker publié**. Aucune publication n'a été effectuée; vérifier
ce dernier point sur l'environnement Cloudflare autorisé et configuré avant usage
réel. Le relais n'est jamais activé dans le code de l'application.
