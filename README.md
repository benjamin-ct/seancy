# Seancy 🎬

> En ligne sur **https://seancy.com** (previews de PR sur `<slug>.dev.seancy.com`).

Application pour découvrir des films et séries, savoir où les regarder en streaming (France), tirer un titre au hasard, et suivre ce que tu as déjà vu.

Les données (catalogue, affiches, plateformes de streaming) viennent de [TMDB](https://www.themoviedb.org/) (The Movie Database), qui agrège aussi les disponibilités JustWatch.

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

| Nom                                    | Obligatoire        | Rôle                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TMDB_API_KEY`                         | ✅                 | Proxy TMDB + tâche planifiée                                                                                                                                                                                                                                                                       |
| `VAPID_PRIVATE_KEY`                    | Notifications push | `node -e "console.log(require('web-push').generateVAPIDKeys())"`                                                                                                                                                                                                                                   |
| `DEBUG_TRIGGER_KEY`                    | optionnel          | À inventer toi-même (chaîne aléatoire, pas une clé fournie par un service externe) : sert de mot de passe partagé pour `/api/run-check`, `/api/test-notification`, `/api/test-error`, `/api/sync-search-index` — colle ensuite la même valeur dans le header `x-debug-key` de tes requêtes de test |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | Comptes            | Envoi des liens de connexion par email (sans elle : le lien est renvoyé dans la réponse API, pour tester sans boîte mail)                                                                                                                                                                          |
| `RECAPTCHA_SECRET_KEY`                 | optionnel          | Anti-bot sur l'authentification                                                                                                                                                                                                                                                                    |
| `SENTRY_DSN`                           | optionnel          | Suivi des erreurs (client + Worker), voir section Observabilité ci-dessous                                                                                                                                                                                                                         |

Pour tester la configuration localement sans rien déployer : `npm run build && npx wrangler deploy --dry-run`.

Pour du développement local avec un Worker complet (D1 + secrets) : crée un `.dev.vars` (jamais commité), puis `npx wrangler d1 migrations apply seancy-notifications --local && npx wrangler dev`.

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

## Sécurité

- **Isolation entre comptes** : `PUT`/`GET /api/library` déterminent toujours le compte à partir du cookie de session (jointure `sessions` ↔ `users` en base), jamais d'un identifiant fourni par le client. Voir le commentaire au-dessus de `handleGetLibrary`/`handlePutLibrary` dans `worker/index.ts`.
- **Rate-limiting, validation de schéma, en-têtes HTTP, proxy TMDB** : voir `worker/rate-limit.ts`, `worker/validate.ts`, `public/_headers`.
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
