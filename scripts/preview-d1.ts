// Provisionne (ou nettoie) une base D1 dédiée à la preview d'une PR, pour
// pouvoir tester une migration de schéma en conditions réelles avant merge
// (voir ticket Trello "Infra : base D1 isolée par preview").
//
// Le plan D1 gratuit limite le compte à 10 bases au total (voir
// developers.cloudflare.com/d1/platform/limits), prod comprise
// (`seancy-notifications`, plus l'ancienne `bobine-notifications` tant
// qu'elle n'est pas supprimée) : une base de preview n'est créée que s'il
// reste une place sur le compte. Au-delà, `provision` patiente qu'une place se libère
// (fermeture/merge d'une autre PR) plutôt que d'échouer immédiatement, comme
// demandé sur le ticket.
//
// `provision` génère un fichier de config wrangler dérivé de wrangler.jsonc
// (mêmes assets, binding D1 "DB" pointant vers la base de preview,
// Durable Objects propres à la preview — voir writePreviewConfig) : c'est ce
// fichier que le workflow passe ensuite à `wrangler preview --config` pour
// déployer la preview branchée sur sa propre base.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { experimental_readRawConfig } from "wrangler";

const WRANGLER_BIN = "node_modules/.bin/wrangler";
const SOURCE_CONFIG_PATH = "wrangler.jsonc";
const PREVIEW_CONFIG_PATH = "wrangler.preview.generated.jsonc";
const PREVIEW_SEED_PATH = "scripts/fixtures/preview-seed.sql";
const PROD_DATABASE_NAME = "seancy-notifications";
const PREVIEW_DATABASE_PREFIX = "seancy-preview-pr-";
// Bases créées avant le renommage Seancy, encore nettoyées à la fermeture
// de leur PR.
const LEGACY_PREVIEW_DATABASE_PREFIX = "bobine-preview-pr-";
const ACCOUNT_DATABASE_LIMIT = 10; // plan D1 gratuit, toutes bases confondues
const POLL_INTERVAL_SECONDS = 30;
const MAX_WAIT_MINUTES = 15;
// Nom du binding (voir worker/types.ts, Env) sous lequel chaque classe
// Durable Object est exposée dans les previews.
const PREVIEW_DURABLE_OBJECT_BINDINGS: Record<string, string> = {
  UserSyncHub: "USER_SYNC_HUB",
};

// Sous-ensemble de wrangler.jsonc lu par writePreviewConfig (le type
// renvoyé par experimental_readRawConfig n'est pas résolu par tsc ici).
interface D1Binding {
  binding: string;
  database_name: string;
  database_id: string;
}
interface SourceConfig {
  vars?: Record<string, unknown>;
  d1_databases?: D1Binding[];
  exports?: Record<string, { type: string }>;
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

function writePreviewConfig(dbName: string, uuid: string): void {
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
  const previewDatabase = { ...prodDatabase, database_name: dbName, database_id: uuid };

  // Cloudflare Previews (`wrangler preview`) ne publie ni "exports" ni les
  // bindings de premier niveau : seuls "migrations" et le bloc "previews"
  // (bindings propres aux previews) sont envoyés. Les Durable Objects
  // déclarés via "exports" en prod sont donc redéclarés ici par une
  // migration (stockage SQLite, seul disponible sur le plan gratuit) et
  // liés sous "previews.durable_objects" : chaque preview possède alors ses
  // propres instances, isolées de la prod et des autres previews (voir
  // worker/sync.ts, hubFor). "exports" et "migrations" s'excluant
  // mutuellement, "exports" est retiré de la config générée.
  //
  // Variables ("vars") : volontairement PAS reprises de wrangler.jsonc. Les
  // previews tirent toutes leurs variables ET leurs secrets de la "Preview
  // base config" du Worker (dashboard Cloudflare, ou `wrangler preview
  // base-config`), qui a ses propres clés d'API : y recopier les vars de
  // prod (clé VAPID publique, clé reCAPTCHA de site, token Web Analytics)
  // les écraserait par celles de la prod, incohérentes avec les secrets de
  // preview (ex. clé VAPID publique de prod + clé privée de preview = push
  // cassé) et mêlant le trafic des previews aux statistiques de prod.
  const { exports: workerExports, vars: _prodVars, ...rest } = rawConfig;
  const durableObjectClasses = Object.entries(workerExports ?? {})
    .filter(([, entry]) => entry.type === "durable-object")
    .map(([className]) => className);
  const previewConfig = {
    ...rest,
    d1_databases: [previewDatabase],
    migrations:
      durableObjectClasses.length > 0
        ? [{ tag: "preview-v1", new_sqlite_classes: durableObjectClasses }]
        : [],
    previews: {
      d1_databases: [previewDatabase],
      durable_objects: {
        bindings: durableObjectClasses.map((className) => ({
          name: PREVIEW_DURABLE_OBJECT_BINDINGS[className] ?? className,
          class_name: className,
        })),
      },
    },
  };
  writeFileSync(PREVIEW_CONFIG_PATH, JSON.stringify(previewConfig, null, 2) + "\n");
}

function provision(prNumber: string): void {
  const dbName = dbNameForPr(prNumber);
  const deadline = Date.now() + MAX_WAIT_MINUTES * 60_000;
  let uuid: string | undefined;

  while (uuid === undefined) {
    const databases = listDatabases();
    const existing = databases.find((db) => db.name === dbName);
    if (existing) {
      console.log(`Base de preview '${dbName}' déjà provisionnée (réutilisation).`);
      uuid = existing.uuid;
      break;
    }

    if (databases.length < ACCOUNT_DATABASE_LIMIT) {
      console.log(
        `Création de la base de preview '${dbName}' (${databases.length}/${ACCOUNT_DATABASE_LIMIT} bases sur le compte)...`
      );
      uuid = createDatabase(dbName);
      break;
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

  writePreviewConfig(dbName, uuid);
  console.log(`Application des migrations sur '${dbName}'...`);
  execFileSync(
    WRANGLER_BIN,
    ["d1", "migrations", "apply", dbName, "--remote", "--config", PREVIEW_CONFIG_PATH],
    {
      stdio: "inherit",
    }
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

function cleanup(prNumber: string): void {
  const dbNames = [dbNameForPr(prNumber), `${LEGACY_PREVIEW_DATABASE_PREFIX}${prNumber}`];
  const existing = listDatabases().filter((db) => dbNames.includes(db.name));
  if (existing.length === 0) {
    console.log(`Aucune base de preview à nettoyer pour cette PR ('${dbNames[0]}' n'existe pas).`);
    return;
  }
  for (const { name } of existing) {
    console.log(`Suppression de la base de preview '${name}'...`);
    execFileSync(WRANGLER_BIN, ["d1", "delete", name, "--skip-confirmation"], { stdio: "inherit" });
  }
}

const [, , command, prNumber] = process.argv;
if (!prNumber) {
  console.error("Usage: node scripts/preview-d1.ts <provision|cleanup> <numéro-de-pr>");
  process.exit(1);
}

switch (command) {
  case "provision":
    provision(prNumber);
    break;
  case "cleanup":
    cleanup(prNumber);
    break;
  default:
    console.error(`Commande inconnue : '${command}' (attendu : provision | cleanup)`);
    process.exit(1);
}
