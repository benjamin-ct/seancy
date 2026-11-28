# Seancy 🎬

[![CI](https://github.com/benjamin-ct/seancy/actions/workflows/ci.yml/badge.svg)](https://github.com/benjamin-ct/seancy/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)

> En ligne sur **https://seancy.com** (previews de PR sur `<slug>.dev.seancy.com`).

Application pour découvrir des films et séries, savoir où les regarder en streaming (France), tirer un titre au hasard, et suivre ce que tu as déjà vu.

Les données (catalogue, affiches, plateformes de streaming) viennent de [TMDB](https://www.themoviedb.org/) (The Movie Database), qui agrège aussi les disponibilités JustWatch.

## Sommaire

- [Stack technique](#stack-technique)
- [Structure du projet](#structure-du-projet)
- [Lancer le projet en local](#lancer-le-projet-en-local)
- [Convention de fetch API](#convention-de-fetch-api)
- [Style et CSS](#style-et-css)
- [Comptes et synchronisation (optionnel)](#comptes-et-synchronisation-optionnel)
- [Notifications push (optionnel)](#notifications-push-optionnel)
- [Déploiement (Cloudflare Workers)](#déploiement-cloudflare-workers)
- [Observabilité](#observabilité)
- [Espace admin (admin.seancy.com)](#espace-admin-adminseancycom)
- [Tickets (Claude)](#tickets-claude)
- [Sécurité](#sécurité)
- [Hooks Git locaux (Husky)](#hooks-git-locaux-husky)
- [Fonctionnalités en stub](#fonctionnalités-en-stub)
- [Fonctionnalités](#fonctionnalités)
- [Licence](#licence)

## Stack technique

- **React 19** + **TypeScript** (`strict: true` partout, quasiment aucun `any` — voir plus bas) + **React Router 7**
- **Vite 8** (build) + **vite-plugin-pwa** (PWA installable, service worker custom en TypeScript)
- **CSS Modules** maison, aucune dépendance de style (pas de Tailwind/styled-components) — voir [Style et CSS](#style-et-css)
- **Cloudflare Workers** (`worker/`, TypeScript) pour l'API, le proxy TMDB, l'authentification et les notifications push, avec **D1** (SQLite à l'edge) pour la persistance
- **oxlint** (lint, y compris TypeScript) + **Prettier** (format) + **Husky/lint-staged** (hooks Git locaux)
- Node **24** (LTS), voir `.nvmrc`

## Structure du projet

Un module par domaine métier, un sous-module par page, un module séparé pour les composants transverses. Un module métier n'importe jamais les internals d'un autre module métier — seuls `core/` et `shared/` sont importables par tous.

```
src/
  core/                     # fondations, importables par tout le projet
    api/                    # client TMDB (tmdb.ts, tmdbClient.ts) + logique pure
    context/                # contexts React (Auth, Library, Region, Theme, ...)
    lib/                    # utilitaires transverses (reCAPTCHA...)
    types/                  # types partagés (tmdb.ts, library.ts)
  shared/
    components/             # composants réutilisables (MediaCard, NavBar, FilterBar, ...)
    lib/                    # utilitaires UI (couleurs d'affiche de repli, paliers de note...)
    styles/                 # CSS Modules partagés (grille média, clés d'affiche duotone...)
  modules/
    discover/                     # page "Découvrir"
    new-releases/                  # page "Nouveautés"
    coming-soon/                   # page "Prochainement" (calendrier)
    random/                        # page "Aléatoire"
    detail/
      DetailPage.tsx
      components/                  # EpisodeTracker, CollectionSection (spécifiques à Detail)
    person/
    my-list/
      MyListPage.tsx                # onglets Déjà vu / Envie de voir / En cours / listes perso
      components/                   # StatsPanel, WatchlistPanel, CustomListPanel
    profile/                       # compte, notifications, préférences de recommandation
    search/
    auth/                          # connexion (lien magique), vérification
  styles/                  # reset global + tokens de design (variables.css)
  App.tsx, main.tsx, sw.ts
worker/                    # Cloudflare Worker (API, auth, notifications, proxy TMDB)
scripts/                   # génération d'icônes PWA + vérifications de logique pure
```

Chaque composant vit dans son propre dossier avec son `*.module.css` (ex. `shared/components/MediaCard/{MediaCard.tsx,MediaCard.module.css}`). Les tokens de design (couleurs OKLCH, typographies, rayons, ombres) sont centralisés dans `src/styles/variables.css` ; le reste n'y touche que via `var(--...)`.

## Lancer le projet en local

1. Crée un compte gratuit sur [themoviedb.org](https://www.themoviedb.org/) puis récupère ta clé API (v3) dans **Réglages → API**.
2. Ouvre `.env.local` à la racine du projet et renseigne :

   ```
   VITE_TMDB_API_KEY=ta_cle_ici
   ```

   Cette variable ne sert qu'en **développement local** (`npm run dev`, Vite seul sans Worker) : elle permet d'appeler TMDB directement depuis le navigateur pour itérer vite. Elle ne quitte jamais ta machine. **En production, c'est `TMDB_API_KEY`** (secret du Worker, voir plus bas) qui est utilisée — le navigateur ne voit jamais la clé (toutes les requêtes TMDB passent par un proxy `/api/tmdb/...` côté Worker).

3. Installe les dépendances puis lance le serveur de dev :

   ```bash
   npm install
   npm run dev
   ```

4. Ouvre l'URL affichée (généralement http://localhost:5173).

### Scripts disponibles

| Commande                          | Rôle                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| `npm run dev`                     | Serveur de dev Vite                                                 |
| `npm run build`                   | Build de production (`dist/`)                                       |
| `npm run typecheck`               | `tsc -b --noEmit` sur les 4 tsconfig du projet (app/node/worker/sw) |
| `npm run lint`                    | oxlint (TypeScript + React)                                         |
| `npm run format` / `format:check` | Prettier                                                            |
| `npm run verify:*`                | Vérifications de logique pure (voir `scripts/`)                     |

## Convention de fetch API

Un point d'entrée unique : `src/core/api/tmdb.ts` (réexporte `tmdbClient.ts` pour la config/le fetch central, et les modules de logique pure `movieMeta.ts`/`releaseBadge.ts`/`concurrencyLimiter.ts`, testables sous Node sans dépendance à `import.meta.env`). Tous les modules métier importent depuis ce fichier — jamais de `fetch()` TMDB ailleurs. Les types de réponse partagés vivent dans `src/core/types/tmdb.ts` (et `library.ts` pour la bibliothèque personnelle) plutôt que redéfinis composant par composant.

Gestion des erreurs/chargement uniforme : chaque page suit le même pattern `status: "idle" | "loading" | "success" | "error"` et affiche `<Loading />` / `<ErrorMessage />` / `<EmptyState />` (voir `shared/components/StateMessage`).

## Style et CSS

Système maison en CSS Modules : un `*.module.css` par composant, référencant les tokens définis une seule fois dans `src/styles/variables.css` (palette OKLCH claire/sombre, typographies, rayons, ombres). `src/styles/global.css` ne contient que le reset et une poignée d'utilitaires vraiment transverses (`.container`, `.perfStrip`, `.visuallyHidden`) — c'est la seule feuille de style non modulaire du projet, chargée une fois dans `main.tsx`.

## Comptes et synchronisation (optionnel)

Se connecter (page **Connexion**) permet de retrouver sa liste "envie de voir" / "déjà vu" sur plusieurs navigateurs et appareils. Pas de mot de passe : un lien de connexion à usage unique est envoyé par email (valable 15 minutes), avec aussi un **code court** en alternative (ex. `AB2K9X`) à taper directement dans l'app — pensé pour les apps ajoutées à l'écran d'accueil (iOS surtout), où le lien s'ouvrirait dans le navigateur au lieu de l'app installée.

### Connexion avec Google / Apple (optionnel)

En plus du lien magique (toujours disponible), on peut se connecter avec Google ou Apple, et associer/dissocier ces comptes depuis **Profil → Compte → Moyens de connexion** (`worker/oauth.ts`, migration `0017`). Chaque bouton n'apparaît que si tous les secrets de son fournisseur sont définis (tous en **Secret**, même les identifiants publics, pour survivre aux déploiements). URL de retour à déclarer chez le fournisseur : `https://seancy.com/api/auth/oauth/callback/<google|apple>` (une par domaine ; les previews ne l'ont pas, d'où des boutons absents sans secrets dans **Previews Base**).

- **Google** : Google Cloud Console → _APIs & Services → Credentials_ → _OAuth client ID_ de type **Web application**, avec l'URL de retour ci-dessus → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Écran de consentement : scopes `openid` et `email` seulement.
- **Apple** (compte Apple Developer payant) : un _App ID_ avec « Sign in with Apple », un _Services ID_ (= `APPLE_CLIENT_ID`) avec le domaine `seancy.com` et l'URL de retour, une _Key_ « Sign in with Apple » (`.p8` → `APPLE_PRIVATE_KEY`, son identifiant → `APPLE_KEY_ID`), et le _Team ID_ du compte → `APPLE_TEAM_ID`.

Une connexion Google / Apple ouvre le compte qui a déjà associé ce compte, sinon celui de même email vérifié (créé au besoin). Sur iPhone, depuis l'app installée sur l'écran d'accueil, la page du fournisseur peut s'ouvrir dans Safari : la session est alors ouverte dans Safari, pas dans l'app (même limite que le lien email ; le code par email reste la solution).

## Notifications push (optionnel)

Le Worker gère les notifications push (nouveautés en streaming, sorties dans tes genres préférés, grosses tendances) via une tâche planifiée quotidienne et une base D1. Activées depuis **Profil** (bouton "Activer les notifications").

## Déploiement (Cloudflare Workers)

Le projet est configuré pour être déployé sur Cloudflare via `wrangler.jsonc` (assets statiques + Worker `worker/index.ts`, bundlé nativement en TypeScript par Wrangler — aucune étape de build séparée pour le Worker). En connectant le repo GitHub dans le dashboard Cloudflare (**Workers & Pages → Create → Connect to Git**), chaque push sur `main` déclenche automatiquement :

| Étape       | Commande              |
| ----------- | --------------------- |
| Build       | `npm run build`       |
| Déploiement | `npx wrangler deploy` |

En parallèle, le job `apply-d1-migrations` de la CI GitHub Actions (`.github/workflows/ci.yml`, déclenché lui aussi sur push `main`) applique automatiquement à la base distante toute migration D1 pas encore jouée (voir `migrations/`) via `npx wrangler d1 migrations apply seancy-notifications --remote`. Aucune migration ne doit jamais être lancée à la main : ajouter un fichier dans `migrations/` (`npx wrangler d1 migrations create seancy-notifications <nom>`) suffit, la CI se charge de l'appliquer au prochain merge sur `main`.

**Avant le premier déploiement**, configure dans le dashboard Cloudflare (Worker `seancy` → **Settings → Variables and Secrets**, type **Secret** obligatoire — voir l'avertissement dans `wrangler.jsonc`). Un Worker qui n'a encore jamais été déployé a ses réglages grisés (« Aucune version ou aucun déploiement n'est associé à ce Worker ») : la CI lui en donne une automatiquement (étape « Bootstrap Worker seancy » du job de preview, `scripts/seancy-bootstrap-worker.ts` : réponse 503 fixe, sans URL workers.dev, domaine ni tâche planifiée), que le premier vrai déploiement remplacera en gardant les secrets. Le bouton **Edit code › Deploy** du dashboard reste grisé dans ce cas. Les previews ne reprennent rien de la prod : leurs variables et secrets se règlent à part, dans l'onglet **Previews Base** de ces mêmes réglages.

| Nom                                                                        | Obligatoire        | Rôle                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TMDB_API_KEY`                                                             | ✅                 | Proxy TMDB + tâche planifiée                                                                                                                                                                                                                                                                       |
| `VAPID_PRIVATE_KEY`                                                        | Notifications push | `node -e "console.log(require('web-push').generateVAPIDKeys())"`                                                                                                                                                                                                                                   |
| `DEBUG_TRIGGER_KEY`                                                        | optionnel          | À inventer toi-même (chaîne aléatoire, pas une clé fournie par un service externe) : sert de mot de passe partagé pour `/api/run-check`, `/api/test-notification`, `/api/test-error`, `/api/sync-search-index` — colle ensuite la même valeur dans le header `x-debug-key` de tes requêtes de test |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL`                                     | Comptes            | Envoi des liens de connexion par email (sans elle : le lien est renvoyé dans la réponse API, pour tester sans boîte mail)                                                                                                                                                                          |
| `RECAPTCHA_SECRET_KEY`                                                     | optionnel          | Anti-bot sur l'authentification                                                                                                                                                                                                                                                                    |
| `SENTRY_DSN`                                                               | optionnel          | Suivi des erreurs (client + Worker), voir section Observabilité ci-dessous                                                                                                                                                                                                                         |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                                | optionnel          | Bouton « Continuer avec Google », voir « Connexion avec Google / Apple » ci-dessus                                                                                                                                                                                                                 |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | optionnel          | Bouton « Continuer avec Apple », idem                                                                                                                                                                                                                                                              |

### Régénérer la paire VAPID

À faire seulement si la clé privée d'origine est perdue. Conséquence : toutes les souscriptions push existantes deviennent invalides, les utilisateurs devront réactiver les notifications (une fois).

1. Sur ta machine : `npm run vapid:generate` (la clé privée n'est affichée que dans ton terminal).
2. Remplace `VAPID_PUBLIC_KEY` dans `wrangler.jsonc` par la nouvelle clé publique (non sensible, à commiter) et déploie.
3. Dans le dashboard Cloudflare (Worker `seancy` → Settings → Variables and Secrets), remplace le secret `VAPID_PRIVATE_KEY` par la nouvelle clé privée (43 caractères, sans espace ni retour à la ligne). Fais l'étape 2 et celle-ci dans la foulée : les deux clés vont ensemble.
4. Envoie une notification de test (`/api/test-notification`, voir `DEBUG_TRIGGER_KEY`) après avoir réactivé les notifications sur ton propre compte.

Pour tester la configuration localement sans rien déployer : `npm run build && npx wrangler deploy --dry-run`.

Pour du développement local avec un Worker complet (D1 + secrets) : crée un `.dev.vars` (jamais commité), puis
`npx wrangler d1 migrations apply seancy-notifications --local && npx wrangler dev`. Pour avoir un compte déjà
connecté plutôt qu'une base vide, rejoue aussi le seed de démo utilisé par les previews de PR (voir
`scripts/fixtures/preview-seed.sql`) : `npx wrangler d1 execute seancy-notifications --local --file scripts/fixtures/preview-seed.sql`,
puis pose le cookie `seancy_session=seancy-preview-demo` (voir le commentaire en tête du fichier).

### Environnement `develop` (persistant)

En plus de la prod (`main`) et des previews éphémères par PR (une base D1 chacune, détruite à la fermeture), un environnement persistant `develop` sert de bac à sable d'équipe : une base D1 unique **`seancy-develop`** (créée une fois, jamais supprimée) peuplée d'un jeu de données fictives "full" — trois comptes de démo avec bibliothèque, listes perso, partage de profil et abonnement entre eux (voir `scripts/fixtures/develop-seed.sql`).

Déployé par le job `deploy-develop` de la CI (`.github/workflows/ci.yml`) à chaque push sur la branche `develop`, via un vrai `wrangler deploy` (ticket Trello "Rendre develop iso-prod") vers un Worker dédié **`seancy-develop`** — pas l'intégration Git Cloudflare Workers Builds, réservée à la vraie prod sur `main`, mais un déploiement réel avec les mêmes bindings natifs que la prod (`ai`, `ratelimits`, Durable Objects), contrairement à l'ancien mécanisme `wrangler preview --name develop` (même limite qu'une preview de PR). Le seed est rejoué de façon additive (`INSERT OR IGNORE`) à chaque push : les données de test modifiées à la main entre deux déploiements ne sont jamais écrasées, seules les nouvelles lignes de fixtures (suivant les migrations ajoutées) s'insèrent. Pour repartir d'une base vide : onglet **Actions** → workflow **Reset develop database** → **Run workflow** (`reset-develop-db.yml`, déclenché à la main uniquement, jamais automatique).

**Étape manuelle unique à faire une fois** (hors CI, pas automatisable avec le token disponible) : configurer les secrets réels (`TMDB_API_KEY`, `VAPID_PRIVATE_KEY`, `RECAPTCHA_SECRET_KEY`...) sur le nouveau Worker `seancy-develop` (dashboard Cloudflare → Workers & Pages → seancy-develop → Settings → Variables and Secrets) — ils ne sont jamais hérités de la prod ni poussés par la CI. Tant que ce n'est pas fait, les fonctionnalités qui en dépendent restent en repli sur `develop`.

**Étape manuelle unique** (pas encore faite, une seule fois nécessaire) : créer et pousser la branche `develop` depuis `main` (`git branch develop main && git push origin develop`) — c'est ce push initial qui déclenche la première exécution de `deploy-develop` et crée `seancy-develop`.

Budget D1 (plan gratuit, 10 bases au total) : prod + `seancy-develop` comptent en permanence, donc au plus 8 previews de PR simultanées sur le reste du quota (voir `scripts/preview-d1.ts`).

Tant que les branches `feature/*` ciblent encore `main` (le pipeline Trello → Claude n'a pas encore été adapté au git flow `main`/`develop`/`feature`/`hotfix` décidé sur le ticket Trello "Avenir du développement"), cet environnement reste à jour uniquement via des merges manuels dans `develop`.

## Observabilité

- **Erreurs** (client + Worker) : [Sentry](https://sentry.io), via le secret Cloudflare `SENTRY_DSN` ci-dessus. Le
  client le récupère à l'exécution via `GET /api/sentry-dsn` (voir `src/core/logger.ts`) plutôt que par une variable
  Vite au build — pas de redéploiement du front nécessaire pour l'activer/désactiver. Tant que `SENTRY_DSN` n'est pas
  configuré, tout reste no-op (dev local). L'alerte Discord n'est pas automatique avec la seule intégration Sentry :
  il faut créer une règle dédiée (Sentry → **Alerts** → **Create Alert Rule** → **When** `A new issue is created` →
  action `Send a Discord notification`) — pas le déclencheur par défaut basé sur une fréquence (« plus de N
  événements en 5 minutes »), qui ne se déclenche jamais sur une erreur isolée. Chaque projet Sentry crée aussi une
  règle par défaut (« Send a notification for new issues ») qui envoie un e-mail : à supprimer une fois la règle
  Discord en place, pour ne garder que Discord.
- **Usage** (recherche, activation des notifications, changements de bibliothèque) : Cloudflare **Analytics Engine**
  (binding `ANALYTICS`, voir `wrangler.jsonc` et `worker/analytics.ts`) — aucune configuration supplémentaire, actif
  dès le déploiement.
- **Logs & traces natifs Workers** : activés via `wrangler.jsonc` (bloc `observability`, voir le schéma
  `node_modules/wrangler/config-schema.json`) plutôt que depuis le dashboard seul — le dashboard affiche justement un
  avertissement tant que ces réglages ne sont pas mirrorés dans le fichier commité, sinon ils seraient écrasés au
  prochain déploiement (même mécanisme que `vars`). Consultables dans le dashboard Cloudflare, Worker `seancy` →
  onglet **Observability**.
- **Fréquentation** (pages vues, visiteurs) : Cloudflare **Web Analytics**. À activer une fois depuis le dashboard
  Cloudflare (**Analytics & Logs → Web Analytics → Add site**), puis reporter le token obtenu dans
  `CLOUDFLARE_ANALYTICS_TOKEN` (`wrangler.jsonc`, `vars`, pas un secret — ce token est fait pour être public). Le
  client charge le beacon dynamiquement via `GET /api/web-analytics-token` (voir `src/core/webAnalytics.ts`) ; tant
  que le token est vide, rien n'est chargé.
- **Disponibilité** : `GET /api/health` (vérifie que D1 répond), pingé toutes les 5 minutes par
  `.github/workflows/healthcheck.yml`, qui alerte sur `DISCORD_WEBHOOK_URL` (secret GitHub Actions) uniquement au
  moment d'une transition d'état (passage down, puis retour up) — pas à chaque exécution.
- **Dashboard unique** : [Grafana Cloud](https://grafana.com) (gratuit), avec les datasources Sentry et Cloudflare
  Analytics branchées sur un board réunissant les trois sections ci-dessus — configuration faite une fois depuis
  l'interface Grafana, en dehors de ce repo.

## Espace admin (admin.seancy.com)

Tout ce qui est réservé aux administrateurs est regroupé sur **`admin.seancy.com`** : même base que le site, sa propre
mise en page (`src/modules/admin/`) et son propre domaine, jamais indexé.

**Worker à part, mis en ligne à chaque fusion dans `develop`** (`wrangler.admin.jsonc`, job `deploy-admin` de la CI,
`worker/admin-split.ts`) : les retouches de l'admin n'attendent plus une release du site. Même code que le site, le
Worker `seancy-admin` sert `admin.seancy.com` et traite lui-même l'API de l'admin et celle des tickets ; tout le reste
(connexion, outils qui lancent les traitements du site, clé publique des notifications) est renvoyé au Worker du site
par service binding, qui garde les secrets du site. Ce qui demande un secret du site passe par une adresse interne
(`seancy.internal`, jamais joignable d'Internet) : notifications aux administrateurs, état des réglages du site. Le site,
lui, renvoie au Worker admin l'API de l'admin et des tickets reçue sur ses adresses de production : le NAS, les
workflows et les scripts gardent leurs adresses. Les previews de PR et `develop` gardent leur propre admin, sur leur
base. **Migrations** : appliquées à la base de production dès la fusion dans `develop` (job `deploy-admin`) ; une
migration ne fait donc qu'ajouter (tables, colonnes, index), jamais supprimer ni renommer ce que la version en ligne
du site utilise encore.

Mise en place (une fois) : après la première fusion, le Worker `seancy-admin` existe ; lui donner ses secrets
(Cloudflare → Workers et Pages → `seancy-admin` → Paramètres → Variables et secrets) : `ACCESS_AUD`,
`ACCESS_TEAM_DOMAIN`, `ADMIN_EMAILS`, `CF_ANALYTICS_TOKEN`, `GITHUB_TICKETS_TOKEN`, et si besoin
`DISCORD_TICKETS_WEBHOOK_URL`, `SENTRY_DSN` ; puis la release suivante du site active le renvoi de l'API ; enfin,
déplacer le domaine personnalisé `admin.seancy.com` du Worker `seancy` au Worker `seancy-admin`.

- **Tableau de bord** : la **mise en ligne** (ce qui attend sur `develop`, bouton « Lancer la release » : branche
  `release/<date>` depuis `develop` avec `main` refusionné, PR vers `main` fusionnée par le serveur dès que la CI est
  passée, notification ; plus besoin d'un ticket pour demander une release : `worker/release.ts` ; la carte montre la
  prochaine version et les entrées du journal qui partiront ; pastille sur Accueil si une release est bloquée ou attend
  depuis plus de 3 jours), les **dépendances** (PR de Dependabot vers `develop` avec l'état de leur CI, « Fusionner »
  quand elle est passée), la **consommation de Claude** (relevée à la fin de chaque passage d'un ticket dans le
  journal de `claude-code-action` : jetons du jour, des 7 et 30 derniers jours, par modèle et par ticket, coût estimé au
  prix public, et l'état du quota de l'abonnement, fenêtres de 5 h et de la semaine, tel que Claude l'a donné au dernier
  passage, pas en direct : `worker/claude-usage.ts`, table `claude_usage`, gardée 90 jours), quelques chiffres
  (comptes, nouveaux comptes, connexions, abonnés aux notifications, bibliothèques, listes), les tickets par colonne et
  l'état des réglages (secrets présents ou non, jamais leur valeur).
- **Tickets** : le tableau des demandes envoyées à Claude (voir [Tickets (Claude)](#tickets-claude)). Chaque ticket
  garde son auteur et chaque action qui l'a faite ; filtre « Les miens » ; pastille de CI sur les tickets à valider
  (relue au passage régulier du serveur).
- **Outils** : notification de test (vers ses propres appareils seulement), vérification des nouveautés tout de suite
  (le passage de 7 h, avec confirmation), resynchronisation de l'index de recherche, erreur de test Sentry. Les
  anciennes routes à clé de debug (`/api/run-check`…) restent en place.

**Deux portes** (`worker/admin.ts`) : **Cloudflare Access** devant tout le domaine (le Worker vérifie en plus la
signature du jeton Access sur chaque appel `/api` du domaine admin : `worker/access.ts`), puis un **compte Seancy**
dont l'adresse est dans le secret `ADMIN_EMAILS`. Sur `seancy.com`, aucune session n'ouvre l'espace admin (`/admin` et
l'ancienne adresse `/tickets` y renvoient vers `admin.seancy.com`) ; sur les previews et en local, il est joignable
sous `/admin` (ou `admin.localhost`). Connexion par e-mail (lien ou code) : Google et Apple ne sont pas proposés sur
ce domaine (son adresse de retour n'est pas déclarée chez eux). Le domaine admin est compté comme la production : il
ne renvoie jamais de lien ni de code de connexion dans la réponse.

### Mise en route de l'espace admin

1. **Release** `develop` → `main` : le Worker de production ne se déploie que depuis `main` (la migration `0023` des
   tickets est appliquée par la CI).
2. **Domaine** : dashboard Cloudflare → Workers & Pages → `seancy` → Settings → Domains & Routes → _Add_ → _Custom
   domain_ → `admin.seancy.com` (comme `www.seancy.com` ; pas dans `wrangler.jsonc`, que le Worker `develop` partage).
3. **Cloudflare Access** : Zero Trust → Access → Applications → _Add an application_ → _Self-hosted_ → domaine
   `admin.seancy.com`, politique _Allow_ avec vos deux adresses e-mail. Copier l'**Application Audience (AUD) Tag**
   de l'application et le nom de l'équipe (Zero Trust → Settings → Custom Pages : `<équipe>.cloudflareaccess.com`).
4. **Secrets du Worker** `seancy` (type **Secret**) : `ADMIN_EMAILS` (adresses des comptes Seancy administrateurs,
   séparées par des virgules), `ACCESS_TEAM_DOMAIN` (`<équipe>.cloudflareaccess.com`) et `ACCESS_AUD` (le tag de
   l'étape 3). Sans ces deux derniers, le tableau de bord signale Access « non réglé » et seule la connexion admin de
   Seancy protège l'espace.
5. **Quotas Cloudflare** (facultatif) : Cloudflare → My Profile → API Tokens → _Create Custom Token_ avec la seule
   permissions **Account · Account Analytics · Read** et **Account · D1 · Read** (lecture seule) sur le compte de
   Seancy, puis secret `CF_ANALYTICS_TOKEN` du Worker `seancy`. Le tableau de bord montre alors les volumes du forfait
   Workers Paid (depuis le 17 nov. 2026) sur la période de facturation en cours, du 17 au 16 (`BILLING_DAY`) : requêtes
   des Workers, temps de calcul, lignes lues et écrites dans D1, stockage, avec le coût estimé au-delà de l'inclus, et les
   neurones Workers AI du jour (10 000 gratuits par jour UTC), le
   détail par Worker et par modèle, la liste des bases D1 (nom, tables, taille, activité du jour), les erreurs et
   dépassements de calcul du Worker, et les 7 derniers jours (`worker/cloudflare-usage.ts`, API d'analyse GraphQL, relue au plus toutes
   les 2 minutes).
   **Alertes de quota** (`worker/quota-alerts.ts`, au passage régulier du serveur, toutes les 10 minutes) : notification
   aux appareils abonnés aux tickets (et Discord) quand un volume inclus dépasse 80 % ou sera épuisé avant la remise à
   zéro au rythme actuel, puis quand il est épuisé (facturé au-delà) ; pareil pour les neurones gratuits du jour et pour
   les fenêtres du quota de l'abonnement Claude (80 % ou alerte de Claude, puis atteint). Une seule fois par seuil et par
   période ; rappel en tête des cartes « Quotas Cloudflare » et « Claude ».
6. Ouvrir `admin.seancy.com`, passer Access, se connecter avec son compte Seancy : le tableau de bord liste ce qui
   manque encore.

## Tickets (Claude)

Les demandes de développement ne passent plus par Trello : elles vivent dans Seancy, sur la page **Tickets** de
l'[espace admin](#espace-admin-adminseancycom) (`admin.seancy.com/tickets`), un tableau façon Trello repris de Paddock Live :
**Suggestions**, **Idées**, **À faire**, **En cours**, **À valider**, **Faits**. Une carte glissée d'une colonne à
l'autre fait l'action de la colonne (envoi à Claude, annulation, validation, retouche, réouverture), avec confirmation.

- **Suggestions** : celles des utilisateurs (Réglages › Suggestions, anonymes) arrivent dans leur propre colonne, à
  part des idées de l'équipe, avec l'étiquette « Suggestion ». Elles se trient comme les idées : « Garder en idée »,
  « En faire un ticket », glisser vers une autre colonne, ou « Archiver ».

- **Envoi** : le Worker (`worker/tickets.ts`, logique pure dans `worker/tickets-logic.ts`, tables de la migration
  `0023`) ouvre une issue `Ticket <id>` avec `@claude`. Le workflow **Tickets (Claude)**
  (`.github/workflows/claude-tickets.yml`) la traite aussitôt en suivant le skill `.claude/skills/ticket/SKILL.md`
  (mêmes règles que l'ancien pipeline Trello : reprise de l'historique, feature ou hotfix, contrôles, changeset,
  sous-agents `reviewer` / `ui-reviewer`), ouvre la PR en brouillon et écrit son compte rendu dans le ticket
  (`node scripts/tickets.ts answer …`). Modèle (Opus ou Sonnet), effort et case **Hotfix** se choisissent par ticket.
- **Validation** : « Valider et fusionner » fusionne la PR (squash) si elle contient toute sa base et que la CI est
  passée ; sinon le ticket attend **en file** : la page Tickets ouverte (au plus toutes les 90 s) et le workflow
  **Tickets (passage)** (toutes les 10 minutes, `.github/workflows/tickets-tick.yml`) mettent la PR à jour, attendent
  la CI et fusionnent, un ticket à la fois. Pas de tâche planifiée Cloudflare : le forfait gratuit en compte 5 pour
  tout le compte. Conflit ou CI rouge : le ticket repart tout seul chez Claude (2 essais au
  plus). Hotfix : fusion dans `main`, puis `main` refusionné dans `develop`. « Valider et commenter » fusionne puis
  renvoie le commentaire à Claude (nouvelle PR). « Retouche » relance Claude sur la même PR, « Rouvrir » repart
  d'une branche neuve.
- **Quota Claude épuisé** : ticket en pause, relancé tout seul une heure après (8 fois au plus). La preview de la PR
  (commentaire de la CI) est notée toute seule dans le ticket.
- **Notifications** : sur Discord (prêt à valider, arrêté, en pause, fusionné, validation impossible).
- **Archivage** : « Archiver » (fiche d'une suggestion, d'une idée, d'un ticket à faire ou fait) sort la carte du tableau sans la
  supprimer. Le bouton « Archivés » (avec leur nombre ; icône à côté du zoom sur téléphone) montre les cartes
  archivées seules, dans leur colonne. Elles reviennent aussi dans les résultats de la recherche (étiquette
  « Archivé ») et dans `node scripts/tickets.ts search` ; « Remettre sur le tableau », un envoi à Claude ou un
  changement de colonne les y remet.
- **Sessions Claude** : `node scripts/tickets.ts` (`inbox`, `answer`, `progress`, `file`, `add`, `list`, `search`, `get`), avec
  la clé `SEANCY_TICKETS_KEY` (créée sur la page Tickets → Réglages ; seule son empreinte est gardée).

- **Dépôt public** : le contenu des tickets reste dans la base de Seancy ; l'issue GitHub n'en porte que l'identifiant
  et les réglages, et Claude ne recopie jamais le texte d'un ticket dans une PR, un commit ou un commentaire (consigne
  du skill). Le journal de Claude n'est pas joint aux lancements (il serait téléchargeable par tous) et le résumé des
  commandes refusées ne montre que leur nom. Seul le propriétaire du dépôt déclenche Claude. Reste un risque
  d'**injection de consignes** : Claude lance des commandes avec le jeton `TICKETS_GITHUB_TOKEN`, donc un texte piégé
  dans un ticket pourrait tenter de le faire fuiter. Seuls les administrateurs écrivent les tickets ; si des tickets
  viennent un jour d'un texte extérieur (alerte Sentry…), les traiter comme de simples données. Garder ce jeton limité
  au dépôt `seancy` et protéger `main` et `develop` (pas de push direct).

### Mise en route (une fois)

1. **Espace admin** en place (voir [sa mise en route](#mise-en-route-de-lespace-admin)).
2. **Secrets du Worker** `seancy` (dashboard Cloudflare → Settings → Variables and Secrets, type **Secret**) :
   `GITHUB_TICKETS_TOKEN` (jeton GitHub _fine-grained_ sur le dépôt `seancy` : Contents, Issues et Pull requests en
   écriture, Actions en écriture pour arrêter Claude quand un envoi est annulé ; ajouter Workflows en écriture si
   Claude doit pouvoir modifier `.github/workflows`), et facultativement `DISCORD_TICKETS_WEBHOOK_URL` (webhook
   Discord du salon des notifications).
3. **Clé des sessions** : sur `admin.seancy.com/tickets` → **Réglages** → **Créer la clé**.
4. **Secrets du dépôt** (GitHub → Settings → Secrets and variables → Actions) : `CLAUDE_CODE_OAUTH_TOKEN` (le même
   que sur le NAS), `TICKETS_GITHUB_TOKEN` (le même jeton qu'à l'étape 2 : les pushes et la PR passent par lui pour
   que la CI et la preview se lancent), `SEANCY_TICKETS_KEY` (la clé de l'étape 3) ; facultatifs : `TMDB_API_KEY`,
   `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (captures des previews). Variable facultative `SEANCY_RUNNER`
   (`self-hosted` pour faire tourner Claude sur un runner du NAS au lieu des machines de GitHub).

### Bascule depuis Trello

1. Ajouter les secrets `TRELLO_KEY` et `TRELLO_TOKEN` au dépôt (les mêmes valeurs que le `.env` du NAS).
2. Actions → **Import Trello** → _Run workflow_ avec l'adresse du board, d'abord en **essai à blanc** (liste de ce qui
   serait importé), puis pour de vrai (`scripts/trello-import.ts`, conversion dans `scripts/trelloLib.ts`). Toutes
   les cartes ouvertes sont recopiées avec leur description, leurs checklists, étiquettes, commentaires et pièces
   jointes (fichiers de 1,5 Mo au plus recopiés, les autres gardés en liens). Rien n'est envoyé à Claude : les cartes
   « En cours » arrivent dans **À faire** (étiquette « Était en cours sur Trello »), « To merge » dans **À valider**.
   L'import est rejouable : une carte déjà importée est sautée.
3. Couper le webhook Trello du NAS (le listener garde le webhook Sentry). Les règles de `trello-ticket-pipeline` sont
   reprises dans le skill `ticket` ; l'ancien skill ne fait plus que prévenir sur Discord qu'un webhook Trello est
   arrivé. `sentry-triage` crée ses tickets avec `node scripts/tickets.ts add` (et rattache un correctif direct à un
   ticket « À valider » avec `answer --pr`) : ajouter `SEANCY_TICKETS_KEY` (la
   clé de la page Tickets) au `.env` du NAS (passée au conteneur par `docker-compose-seancy.yml`), puis `seancy-pull` et
   `seancy-rebuild claude`.

## Sécurité

- **Isolation entre comptes** : `PUT`/`GET /api/library` déterminent toujours le compte à partir du cookie de session (jointure `sessions` ↔ `users` en base), jamais d'un identifiant fourni par le client. Voir le commentaire au-dessus de `handleGetLibrary`/`handlePutLibrary` dans `worker/index.ts`.
- **Rate-limiting, validation de schéma, en-têtes HTTP, proxy TMDB** : voir `worker/rate-limit.ts`, `worker/validate.ts`, `public/_headers`.
- **Scan de secrets** : [gitleaks](https://github.com/gitleaks/gitleaks) tourne sur chaque PR (`.github/workflows/ci.yml`, job `secrets-scan`). Les quelques faux positifs connus (clé "site" reCAPTCHA, publique par conception ; clés `localStorage` type `seancy.*` ; valeurs d'exemple du README) sont documentés et exclus dans `.gitleaks.toml`.
- Détail complet des mécanismes vérifiés après la migration TypeScript : voir le debrief de migration (fourni séparément, pas commité dans ce README pour rester concis).

## Hooks Git locaux (Husky)

- **pre-commit** : lint + format automatique des fichiers modifiés (`lint-staged`).
- **pre-push** : `npm run typecheck` complet (trop lent pour tourner à chaque commit).

Ces hooks sont un filet local, en complément de la CI (qui revalide tout de toute façon) — pas un remplacement. Pour bypasser ponctuellement (jamais en usage normal) : `git commit --no-verify` / `git push --no-verify`.

## Fonctionnalités en stub

- **Nom affiché (Profil → Compte)** : préférence purement locale à l'appareil (`localStorage`), pas de colonne dédiée côté D1 — le compte n'a aujourd'hui qu'un email (authentification par lien magique, pas de profil étendu). Voir `modules/profile/components/AccountCard.tsx`.

Tout le reste (saga/collection, statistiques et collaborateur·rices fréquent·es d'une personne, titres exclus, thème clair/sombre, rangée "Reprendre"/"En cours", cloche "Me prévenir" sur Prochainement...) est branché sur de vraies données TMDB ou la bibliothèque locale/synchronisée — aucune fausse donnée simulée.

## Fonctionnalités

- **Découvrir** : suggestions filtrables par genre (sélection multiple) et plateforme, triées par popularité/note/année, scroll infini. Rangée **Reprendre** au-dessus (séries entamées).
- **Nouveautés** / **Prochainement** : sorties récentes / à venir, filtres pays/langue, fenêtre de dates ajustable. Prochainement affiche un calendrier groupé par mois avec cloche **Me prévenir** par titre.
- **Recherche** : en direct dans la barre de nav (films, séries, personnes) + page de résultats complète.
- **Fiche détail** : synopsis, bande-annonce, plateformes de streaming (région détectée automatiquement), statut cinéma (France), notation 0-10 avec paliers, saisons/épisodes, **la saga** (autres films de la franchise), titres similaires, exclusion du titre des suggestions.
- **Fiche personne** : biographie, statistiques (nombre de titres, note moyenne, genre fétiche), filmographie, **souvent à l'affiche avec** (collaborateur·rices récurrent·es).
- **Aléatoire** : tirage au sort selon tes filtres, avec alternatives.
- **Ma liste** : Déjà vu (statistiques visuelles : répartition films/séries, temps de visionnage, genres préférés, vus par année), Envie de voir (tri + réordonnancement manuel par glisser-déposer), En cours (séries entamées), listes personnalisées.
- **Profil** : compte, notifications push, plateformes favorites, genres exclus, titres exclus.
- **PWA installable**, thème clair/sombre, comptes optionnels avec synchronisation multi-appareils.

## Licence

Code source propriétaire — voir [`LICENSE`](./LICENSE). Le dépôt est public à des fins de
transparence uniquement ; cela n'accorde aucun droit de réutilisation, copie ou distribution.
