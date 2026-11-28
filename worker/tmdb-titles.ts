// Branchement D1 + TMDB de worker/title-metadata.ts : vérification auprès de
// TMDB des titres écrits dans la bibliothèque et les listes perso, avec le
// cache partagé `tmdb_titles` (migration 0026). Voir title-metadata.ts pour
// les règles.
import type { Env } from "./types.ts";
import type { MediaTypeStr } from "./validate.ts";
import { upsertLabelStatement, type ListedTitle } from "./ai-suggestions.ts";
import { getLocaleForUser } from "./db.ts";
import { logError } from "./logger.ts";
import { checkRateLimitInMemory } from "./rate-limit-memory.ts";
import { TmdbHttpError, tmdbFetch } from "./tmdb.ts";
import {
  accountTitleLanguage,
  declaredTitleLanguage,
  metadataFromTmdbDetails,
  resolveTitles,
  titleKeyOf,
  type CachedTitle,
  type FetchedTitle,
  type TitleKey,
  type TitleResolver,
  type TitleSource,
} from "./title-metadata.ts";

// Langue TMDB des titres envoyés, posée par le client sur ses écritures de
// bibliothèque et de listes (voir LibraryContext, titleLanguageHeaders).
const TITLE_LANGUAGE_HEADER = "x-seancy-tmdb-language";

// Limite de 100 paramètres liés par requête D1, moins `media_type` et
// `language`.
const MAX_BOUND_IDS = 80;
// Plafond d'appels TMDB par compte (en mémoire, par isolat comme le proxy
// TMDB, voir rate-limit-memory.ts) : sans lui, un compte qui enverrait en
// boucle des identifiants jamais vus ferait taper TMDB 20 fois par écriture,
// sur la clé partagée par tous les visiteurs.
const FETCHES_PER_USER_PER_MINUTE = 60;

interface TitleRow {
  tmdb_id: number;
  found: number;
  title: string | null;
  poster_path: string | null;
  genre_ids: string | null;
  fetched_at: number;
}

interface TmdbTitleDetails {
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  original_language?: string;
  release_date?: string;
  first_air_date?: string;
}

function parseGenreIds(raw: string | null): number[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

function cachedFromRow(row: TitleRow): CachedTitle {
  return row.found
    ? {
        found: true,
        meta: {
          title: row.title,
          posterPath: row.poster_path,
          genreIds: parseGenreIds(row.genre_ids),
        },
        fetchedAt: row.fetched_at,
      }
    : { found: false, fetchedAt: row.fetched_at };
}

// Titre original, langue et année d'une fiche, pour le prompt des
// suggestions IA (tmdb_title_labels) : le titre lui-même n'y est repris
// qu'en français, la langue du prompt.
function labelFromDetails(key: TitleKey, language: string, data: TmdbTitleDetails): ListedTitle {
  const year = Number((data.release_date || data.first_air_date || "").slice(0, 4));
  return {
    mediaType: key.mediaType,
    tmdbId: key.id,
    title: language === "fr-FR" ? data.title || data.name || null : null,
    originalTitle: data.original_title || data.original_name || null,
    originalLanguage: data.original_language || null,
    releaseYear: Number.isFinite(year) && year > 1800 ? year : null,
  };
}

function d1TitleSource(env: Env, userId: number): TitleSource {
  const labels: ListedTitle[] = [];
  return {
    async read(keys, language) {
      const statements: D1PreparedStatement[] = [];
      const mediaTypes: MediaTypeStr[] = [];
      for (const mediaType of ["movie", "tv"] as const) {
        const ids = keys.filter((key) => key.mediaType === mediaType).map((key) => key.id);
        for (let i = 0; i < ids.length; i += MAX_BOUND_IDS) {
          const chunk = ids.slice(i, i + MAX_BOUND_IDS);
          statements.push(
            env.DB.prepare(
              `SELECT tmdb_id, found, title, poster_path, genre_ids, fetched_at FROM tmdb_titles
                WHERE media_type = ? AND language = ? AND tmdb_id IN (${chunk.map(() => "?").join(", ")})`
            ).bind(mediaType, language, ...chunk)
          );
          mediaTypes.push(mediaType);
        }
      }
      const cached = new Map<string, CachedTitle>();
      if (statements.length === 0) {
        return cached;
      }
      const results = await env.DB.batch<TitleRow>(statements);
      results.forEach(({ results: rows }, index) => {
        for (const row of rows) {
          cached.set(
            titleKeyOf({ mediaType: mediaTypes[index], id: row.tmdb_id }),
            cachedFromRow(row)
          );
        }
      });
      return cached;
    },

    async fetch(key, language): Promise<FetchedTitle> {
      try {
        const data = await tmdbFetch<TmdbTitleDetails>(env, `/${key.mediaType}/${key.id}`, {
          language,
        });
        labels.push(labelFromDetails(key, language, data));
        return { status: "found", meta: metadataFromTmdbDetails(key.mediaType, data) };
      } catch (err) {
        // 404 : identifiant que TMDB ne connaît pas. Tout le reste (429 après
        // réessais, panne, clé absente en local) laisse l'item tel quel.
        return err instanceof TmdbHttpError && err.status === 404
          ? { status: "missing" }
          : { status: "error" };
      }
    },

    async write(entries, language) {
      const now = Date.now();
      const upsert = env.DB.prepare(
        `INSERT INTO tmdb_titles
             (media_type, tmdb_id, language, found, title, poster_path, genre_ids, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (media_type, tmdb_id, language) DO UPDATE SET
             found = excluded.found,
             title = excluded.title,
             poster_path = excluded.poster_path,
             genre_ids = excluded.genre_ids,
             fetched_at = excluded.fetched_at`
      );
      try {
        await env.DB.batch([
          ...entries.map(({ key, entry }) =>
            upsert.bind(
              key.mediaType,
              key.id,
              language,
              entry.found ? 1 : 0,
              entry.found ? entry.meta.title : null,
              entry.found ? entry.meta.posterPath : null,
              entry.found ? JSON.stringify(entry.meta.genreIds) : null,
              entry.fetchedAt
            )
          ),
          ...labels.map((label) => upsertLabelStatement(env, label, now)),
        ]);
      } catch (err) {
        // Cache seulement : l'écriture de l'utilisateur passe quand même.
        logError("Fiches TMDB : mise en cache impossible.", err);
      }
    },

    allowFetch: () =>
      checkRateLimitInMemory(`tmdb-titles:user:${userId}`, {
        limit: FETCHES_PER_USER_PER_MINUTE,
        windowMs: 60_000,
      }),
  };
}

// Résolveur des titres d'une écriture de `userId`, dans la langue de cette
// écriture.
export async function titleResolverFor(
  request: Request,
  env: Env,
  userId: number
): Promise<TitleResolver> {
  const language =
    declaredTitleLanguage(request.headers.get(TITLE_LANGUAGE_HEADER)) ??
    accountTitleLanguage(await getLocaleForUser(env.DB, userId).catch(() => null));
  return (keys) => resolveTitles(keys, language, d1TitleSource(env, userId), Date.now());
}
