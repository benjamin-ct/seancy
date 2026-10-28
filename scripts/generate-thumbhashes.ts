// Calcule les ThumbHash des affiches TMDB qui n'en ont pas encore (voir
// migration 0021 et ticket Trello "ThumbHash affiches"), à partir des
// poster_path déjà connus de `popular_titles` (voir worker/search-index.ts).
//
// Tourne exclusivement en CI (voir .github/workflows/thumbhash-sync.yml),
// jamais dans le Worker : décoder un JPEG et calculer le ThumbHash dépasse
// largement le budget CPU du plan Workers gratuit (10 ms/requête) sur lequel
// tourne seancy aujourd'hui. `sharp` (décodage/redimensionnement) n'est
// disponible qu'en Node, pas dans le runtime Workers.
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { rgbaToThumbHash } from "thumbhash";

const WRANGLER_BIN = "node_modules/.bin/wrangler";
const DATABASE_NAME = "seancy-notifications";
// w92 : déjà proche de la taille max recommandée par ThumbHash (100x100),
// et bien plus léger à télécharger/décoder que les tailles servies au
// client (w185/w342, voir tmdbClient.ts).
const POSTER_BASE = "https://image.tmdb.org/t/p/w92";
// Plafond par run : reste raisonnable en durée (un run quotidien suffit à
// rattraper les nouveaux titres populaires, voir le cron dans le workflow)
// sans risquer de dépasser le temps d'exécution d'un job CI sur un premier
// remplissage à froid (traité sur plusieurs runs successifs si besoin).
const BATCH_SIZE = 150;

interface D1ExecuteResult {
  results?: Record<string, unknown>[];
}

function queryMissingPosterPaths(): string[] {
  const out = execFileSync(
    WRANGLER_BIN,
    [
      "d1",
      "execute",
      DATABASE_NAME,
      "--remote",
      "--json",
      "--command",
      `SELECT DISTINCT poster_path FROM popular_titles
         WHERE poster_path IS NOT NULL
           AND poster_path NOT IN (SELECT poster_path FROM poster_thumbhashes)
         LIMIT ${BATCH_SIZE}`,
    ],
    { encoding: "utf8" }
  );
  const [{ results }] = JSON.parse(out) as D1ExecuteResult[];
  return (results || []).map((row) => row.poster_path as string);
}

async function computeThumbHash(posterPath: string): Promise<string | null> {
  const res = await fetch(`${POSTER_BASE}${posterPath}`);
  if (!res.ok) {
    console.warn(`Affiche ${posterPath} inaccessible (${res.status}), ignorée.`);
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { data, info } = await sharp(bytes)
    .resize(100, 100, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hash = rgbaToThumbHash(info.width, info.height, data);
  return Buffer.from(hash).toString("base64");
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function main(): Promise<void> {
  const posterPaths = queryMissingPosterPaths();
  if (posterPaths.length === 0) {
    console.log("Aucune affiche manquante, rien à calculer.");
    return;
  }
  console.log(`${posterPaths.length} affiche(s) à traiter.`);

  const now = Date.now();
  const statements: string[] = [];
  for (const posterPath of posterPaths) {
    try {
      const hash = await computeThumbHash(posterPath);
      if (!hash) {
        continue;
      }
      statements.push(
        `INSERT OR REPLACE INTO poster_thumbhashes (poster_path, thumbhash, computed_at) ` +
          `VALUES ('${escapeSqlLiteral(posterPath)}', '${hash}', ${now});`
      );
    } catch (err) {
      console.warn(`Échec sur ${posterPath} : ${(err as Error).message}`);
    }
  }

  if (statements.length === 0) {
    console.log("Aucun ThumbHash calculé avec succès, rien à insérer.");
    return;
  }

  const sqlFile = "thumbhashes.generated.sql";
  writeFileSync(sqlFile, statements.join("\n"));
  try {
    execFileSync(WRANGLER_BIN, ["d1", "execute", DATABASE_NAME, "--remote", "--file", sqlFile], {
      stdio: "inherit",
    });
  } finally {
    unlinkSync(sqlFile);
  }
  console.log(`${statements.length} ThumbHash inséré(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
