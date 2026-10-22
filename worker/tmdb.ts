// Client TMDB minimal côté Worker, pour la tâche planifiée et les endpoints
// qui mutualisent un appel TMDB coûteux entre visiteurs (voir
// getTheatricalIndex). Distinct de src/core/api/tmdb.ts (qui tourne dans le
// navigateur et lit import.meta.env.VITE_TMDB_API_KEY) : ici on lit
// env.TMDB_API_KEY, un secret Worker configuré séparément dans le dashboard
// Cloudflare.
import type { Env } from "./types.ts";

const BASE_URL = "https://api.themoviedb.org/3";
// Région de repli pour les vérifications de disponibilité : abonnements
// anonymes et comptes sans région enregistrée (users.region, migration 0007).
export const DEFAULT_REGION = "FR";
const LANGUAGE = "fr-FR";

export async function tmdbFetch<T>(
  env: Env,
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  if (!env.TMDB_API_KEY) {
    throw new Error("TMDB_API_KEY manquant dans les secrets du Worker.");
  }
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("api_key", env.TMDB_API_KEY);
  url.searchParams.set("language", LANGUAGE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Erreur TMDB (${res.status}) sur ${path}`);
  }
  return res.json() as Promise<T>;
}

interface WatchProvidersResult {
  results?: Record<string, { flatrate?: Array<{ provider_id: number }> }>;
}

// Ids des plateformes en abonnement (flatrate) d'un titre, par région.
// TMDB renvoie toutes les régions en un seul appel : un titre ne coûte qu'un
// appel par exécution du cron, quel que soit le nombre de régions des
// destinataires.
export type FlatrateByRegion = Record<string, number[]>;

async function getFlatrateProvidersByRegion(
  env: Env,
  mediaType: string,
  tmdbId: number
): Promise<FlatrateByRegion> {
  const data = await tmdbFetch<WatchProvidersResult>(
    env,
    `/${mediaType}/${tmdbId}/watch/providers`
  );
  const byRegion: FlatrateByRegion = {};
  for (const [region, entry] of Object.entries(data.results || {})) {
    byRegion[region] = (entry.flatrate || []).map((p) => p.provider_id);
  }
  return byRegion;
}

export interface TmdbListItem {
  id: number;
  title?: string;
  name?: string;
  media_type?: string;
  popularity?: number;
  release_date?: string;
  first_air_date?: string;
}

// Mutualise les appels TMDB identiques (même item, même genre) le temps
// d'une exécution du cron quotidien (voir worker/scheduled.ts) : plusieurs
// abonnements partagent souvent les mêmes titres en watchlist ou les mêmes
// genres favoris, et les interroger en série pour chacun d'eux multiplie
// inutilement les appels et le risque de throttling TMDB sur une même
// invocation.
export interface TmdbRunCache {
  providers: Map<string, Promise<FlatrateByRegion>>;
  genreDiscover: Map<string, Promise<TmdbListItem[]>>;
}

export function createTmdbRunCache(): TmdbRunCache {
  return { providers: new Map(), genreDiscover: new Map() };
}

// Plateformes en abonnement disponibles pour ce titre dans `region` (celle
// du destinataire), ou [] si rien.
export async function getFlatrateProviderIdsCached(
  cache: TmdbRunCache,
  env: Env,
  mediaType: string,
  tmdbId: number,
  region: string
): Promise<number[]> {
  const key = `${mediaType}:${tmdbId}`;
  let pending = cache.providers.get(key);
  if (!pending) {
    pending = getFlatrateProvidersByRegion(env, mediaType, tmdbId);
    cache.providers.set(key, pending);
  }
  return (await pending)[region] ?? [];
}

export function discoverRecentByGenreCached(
  cache: TmdbRunCache,
  env: Env,
  mediaType: string,
  genreId: number,
  windowDays: number
): Promise<TmdbListItem[]> {
  const key = `${mediaType}:${genreId}:${windowDays}`;
  let pending = cache.genreDiscover.get(key);
  if (!pending) {
    pending = discoverRecentByGenre(env, mediaType, genreId, windowDays);
    cache.genreDiscover.set(key, pending);
  }
  return pending;
}

// Nouveautés (sorties des `windowDays` derniers jours) dans un genre donné.
export async function discoverRecentByGenre(
  env: Env,
  mediaType: string,
  genreId: number,
  windowDays: number
): Promise<TmdbListItem[]> {
  const dateField = mediaType === "movie" ? "primary_release_date" : "first_air_date";
  const today = new Date();
  const since = new Date(today.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const data = await tmdbFetch<{ results?: TmdbListItem[] }>(env, `/discover/${mediaType}`, {
    with_genres: genreId,
    sort_by: `${dateField}.desc`,
    [`${dateField}.gte`]: since.toISOString().slice(0, 10),
    [`${dateField}.lte`]: today.toISOString().slice(0, 10),
    "vote_count.gte": 5,
    include_adult: "false",
  });
  return data.results || [];
}

// Grosses sorties généralistes (tendances du jour), tous genres confondus —
// sert de filet pour les nouveautés qu'on n'aurait pas via les genres favoris.
export async function trendingToday(env: Env): Promise<TmdbListItem[]> {
  const data = await tmdbFetch<{ results?: TmdbListItem[] }>(env, "/trending/all/day");
  return (data.results || []).filter(
    (item) => item.media_type === "movie" || item.media_type === "tv"
  );
}

const MAX_THEATRICAL_PAGES = 10; // now_playing + upcoming restent largement sous ce plafond en pratique

async function fetchAllPageIds(
  env: Env,
  path: string,
  region: string,
  maxPages: number
): Promise<number[]> {
  const first = await tmdbFetch<{ results?: TmdbListItem[]; total_pages?: number }>(env, path, {
    region,
    page: 1,
  });
  const totalPages = Math.min(first.total_pages || 1, maxPages);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) =>
      tmdbFetch<{ results?: TmdbListItem[] }>(env, path, { region, page: i + 2 })
    )
  );
  return [first, ...rest].flatMap((page) => (page.results || []).map((item) => item.id));
}

export interface TheatricalIndexResult {
  inTheaters: number[];
  upcoming: number[];
}

// Parcourt /movie/now_playing et /movie/upcoming en entier pour une région
// (voir /api/theatrical-index dans index.ts, qui met le résultat en cache
// d'edge) : appelé au plus une fois par région et par heure, peu importe le
// nombre de visiteurs — remplace en production le parcours équivalent que
// src/core/api/tmdb.ts ferait sinon depuis CHAQUE navigateur à CHAQUE
// session (son propre cache mémoire ne survit pas à un rechargement).
export async function getTheatricalIndex(env: Env, region: string): Promise<TheatricalIndexResult> {
  const [inTheaters, upcoming] = await Promise.all([
    fetchAllPageIds(env, "/movie/now_playing", region, MAX_THEATRICAL_PAGES),
    fetchAllPageIds(env, "/movie/upcoming", region, MAX_THEATRICAL_PAGES),
  ]);
  return { inTheaters, upcoming };
}
