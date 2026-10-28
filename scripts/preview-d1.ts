// Provisionne (ou nettoie) une base D1 dédiée à la preview d'une PR, pour
// pouvoir tester une migration de schéma en conditions réelles avant merge
// (voir ticket Trello "Infra : base D1 isolée par preview"). Gère aussi la
// base D1 persistante de l'environnement `develop` (voir ticket Trello
// "Avenir du développement") : une seule base, créée une fois, jamais
// supprimée, réutilisée à chaque push sur la branche `develop`.
//
// Le plan D1 gratuit limite le compte à 10 bases au total (voir
// developers.cloudflare.com/d1/platform/limits) : prod (`seancy-notifications`)
// et `seancy-develop` comptent dedans en permanence, donc au plus 8 previews de
// PR simultanées sur le reste du quota. `provision`/`provisionDevelop`
// patientent qu'une place se libère (fermeture/merge d'une autre PR) plutôt
// que d'échouer immédiatement, comme demandé sur le ticket D1 isolée par PR.
//
// `provision` génère un fichier de config wrangler dérivé de wrangler.jsonc
// (mêmes assets, binding D1 "DB" pointant vers la base dédiée, Durable
// Objects propres à l'environnement — voir writeGeneratedConfig) : c'est ce
// fichier que le workflow passe ensuite à `wrangler preview --config` pour
// déployer une preview de PR, branchée sur sa propre base.
//
// `provisionDevelop` génère sa propre config (voir writeDevelopConfig) :
// `develop` est un vrai Worker déployé (`wrangler deploy`, voir ticket
// Trello "Rendre develop iso-prod"), pas une Preview — il garde donc les
// bindings natifs de wrangler.jsonc tels quels (ai, ratelimits, exports...),
// seuls le nom du Worker et le binding D1 sont réécrits.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { experimental_readRawConfig } from "wrangler";

const WRANGLER_BIN = "node_modules/.bin/wrangler";
const SOURCE_CONFIG_PATH = "wrangler.jsonc";
const PREVIEW_CONFIG_PATH = "wrangler.preview.generated.jsonc";
const PREVIEW_SEED_PATH = "scripts/fixtures/preview-seed.sql";
const PROD_DATABASE_NAME = "seancy-notifications";
const PREVIEW_DATABASE_PREFIX = "seancy-preview-pr-";
const DEVELOP_DATABASE_NAME = "seancy-develop";
const DEVELOP_CONFIG_PATH = "wrangler.develop.generated.jsonc";
const DEVELOP_SEED_PATH = "scripts/fixtures/develop-seed.sql";
// Nom du Worker réel dédié à `develop` (distinct de "seancy", la prod) —
// voir writeDevelopConfig.
const DEVELOP_WORKER_NAME = "seancy-develop";
// Décalage appliqué aux `namespace_id` du binding "Rate Limiting" de
// wrangler.jsonc pour `develop` — voir writeDevelopConfig : ce namespace_id
// est défini au niveau du COMPTE Cloudflare (pas du Worker, malgré le
// commentaire de wrangler.jsonc), donc deux Workers qui déclarent le même
// namespace_id partagent les mêmes compteurs. Sans ce décalage, du trafic de
// test sur `seancy-develop` viderait le même budget que la prod `seancy` et
// pourrait faire passer des vrais utilisateurs en 429.
const DEVELOP_RATE_LIMIT_NAMESPACE_OFFSET = 1000;
// Tables réinitialisées par `reset-develop`, dans un ordre qui respecte les
// clés étrangères (dépendants d'abord). `users`/`sessions` en dernier :
// quasiment toutes les autres tables y font référence (ON DELETE CASCADE
// absent sur D1/SQLite tel qu'utilisé ici, voir worker/schema.sql).
const DEVELOP_RESETTABLE_TABLES = [
  "custom_list_items",
  "custom_lists",
  "list_shares",
  "follows",
  "library_items",
  "watchlist_items",
  "genre_preferences",
  "excluded_genre_prefs",
  "favorite_provider_prefs",
  "favorite_language_prefs",
  "favorite_country_prefs",
  "user_notified_releases",
  "notified_releases",
  "reminders",
  "email_changes",
  "user_avatars",
  "magic_links",
  "sessions",
  "users",
];

const ACCOUNT_DATABASE_LIMIT = 10; // plan D1 gratuit, toutes bases confondues
const POLL_INTERVAL_SECONDS = 30;
const MAX_WAIT_MINUTES = 15;
// Nom du binding (voir worker/types.ts, Env) sous lequel chaque classe
// Durable Object est exposée dans les previews / l'environnement develop.
const PREVIEW_DURABLE_OBJECT_BINDINGS: Record<string, string> = {
  UserSyncHub: "USER_SYNC_HUB",
};

// Sous-ensemble de wrangler.jsonc lu par writeGeneratedConfig (le type
// renvoyé par experimental_readRawConfig n'est pas résolu par tsc ici).
interface D1Binding {
  binding: string;
  database_name: string;
  database_id: string;
}
interface RateLimit {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
}
interface SourceConfig {
  vars?: Record<string, unknown>;
  d1_databases?: D1Binding[];
  exports?: Record<string, { type: string }>;
  ratelimits?: RateLimit[];
  [key: string]: unknown;
}

interface D1Database {
  uuid: string;
  name: string;
}

function dbNameForPr(prNumber: string): string {
  return `${PREVIEW_DATABASE_PREFIX}${prNumber}`;
}

function listDatabases(): D1Database[] {
  const out = execFileSync(WRANGLER_BIN, ["d1", "list", "--json"], { encoding: "utf8" });
  return JSON.parse(out) as D1Database[];
}

function sleepSeconds(seconds: number): void {
  execFileSync("sleep", [String(seconds)]);
}

function createDatabase(dbName: string): string {
  // `wrangler d1 create` n'a pas de sortie --json : on récupère l'UUID créé
  // dans le snippet de config qu'elle imprime toujours sur stdout (au format
  // JSON puisque wrangler.jsonc est un fichier JSON/JSONC).
  const output = execFileSync(WRANGLER_BIN, ["d1", "create", dbName], { encoding: "utf8" });
  const match = /"database_id":\s*"([0-9a-f-]+)"/i.exec(output);
  if (!match) {
    throw new Error(`Impossible de récupérer l'UUID de la base '${dbName}' créée :\n${output}`);
  }
  return match[1];
}

// Crée `dbName` si elle n'existe pas encore, en patientant si le plan
// gratuit est saturé (une autre PR doit libérer une place) ; réutilise la
// base existante sinon. Partagé entre les previews de PR (une par PR) et la
// base persistante `develop` (une seule, jamais recréée une fois en place).
function ensureDatabase(dbName: string): string {
  const deadline = Date.now() + MAX_WAIT_MINUTES * 60_000;

  for (;;) {
    const databases = listDatabases();
    const existing = databases.find((db) => db.name === dbName);
    if (existing) {
      console.log(`Base '${dbName}' déjà provisionnée (réutilisation).`);
      return existing.uuid;
    }

    if (databases.length < ACCOUNT_DATABASE_LIMIT) {
      console.log(
        `Création de la base '${dbName}' (${databases.length}/${ACCOUNT_DATABASE_LIMIT} bases sur le compte)...`
      );
      return createDatabase(dbName);
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Plan D1 gratuit saturé (${ACCOUNT_DATABASE_LIMIT} bases max) depuis plus de ${MAX_WAIT_MINUTES} min, ` +
          `abandon. Une autre PR doit être fermée/mergée pour libérer une place.`
      );
    }
    console.log(
      `Plan D1 saturé (${databases.length}/${ACCOUNT_DATABASE_LIMIT} bases sur le compte) : nouvelle tentative dans ${POLL_INTERVAL_SECONDS}s...`
    );
    sleepSeconds(POLL_INTERVAL_SECONDS);
  }
}

function writeGeneratedConfig(configPath: string, dbName: string, uuid: string): void {
  const rawConfig = experimental_readRawConfig({ config: SOURCE_CONFIG_PATH })
    .rawConfig as SourceConfig;
  const prodDatabase = rawConfig.d1_databases?.find(
    (db) => db.database_name === PROD_DATABASE_NAME
  );
  if (!prodDatabase) {
    throw new Error(
      `Binding D1 de prod ('${PROD_DATABASE_NAME}') introuvable dans ${SOURCE_CONFIG_PATH}.`
    );
  }
  const targetDatabase = { ...prodDatabase, database_name: dbName, database_id: uuid };

  // Cloudflare Previews (`wrangler preview`) ne publie ni "exports" ni les
  // bindings de premier niveau : seuls "migrations" et le bloc "previews"
  // (bindings propres aux previews) sont envoyés. Les Durable Objects
  // déclarés via "exports" en prod sont donc redéclarés ici par une
  // migration (stockage SQLite, seul disponible sur le plan gratuit) et
  // liés sous "previews.durable_objects" : chaque preview — et l'environnement
  // develop, lui aussi déployé via `wrangler preview` — possède alors ses
  // propres instances, isolées de la prod et des autres previews (voir
  // worker/sync.ts, hubFor). "exports" et "migrations" s'excluant
  // mutuellement, "exports" est retiré de la config générée.
  //
  // Variables ("vars") : volontairement PAS reprises de wrangler.jsonc. Les
  // previews (et develop) tirent toutes leurs variables ET leurs secrets de
  // la "Preview base config" du Worker (dashboard Cloudflare, ou `wrangler
  // preview base-config`), qui a ses propres clés d'API : y recopier les
  // vars de prod (clé VAPID publique, clé reCAPTCHA de site, token Web
  // Analytics) les écraserait par celles de la prod, incohérentes avec les
  // secrets de preview (ex. clé VAPID publique de prod + clé privée de
  // preview = push cassé) et mêlant le trafic des previews aux statistiques
  // de prod.
  const { exports: workerExports, vars: _prodVars, ...rest } = rawConfig;
  const durableObjectClasses = Object.entries(workerExports ?? {})
    .filter(([, entry]) => entry.type === "durable-object")
    .map(([className]) => className);
  const generatedConfig = {
    ...rest,
    d1_databases: [targetDatabase],
    migrations:
      durableObjectClasses.length > 0
        ? [{ tag: "preview-v1", new_sqlite_classes: durableObjectClasses }]
        : [],
    previews: {
      d1_databases: [targetDatabase],
      durable_objects: {
        bindings: durableObjectClasses.map((className) => ({
          name: PREVIEW_DURABLE_OBJECT_BINDINGS[className] ?? className,
          class_name: className,
        })),
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(generatedConfig, null, 2) + "\n");
}

// `develop` est déployé pour de vrai (`wrangler deploy`, voir ticket Trello
// "Rendre develop iso-prod" — jusqu'ici c'était `wrangler preview`, le même
// mécanisme qu'une preview de PR, sans bindings natifs réels pour `ai` et
// `ratelimits`, cf. PR #312). Contrairement à writeGeneratedConfig (previews
// de PR), tous les bindings de wrangler.jsonc sont donc repris tels quels —
// "ai", "ratelimits" et "exports" (Durable Objects) fonctionnent nativement
// sur un vrai déploiement, pas besoin du détour par "migrations"/"previews".
// Le nom du Worker (pour ne pas écraser la prod "seancy"), le binding D1
// "DB" (base dédiée `seancy-develop`) et les `namespace_id` du binding Rate
// Limiting (comptes partagés au niveau du compte Cloudflare, voir
// DEVELOP_RATE_LIMIT_NAMESPACE_OFFSET) sont réécrits. Le reste de "vars"
// reste identique à la prod (valeurs non sensibles, voir wrangler.jsonc),
// sauf CLOUDFLARE_ANALYTICS_TOKEN : vidé pour ne pas mêler le trafic de
// `develop` aux statistiques Web Analytics réelles de la prod (même
// raisonnement que writeGeneratedConfig ci-dessus pour les previews de PR —
// `env.CLOUDFLARE_ANALYTICS_TOKEN || null` gère déjà l'absence sans crasher,
// voir worker/index.ts). Les vrais secrets (TMDB_API_KEY,
// VAPID_PRIVATE_KEY...) doivent être configurés une fois, à la main, sur ce
// nouveau Worker (dashboard Cloudflare → Settings → Variables and Secrets)
// — ils ne sont jamais hérités de la prod ni gérés par la CI.
function writeDevelopConfig(dbName: string, uuid: string): void {
  const rawConfig = experimental_readRawConfig({ config: SOURCE_CONFIG_PATH })
    .rawConfig as SourceConfig;
  const prodDatabase = rawConfig.d1_databases?.find(
    (db) => db.database_name === PROD_DATABASE_NAME
  );
  if (!prodDatabase) {
    throw new Error(
      `Binding D1 de prod ('${PROD_DATABASE_NAME}') introuvable dans ${SOURCE_CONFIG_PATH}.`
    );
  }
  const targetDatabase = { ...prodDatabase, database_name: dbName, database_id: uuid };
  const generatedConfig = {
    ...rawConfig,
    name: DEVELOP_WORKER_NAME,
    d1_databases: [targetDatabase],
    vars: { ...rawConfig.vars, CLOUDFLARE_ANALYTICS_TOKEN: "" },
    ratelimits: rawConfig.ratelimits?.map((rateLimit) => ({
      ...rateLimit,
      namespace_id: String(Number(rateLimit.namespace_id) + DEVELOP_RATE_LIMIT_NAMESPACE_OFFSET),
    })),
  };
  writeFileSync(DEVELOP_CONFIG_PATH, JSON.stringify(generatedConfig, null, 2) + "\n");
}

function applyMigrations(dbName: string, configPath: string): void {
  console.log(`Application des migrations sur '${dbName}'...`);
  execFileSync(
    WRANGLER_BIN,
    ["d1", "migrations", "apply", dbName, "--remote", "--config", configPath],
    { stdio: "inherit" }
  );

  // Compte de démo (voir scripts/fixtures/preview-seed.sql) : `INSERT OR
  // IGNORE`, donc sans danger à rejouer sur une base déjà peuplée (PR
  // réutilisée sur un nouveau push).
  console.log(`Seed du compte de démo sur '${dbName}'...`);
  execFileSync(
    WRANGLER_BIN,
    [
      "d1",
      "execute",
      dbName,
      "--remote",
      "--config",
      PREVIEW_CONFIG_PATH,
      "--file",
      PREVIEW_SEED_PATH,
    ],
    { stdio: "inherit" }
  );
}

function applySeed(dbName: string, configPath: string, seedPath: string): void {
  console.log(`Seed de '${dbName}' depuis '${seedPath}'...`);
  execFileSync(
    WRANGLER_BIN,
    ["d1", "execute", dbName, "--remote", "--config", configPath, "--file", seedPath],
    { stdio: "inherit" }
  );
}

function provision(prNumber: string): void {
  const dbName = dbNameForPr(prNumber);
  const uuid = ensureDatabase(dbName);
  writeGeneratedConfig(PREVIEW_CONFIG_PATH, dbName, uuid);
  applyMigrations(dbName, PREVIEW_CONFIG_PATH);
  // Même jeu de fixtures que l'environnement develop (voir ticket Trello
  // "Rejouer les fixtures de seed sur les previews de PR") : `INSERT OR
  // IGNORE` partout, donc sans risque à rejouer à chaque push sur la PR.
  applySeed(dbName, PREVIEW_CONFIG_PATH, DEVELOP_SEED_PATH);
}

// Provisionne (une seule fois) puis tient à jour la base persistante de
// l'environnement `develop` (voir ticket Trello "Avenir du développement") :
// mêmes migrations que la prod, mais un jeu de données fictives "full" (voir
// scripts/fixtures/develop-seed.sql), rejoué à chaque push sur `develop` en
// `INSERT OR IGNORE` — donc additif : les nouvelles lignes de fixtures
// suivent les évolutions du schéma sans jamais écraser les données de test
// ajoutées manuellement entre deux pushs. Pour repartir d'une base propre,
// voir `reset-develop` (déclenché à la main, workflow dédié).
function provisionDevelop(): void {
  const uuid = ensureDatabase(DEVELOP_DATABASE_NAME);
  writeDevelopConfig(DEVELOP_DATABASE_NAME, uuid);
  applyMigrations(DEVELOP_DATABASE_NAME, DEVELOP_CONFIG_PATH);
  applySeed(DEVELOP_DATABASE_NAME, DEVELOP_CONFIG_PATH, DEVELOP_SEED_PATH);
}

// Vide toutes les tables de données de `seancy-develop` (la base elle-même
// et son schéma restent en place) puis rejoue le seed "full" sur une base
// vierge. Déclenché à la main via le workflow `reset-develop-db.yml`
// (Actions → Run workflow), jamais automatiquement.
function resetDevelop(): void {
  const databases = listDatabases();
  const existing = databases.find((db) => db.name === DEVELOP_DATABASE_NAME);
  if (!existing) {
    throw new Error(
      `Base '${DEVELOP_DATABASE_NAME}' introuvable — rien à réinitialiser (lancer 'provision-develop' d'abord).`
    );
  }
  writeDevelopConfig(DEVELOP_DATABASE_NAME, existing.uuid);
  console.log(
    `Réinitialisation de '${DEVELOP_DATABASE_NAME}' (${DEVELOP_RESETTABLE_TABLES.length} tables)...`
  );
  const deleteStatements = DEVELOP_RESETTABLE_TABLES.map((table) => `DELETE FROM ${table};`).join(
    "\n"
  );
  execFileSync(
    WRANGLER_BIN,
    [
      "d1",
      "execute",
      DEVELOP_DATABASE_NAME,
      "--remote",
      "--config",
      DEVELOP_CONFIG_PATH,
      "--command",
      deleteStatements,
    ],
    { stdio: "inherit" }
  );
  applyMigrations(DEVELOP_DATABASE_NAME, DEVELOP_CONFIG_PATH);
  applySeed(DEVELOP_DATABASE_NAME, DEVELOP_CONFIG_PATH, DEVELOP_SEED_PATH);
}

function cleanup(prNumber: string): void {
  const dbName = dbNameForPr(prNumber);
  const existing = listDatabases().filter((db) => db.name === dbName);
  if (existing.length === 0) {
    console.log(`Aucune base de preview à nettoyer pour cette PR ('${dbName}' n'existe pas).`);
    return;
  }
  for (const { name } of existing) {
    console.log(`Suppression de la base de preview '${name}'...`);
    execFileSync(WRANGLER_BIN, ["d1", "delete", name, "--skip-confirmation"], { stdio: "inherit" });
  }
}

const [, , command, prNumber] = process.argv;

switch (command) {
  case "provision":
    if (!prNumber) {
      console.error("Usage: node scripts/preview-d1.ts provision <numéro-de-pr>");
      process.exit(1);
    }
    provision(prNumber);
    break;
  case "cleanup":
    if (!prNumber) {
      console.error("Usage: node scripts/preview-d1.ts cleanup <numéro-de-pr>");
      process.exit(1);
    }
    cleanup(prNumber);
    break;
  case "provision-develop":
    provisionDevelop();
    break;
  case "reset-develop":
    resetDevelop();
    break;
  default:
    console.error(
      `Commande inconnue : '${command ?? ""}' (attendu : provision | cleanup | provision-develop | reset-develop)`
    );
    process.exit(1);
}
