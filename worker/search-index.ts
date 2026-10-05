// Index local des titres (films + séries) les plus populaires, synchronisé
// quotidiennement depuis TMDB (cron dédié "30 7 * * *", voir scheduled()
// dans index.ts et wrangler.jsonc). Complète searchMultiRanked côté client
// (src/core/api/tmdb.ts) pour les requêtes courtes : TMDB classe /search/*
// par pertinence texte, pas par préfixe, et un titre très populaire peut
// n'apparaître dans AUCUNE page de résultats pour une requête de 2-3 lettres
// (confirmé pour "Bat" → jamais "Batman", même en page 500 de /search/multi,
// /search/movie et /search/tv) — voir carte Trello "Ajuster les recherches".
// Un filtre local "commence par" sur les titres les plus populaires couvre
// ce cas sans dépendre du classement interne de TMDB.
import type { Env } from "./types.ts";

const BASE_URL = "https://api.themoviedb.org/3";
const LANGUAGE = "fr-FR";
// 10 pages × 20 résultats = ~200 titres par type, large marge au-delà de
// toute franchise grand public. Le cron de sync tourne seul (voir
// "30 7 * * *" dans wrangler.jsonc, dispatché séparément de runDailyCheck)
// pour ne pas partager son budget de sous-requêtes avec les notifications.
const PAGES_PER_MEDIA_TYPE = 10;
const MAX_LOCAL_RESULTS = 10;
// D1 limite la taille d'un batch : lots de 100 statements (DELETE inclus
// dans le premier lot), chaque lot restant une transaction propre.
const BATCH_SIZE = 100;

interface TmdbPopularItem {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  popularity?: number;
  vote_average?: number;
  genre_ids?: number[];
  original_language?: string;
}

async function fetchPopularPage(
  env: Env,
  mediaType: "movie" | "tv",
  page: number
): Promise<TmdbPopularItem[]> {
  const url = new URL(`${BASE_URL}/${mediaType}/popular`);
  url.searchParams.set("api_key", env.TMDB_API_KEY || "");
  url.searchParams.set("language", LANGUAGE);
  url.searchParams.set("page", String(page));
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Erreur TMDB (${res.status}) sur /${mediaType}/popular`);
  }
  const data = (await res.json()) as { results?: TmdbPopularItem[] };
  return data.results || [];
}

// Beaucoup de titres commencent par un article ("The Batman", "La Casa de
// Papel") : un filtre "commence par" strict sur le titre complet raterait
// justement le cas d'origine du ticket ("bat" ne matche pas "The Batman").
// Les recherches média usuelles (iTunes, Netflix...) ignorent cet article en
// tête — on fait pareil ici, des deux côtés (titre indexé et requête, voir
// searchLocalIndex) grâce à normalizeSearchText.
const LEADING_ARTICLE_RE = /^(the|les?|une?|des)\s+|^l['’]\s*/;

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(LEADING_ARTICLE_RE, "");
}

// "!" comme caractère d'échappement (voir ESCAPE ci-dessous) : évite les
// subtilités de quoting d'un backslash dans un literal SQL, un titre ne
// contient jamais "!" suivi immédiatement d'un caractère à échapper par
// coïncidence problématique ici (juste un marqueur, pas une contrainte sur
// les titres eux-mêmes).
function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (ch) => `!${ch}`);
}

// Remplace entièrement l'index à chaque passage plutôt que d'upserter : TMDB
// classe /popular par popularité du jour, donc un titre qui sort du top doit
// aussi disparaître d'ici. Un DELETE + réinsertion en un seul batch (= une
// transaction D1) reste simple et largement assez rapide pour un job
// quotidien sur ce volume (même principe que purge.ts).
export async function syncPopularTitles(env: Env): Promise<void> {
  if (!env.TMDB_API_KEY) {
    throw new Error("TMDB_API_KEY manquant : sync de l'index de recherche annulée.");
  }
  const mediaTypes: Array<"movie" | "tv"> = ["movie", "tv"];
  const rows: Array<{
    tmdbId: number;
    mediaType: "movie" | "tv";
    title: string;
    normalizedTitle: string;
    releaseDate: string | null;
    posterPath: string | null;
    popularity: number;
    voteAverage: number | null;
    genreIds: string;
    originalLanguage: string | null;
  }> = [];

  for (const mediaType of mediaTypes) {
    const pages = await Promise.all(
      Array.from({ length: PAGES_PER_MEDIA_TYPE }, (_, i) =>
        fetchPopularPage(env, mediaType, i + 1)
      )
    );
    for (const item of pages.flat()) {
      const title = item.title || item.name || "";
      if (!title) {
        continue;
      }
      rows.push({
        tmdbId: item.id,
        mediaType,
        title,
        normalizedTitle: normalizeSearchText(title),
        releaseDate: item.release_date || item.first_air_date || null,
        posterPath: item.poster_path ?? null,
        popularity: item.popularity ?? 0,
        voteAverage: item.vote_average ?? null,
        genreIds: JSON.stringify(item.genre_ids || []),
        originalLanguage: item.original_language ?? null,
      });
    }
  }

  const now = Date.now();
  const statements = [
    env.DB.prepare("DELETE FROM popular_titles"),
    // OR REPLACE plutôt qu'un simple INSERT : le classement /popular de TMDB
    // peut bouger pendant qu'on le paginera en parallèle, un même titre se
    // retrouvant alors sur deux pages consécutives (vu en pratique :
    // SQLITE_CONSTRAINT_PRIMARYKEY sur tmdb_id+media_type) — sans impact ici
    // puisque le dernier remplace juste le précédent avec les mêmes données.
    ...rows.map((row) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO popular_titles
             (tmdb_id, media_type, title, normalized_title, release_date, poster_path, popularity, vote_average, genre_ids, original_language, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        row.tmdbId,
        row.mediaType,
        row.title,
        row.normalizedTitle,
        row.releaseDate,
        row.posterPath,
        row.popularity,
        row.voteAverage,
        row.genreIds,
        row.originalLanguage,
        now
      )
    ),
  ];

  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await env.DB.batch(statements.slice(i, i + BATCH_SIZE));
  }
}

// Façonné comme un item de SearchMultiResult (voir src/core/types/tmdb.ts)
// pour que le client puisse le fusionner avec les résultats TMDB sans
// distinction de provenance — title/name et release_date/first_air_date
// renseignés des deux côtés, peu importe lequel le composant appelant lit.
export interface LocalSearchResult {
  id: number;
  media_type: "movie" | "tv";
  title: string;
  name: string;
  release_date?: string;
  first_air_date?: string;
  poster_path: string | null;
  popularity: number;
  vote_average: number | null;
  genre_ids: number[];
  original_language: string | null;
}

interface PopularTitleRow {
  tmdb_id: number;
  media_type: string;
  title: string;
  release_date: string | null;
  poster_path: string | null;
  popularity: number;
  vote_average: number | null;
  genre_ids: string;
  original_language: string | null;
}

export async function searchLocalIndex(
  env: Env,
  query: string,
  limit = MAX_LOCAL_RESULTS
): Promise<LocalSearchResult[]> {
  const normalized = normalizeSearchText(query);
  if (!normalized) {
    return [];
  }
  const pattern = `${escapeLikePattern(normalized)}%`;
  const { results } = await env.DB.prepare(
    `SELECT tmdb_id, media_type, title, release_date, poster_path, popularity, vote_average, genre_ids, original_language
       FROM popular_titles
      WHERE normalized_title LIKE ? ESCAPE '!'
      ORDER BY popularity DESC
      LIMIT ?`
  )
    .bind(pattern, limit)
    .all<PopularTitleRow>();

  return (results || []).map((row) => ({
    id: row.tmdb_id,
    media_type: row.media_type as "movie" | "tv",
    title: row.title,
    name: row.title,
    release_date: row.release_date ?? undefined,
    first_air_date: row.release_date ?? undefined,
    poster_path: row.poster_path,
    popularity: row.popularity,
    vote_average: row.vote_average,
    genre_ids: JSON.parse(row.genre_ids || "[]"),
    original_language: row.original_language,
  }));
}
