// Client TMDB (The Movie Database) — point d'entrée unique pour toute donnée
// de catalogue. Doc : https://developer.themoviedb.org/reference/intro/getting-started
//
// La logique PURE (badge dynamique, métadonnées, limiteur de concurrence)
// vit dans des modules séparés (releaseBadge.ts, movieMeta.ts,
// concurrencyLimiter.ts — aucune dépendance à `import.meta.env` ni au
// réseau, testables sous Node natif) et est réexportée ici pour que les
// appelants continuent d'importer depuis un point d'entrée unique.
export {
  DEFAULT_REGION,
  getUpcomingMovieRelease,
  getUpcomingSeriesRelease,
} from "./releaseBadge.ts";
import { DEFAULT_REGION } from "./releaseBadge.ts";
export {
  estimateRuntimeMinutes,
  getTheatricalDateFromDetails,
  formatFullDate,
  dateLocaleTag,
  theatricalStatusFromDate,
} from "./movieMeta.ts";
export type { DateLocale } from "./movieMeta.ts";
export { getSeriesEpisodeBadge } from "./seriesEpisodeBadge.ts";
export type { SeriesEpisodeBadge } from "./seriesEpisodeBadge.ts";
export { getMovieReleaseBadge } from "./movieReleaseBadge.ts";
export type { MovieReleaseBadge } from "./movieReleaseBadge.ts";
export { posterUrl, posterSrcSet, backdropUrl, logoUrl, TmdbConfigError } from "./tmdbClient.ts";
import { tmdbFetch, IS_DEV, currentTmdbLanguage } from "./tmdbClient.ts";
import { LruCache } from "../lib/lruCache.ts";

import type {
  Country,
  Genre,
  Language,
  MediaDetails,
  MediaType,
  PagedResponse,
  PersonCredits,
  PersonDetails,
  RegionWatchProviders,
  SearchMultiResult,
  SeasonDetails,
  WatchProviderEntry,
  WatchProvidersResponse,
  MediaSummary,
  CollectionDetails,
} from "../types/tmdb.ts";

// Listes quasi-statiques (genres, pays, langues), appelées depuis de
// nombreux composants au même moment (ex. Découvrir et TonightPick sur
// l'accueil) : on met en cache la promesse, pas seulement le résultat, pour
// qu'un appel concurrent réutilise la requête en vol (audit M8). Clé par
// langue TMDB (noms localisés) ; une entrée en échec est retirée pour
// permettre un nouvel essai.
const staticListCache = new Map<string, Promise<unknown>>();

function cachedStaticList<T>(name: string, load: () => Promise<T>): Promise<T> {
  const key = `${name}:${currentTmdbLanguage()}`;
  const cached = staticListCache.get(key);
  if (cached) {
    return cached as Promise<T>;
  }
  const promise = load();
  staticListCache.set(key, promise);
  promise.catch(() => staticListCache.delete(key));
  return promise;
}

// Genres --------------------------------------------------------------

export function getGenres(mediaType: MediaType): Promise<{ genres: Genre[] }> {
  return cachedStaticList(`genres:${mediaType}`, () => tmdbFetch(`/genre/${mediaType}/list`));
}

// Découverte / recherche -----------------------------------------------

// Le tri "mieux noté" a besoin d'un plancher de votes, sinon un film noté
// 10/10 par 3 personnes remonte devant des classiques.
const MIN_VOTES_FOR_RATING_SORT = 100;

export type DiscoverSortField = "popularity" | "vote_average" | "year";
export type SortDirection = "asc" | "desc";

export interface DiscoverParams {
  page?: number;
  /** Un ou plusieurs genres (sélection multiple, voir shared/components/
   * FilterBar) — plusieurs genres combinés en OU (n'importe lequel des
   * genres cochés), pas en ET. */
  genreId?: string | number | Array<string | number>;
  /** Genres à ne jamais suggérer (réglage "Genres à exclure",
   * ExcludedGenresContext). Paramètre TMDB natif without_genres. */
  excludeGenreIds?: number[];
  providerIds?: Array<string | number>;
  /** Région utilisée pour filtrer par plateforme (watch_region — n'a de
   * sens que combinée à providerIds). Voir RegionContext. */
  region?: string;
  sortField?: DiscoverSortField;
  sortDirection?: SortDirection;
  year?: number;
  yearMin?: number;
  yearMax?: number;
  /** Bornes précises au jour (YYYY-MM-DD), pour "derniers sortis" par ex.
   * Prennent le pas sur yearMin/yearMax si les deux sont fournis. */
  dateFrom?: string;
  dateTo?: string;
  /** Exclut les titres pas encore sortis, quels que soient les autres
   * filtres de date (Découvrir doit toujours l'utiliser). */
  excludeUpcoming?: boolean;
  voteAverageMin?: number;
  voteAverageMax?: number;
  voteCountMin?: number;
  originCountry?: string;
  originalLanguage?: string;
  runtimeMin?: number;
  runtimeMax?: number;
  /** Demande au Worker (voir worker/index.ts) de résoudre le badge plateforme
   * de chaque résultat côté serveur (un seul aller-retour pour toute la
   * grille, avec réutilisation du cache d'edge par titre) plutôt que de
   * laisser chaque MediaCard faire son propre appel /watch/providers une fois
   * visible. Réservé aux pages qui affichent ce badge (voir
   * showProviderBadge sur MediaCard) : sans intérêt ailleurs. Sans effet en
   * dev (le Worker n'est pas dans la boucle, voir tmdbClient.ts). */
  includeProviderBadge?: boolean;
  /** Films uniquement : demande au Worker de résoudre, pour chaque résultat,
   * la date de sortie ciné dans `region` à partir de /release_dates
   * (voir enrichDiscoverResultsWithRegionDate, worker/index.ts), pour que
   * les cartes (MediaCard) affichent cette date plutôt que `release_date`
   * (date globale TMDB, pas région-consciente — cause du bug "date figée
   * sur la France" côté grilles). Même tradeoff que includeProviderBadge :
   * un aller-retour serveur unique pour toute la grille plutôt qu'un appel
   * par carte, donc réservé aux pages qui affichent cette date par défaut
   * (Découvrir). Sans effet en dev (Worker pas dans la boucle). */
  includeRegionReleaseDate?: boolean;
  /** Annulation quand la page ou le filtre change (voir tmdbFetch). */
  signal?: AbortSignal;
}

export function discover(
  mediaType: MediaType,
  {
    page = 1,
    genreId,
    excludeGenreIds,
    providerIds,
    region = DEFAULT_REGION,
    sortField = "popularity",
    sortDirection = "desc",
    year,
    yearMin,
    yearMax,
    dateFrom,
    dateTo,
    excludeUpcoming,
    voteAverageMin,
    voteAverageMax,
    voteCountMin,
    originCountry,
    originalLanguage,
    runtimeMin,
    runtimeMax,
    includeProviderBadge,
    includeRegionReleaseDate,
    signal,
  }: DiscoverParams = {}
): Promise<PagedResponse<MediaSummary>> {
  const resolvedField: string =
    sortField === "year"
      ? mediaType === "movie"
        ? "primary_release_date"
        : "first_air_date"
      : sortField;
  const dateField = mediaType === "movie" ? "primary_release_date" : "first_air_date";
  const todayIso = new Date().toISOString().slice(0, 10);
  let dateLte = dateTo || (yearMax ? `${yearMax}-12-31` : undefined);
  if (excludeUpcoming && (!dateLte || dateLte > todayIso)) {
    dateLte = todayIso;
  }
  const genreIdParam = Array.isArray(genreId)
    ? genreId.length
      ? genreId.join("|")
      : undefined
    : genreId;
  return tmdbFetch(
    `/discover/${mediaType}`,
    {
      page,
      with_genres: genreIdParam || undefined,
      without_genres: excludeGenreIds?.length ? excludeGenreIds.join(",") : undefined,
      with_watch_providers: providerIds?.length ? providerIds.join("|") : undefined,
      watch_region: providerIds?.length ? region : undefined,
      sort_by: `${resolvedField}.${sortDirection}`,
      // Un plancher explicite (filtre avancé) prend le pas sur celui, implicite,
      // qu'on applique par défaut quand on trie par note.
      "vote_count.gte":
        voteCountMin || (sortField === "vote_average" ? MIN_VOTES_FOR_RATING_SORT : undefined),
      "vote_average.gte": voteAverageMin || undefined,
      "vote_average.lte": voteAverageMax || undefined,
      "with_runtime.gte": runtimeMin || undefined,
      "with_runtime.lte": runtimeMax || undefined,
      with_origin_country: originCountry || undefined,
      with_original_language: originalLanguage || undefined,
      [`${dateField}.gte`]: dateFrom || (yearMin ? `${yearMin}-01-01` : undefined),
      [`${dateField}.lte`]: dateLte,
      [mediaType === "movie" ? "primary_release_year" : "first_air_date_year"]: year || undefined,
      include_adult: false,
      // Paramètres propres au Worker (retirés avant l'appel TMDB réel côté
      // serveur, voir handleTmdbProxy) : region est renvoyée séparément de
      // watch_region ci-dessus, qui ne part que combinée à un filtre
      // providerIds et n'a donc pas toujours la bonne valeur pour ce besoin.
      include_watch_providers_badge: includeProviderBadge ? 1 : undefined,
      watch_providers_badge_region: includeProviderBadge ? region : undefined,
      include_region_release_date:
        includeRegionReleaseDate && mediaType === "movie" ? 1 : undefined,
      region_release_date_region:
        includeRegionReleaseDate && mediaType === "movie" ? region : undefined,
    },
    { signal }
  );
}

// `labelKey` plutôt qu'un libellé en dur (même raison que STAR_LABEL_KEYS
// dans ratingTier.ts) : ce module ne dépend pas de React, à résoudre via
// t() côté composant appelant (voir FilterBar).
export const SORT_FIELDS: Array<{ value: DiscoverSortField; labelKey: string }> = [
  { value: "popularity", labelKey: "filterBar.sortByPopularity" },
  { value: "vote_average", labelKey: "filterBar.sortByRating" },
  { value: "year", labelKey: "filterBar.sortByYear" },
];

// Liste des pays (code ISO 3166-1 + nom localisé), pour le filtre "pays de
// production". Résultat quasi-statique côté TMDB, sans dépendance à une
// région particulière.
export function getCountries(): Promise<Country[]> {
  return cachedStaticList("countries", async () => {
    const list = await tmdbFetch<Country[]>("/configuration/countries");
    return list.slice().sort((a, b) => a.english_name.localeCompare(b.english_name));
  });
}

// Liste des langues (code ISO 639-1 + nom natif), pour le filtre "langue
// originale". `name` est le nom natif renvoyé par TMDB (ex. "Español",
// "日本語") — plus reconnaissable qu'une traduction. Résultat
// quasi-statique, mis en cache comme getCountries().
export function getLanguages(): Promise<Language[]> {
  return cachedStaticList("languages", async () => {
    const list = await tmdbFetch<Language[]>("/configuration/languages");
    return list
      .filter((l) => l.iso_639_1 && (l.name || l.english_name))
      .slice()
      .sort((a, b) =>
        (a.english_name || a.name || "").localeCompare(b.english_name || b.name || "")
      );
  });
}

export function searchMulti(
  query: string,
  page = 1,
  region: string = DEFAULT_REGION
): Promise<PagedResponse<SearchMultiResult>> {
  return tmdbFetch("/search/multi", {
    query,
    page,
    include_adult: false,
    // Même mécanisme que discover() : sans ça, MediaCard retombe sur
    // item.release_date (date "primaire" globale TMDB, pas région-consciente),
    // d'où le flash FR→région active vu en ouvrant une fiche depuis la recherche.
    include_region_release_date: 1,
    region_release_date_region: region,
  });
}

// TMDB classe chaque page de /search/multi par pertinence texte, pas par
// popularité : pour une requête courte ("Bat"), un titre bien plus populaire
// ("Batman") peut se retrouver au-delà de la page 1 et donc hors du tri par
// popularité fait côté client, qui ne reclasse que ce que TMDB a renvoyé.
// On agrège plusieurs pages avant de trier pour éviter de le manquer.
const SEARCH_MULTI_PAGES_TO_MERGE = 3;

// En dessous de ce nombre de caractères, agréger plus de pages ne suffit
// plus : TMDB ne fait pas de recherche par préfixe sur les requêtes courtes
// et peut ne renvoyer un titre pourtant très populaire dans AUCUNE page
// (vérifié pour "Bat" → jamais "Batman", même en page 500 de /search/multi,
// /search/movie et /search/tv — carte Trello "Ajuster les recherches"). On
// complète avec l'index local des titres populaires, synchronisé
// quotidiennement depuis TMDB (voir worker/search-index.ts).
const SHORT_QUERY_LOCAL_INDEX_THRESHOLD = 3;

async function searchLocalIndex(query: string): Promise<SearchMultiResult[]> {
  try {
    const res = await fetch(`/api/search-index?q=${encodeURIComponent(query)}`);
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { results?: SearchMultiResult[] };
    return data.results || [];
  } catch {
    // Best effort : l'index local n'est qu'un complément, les résultats TMDB
    // seuls restent utilisables si cet appel échoue.
    return [];
  }
}

export async function searchMultiRanked(
  query: string,
  region: string = DEFAULT_REGION
): Promise<SearchMultiResult[]> {
  const trimmed = query.trim();
  const [first, localMatches] = await Promise.all([
    searchMulti(query, 1, region),
    trimmed.length > 0 && trimmed.length <= SHORT_QUERY_LOCAL_INDEX_THRESHOLD
      ? searchLocalIndex(trimmed)
      : Promise.resolve<SearchMultiResult[]>([]),
  ]);
  const pagesToFetch = Math.min(SEARCH_MULTI_PAGES_TO_MERGE, first.total_pages);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pagesToFetch - 1) }, (_, i) =>
      searchMulti(query, i + 2, region)
    )
  );
  const merged = [first, ...rest].flatMap((p) => p.results || []).concat(localMatches);
  const seen = new Set<string>();
  const deduped = merged.filter((item) => {
    const key = `${item.media_type}:${item.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return deduped.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
}

// Personnes (acteurs, réalisateurs) --------------------------------------

export function getPerson(id: string | number): Promise<PersonDetails> {
  return tmdbFetch(`/person/${id}`);
}

// Filmographie complète (apparitions devant ET derrière la caméra).
export function getPersonCredits(id: string | number): Promise<PersonCredits> {
  return tmdbFetch(`/person/${id}/combined_credits`);
}

// Détails ---------------------------------------------------------------

// Cache mémoire (durée de vie de la session) : les métadonnées d'un titre
// sont statiques à l'échelle d'une session, donc revoir plusieurs fois la
// même fiche détail ne doit pas refaire l'appel réseau. On met en cache la
// promesse elle-même (pas seulement le résultat résolu) : un second appel
// concurrent pour le même titre pendant que le premier est encore en vol
// réutilise la requête en cours plutôt que d'en émettre une seconde. En
// cas d'échec, l'entrée est retirée pour permettre un nouvel essai.
// Bornés (LRU) : une longue session ne les fait plus grossir sans fin (audit M10).
const detailsCache = new LruCache<string, Promise<MediaDetails>>(100);
// Mêmes réponses, une fois arrivées : lues de façon synchrone par la fiche
// (peekDetails) pour s'afficher d'emblée, sans passer par son squelette.
const detailsResolved = new LruCache<string, MediaDetails>(100);

function detailsKey(mediaType: MediaType, id: string | number): string {
  return `${mediaType}:${id}:${currentTmdbLanguage()}`;
}

/** Détails déjà chargés pendant la session (sans requête), sinon null. */
export function peekDetails(mediaType: MediaType, id: string | number): MediaDetails | null {
  return detailsResolved.get(detailsKey(mediaType, id)) ?? null;
}

export function getDetails(mediaType: MediaType, id: string | number): Promise<MediaDetails> {
  // Le titre/synopsis/genres renvoyés dépendent de la langue TMDB active : la
  // clé de cache doit en tenir compte, sinon changer de langue en cours de
  // session continue de servir la réponse mise en cache dans l'ancienne.
  const key = detailsKey(mediaType, id);
  const cached = detailsCache.get(key);
  if (cached) {
    return cached;
  }
  const promise = tmdbFetch<MediaDetails>(`/${mediaType}/${id}`, {
    // release_dates : sorties par pays (dont FR), pour le statut "au
    // cinéma". watch/providers : plateformes de streaming/achat/location —
    // inclus ici pour ne pas faire un second appel séparé (voir
    // watchProvidersFromDetails) sur la fiche détail / la roue aléatoire.
    // Séries : aggregate_credits en plus, `credits` ne donnant que le
    // casting de la dernière saison (voir castFromDetails).
    append_to_response:
      mediaType === "tv"
        ? "credits,aggregate_credits,videos,recommendations,release_dates,watch/providers"
        : "credits,videos,recommendations,release_dates,watch/providers",
  })
    .then((details) => {
      detailsResolved.set(key, details);
      return details;
    })
    .catch((err: unknown) => {
      detailsCache.delete(key);
      throw err;
    });
  detailsCache.set(key, promise);
  return promise;
}

// Résumé minimal (nom + année) d'un titre par id — utilisé pour résoudre le
// nom d'un titre exclu quand ni la bibliothèque locale ni le libellé capturé
// à l'exclusion ne suffisent (ex. titre exclu depuis un autre appareil).
// Pas d'append_to_response : contrairement à getDetails, on n'a besoin ni
// des crédits, ni des vidéos, ni des recommandations pour un simple libellé.
const summaryCache = new LruCache<string, Promise<MediaSummary>>(300);
export function getMediaSummary(mediaType: MediaType, id: string | number): Promise<MediaSummary> {
  const key = `${mediaType}:${id}:${currentTmdbLanguage()}`;
  const cached = summaryCache.get(key);
  if (cached) {
    return cached;
  }
  const promise = tmdbFetch<MediaSummary>(`/${mediaType}/${id}`).catch((err: unknown) => {
    summaryCache.delete(key);
    throw err;
  });
  summaryCache.set(key, promise);
  return promise;
}

// État de diffusion d'une série (dernier/prochain épisode, saisons, chaînes)
// pour les badges et « Reprendre » : ces champs sont dans la réponse de base
// de /tv/<id>, sans les crédits, vidéos, recommandations… qu'ajoute
// getDetails (audit M10). Une fiche complète déjà chargée pendant la session
// est réutilisée telle quelle.
const tvStatusCache = new LruCache<string, Promise<MediaDetails>>(300);
export function getTvStatus(id: string | number): Promise<MediaDetails> {
  const full = peekDetails("tv", id);
  if (full) {
    return Promise.resolve(full);
  }
  const key = `${id}:${currentTmdbLanguage()}`;
  const cached = tvStatusCache.get(key);
  if (cached) {
    return cached;
  }
  const promise = tmdbFetch<MediaDetails>(`/tv/${id}`).catch((err: unknown) => {
    tvStatusCache.delete(key);
    throw err;
  });
  tvStatusCache.set(key, promise);
  return promise;
}

// Collection/saga (franchise) --------------------------------------------
// Nouveau : section "La saga" de la fiche détail (repris de la maquette
// HTML). `belongs_to_collection` sur MediaDetails ne donne que id/nom/
// affiches — la liste des autres films de la franchise vient de ce second
// appel, dédié, à la demande (pas systématique sur getDetails : la plupart
// des titres n'appartiennent à aucune collection).
const collectionCache = new LruCache<string, Promise<CollectionDetails>>(50);
export function getCollection(collectionId: number): Promise<CollectionDetails> {
  const key = `${collectionId}:${currentTmdbLanguage()}`;
  const cached = collectionCache.get(key);
  if (cached) {
    return cached;
  }
  const promise = tmdbFetch<CollectionDetails>(`/collection/${collectionId}`).catch(
    (err: unknown) => {
      collectionCache.delete(key);
      throw err;
    }
  );
  collectionCache.set(key, promise);
  return promise;
}

// Statut "au cinéma" (France) --------------------------------------------
// Les helpers purs de date/statut vivent dans movieMeta.ts et sont
// réexportés en tête de fichier.

// Statut "au cinéma" pour les vignettes (grilles) --------------------------
//
// Contrairement à la fiche détail (un appel /release_dates déjà inclus via
// append_to_response, donc gratuit), une grille affiche des dizaines de
// titres à la fois : faire un appel /release_dates par vignette enverrait
// autant de requêtes que de cartes affichées. TMDB expose deux listes
// dédiées, région-conscientes et déjà filtrées aux sorties en salle —
// /movie/now_playing et /movie/upcoming — parcourues entièrement pour en
// faire un index consultable en O(1), sans aucun appel réseau par carte.
//
// En production, ce parcours (une dizaine de pages) est fait UNE FOIS côté
// Worker et partagé par tous les visiteurs d'une région via le cache d'edge
// (voir worker/tmdb.ts getTheatricalIndex et /api/theatrical-index) : sans
// ça, chaque session navigateur repayait ce coût dès l'ouverture de l'app
// (le cache mémoire ci-dessous ne survit pas à un rechargement). En dev
// (Worker pas dans la boucle, voir tmdbClient.ts), on continue de parcourir
// les pages directement depuis le navigateur.
const MAX_THEATRICAL_PAGES = 10; // now_playing + upcoming restent largement sous ce plafond en pratique

async function fetchAllPages(
  path: string,
  region: string,
  maxPages: number
): Promise<MediaSummary[]> {
  const first = await tmdbFetch<PagedResponse<MediaSummary>>(path, { region, page: 1 });
  const totalPages = Math.min(first.total_pages || 1, maxPages);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) =>
      tmdbFetch<PagedResponse<MediaSummary>>(path, { region, page: i + 2 })
    )
  );
  return [first, ...rest].flatMap((page) => page.results || []);
}

export type TheatricalIndex = Map<number, "upcoming" | "in_theaters">;

function buildTheatricalIndex(inTheaters: number[], upcoming: number[]): TheatricalIndex {
  const index: TheatricalIndex = new Map();
  for (const id of upcoming) {
    index.set(id, "upcoming");
  }
  // now_playing en dernier : si un titre apparaît dans les deux listes
  // (bascule en cours), "en salles" prime sur "bientôt".
  for (const id of inTheaters) {
    index.set(id, "in_theaters");
  }
  return index;
}

async function fetchTheatricalIndexDirect(region: string): Promise<TheatricalIndex> {
  const [nowPlaying, upcoming] = await Promise.all([
    fetchAllPages("/movie/now_playing", region, MAX_THEATRICAL_PAGES),
    fetchAllPages("/movie/upcoming", region, MAX_THEATRICAL_PAGES),
  ]);
  return buildTheatricalIndex(
    nowPlaying.map((movie) => movie.id),
    upcoming.map((movie) => movie.id)
  );
}

async function fetchTheatricalIndexFromWorker(region: string): Promise<TheatricalIndex> {
  const res = await fetch(`/api/theatrical-index?region=${encodeURIComponent(region)}`);
  if (!res.ok) {
    throw new Error(`Erreur index théâtral (${res.status})`);
  }
  const data: { inTheaters: number[]; upcoming: number[] } = await res.json();
  return buildTheatricalIndex(data.inTheaters, data.upcoming);
}

let theatricalIndexCache: { region: string; promise: Promise<TheatricalIndex> } | null = null;
export function getTheatricalStatusIndex(
  region: string = DEFAULT_REGION
): Promise<TheatricalIndex> {
  if (theatricalIndexCache?.region === region) {
    return theatricalIndexCache.promise;
  }
  const promise = (
    IS_DEV ? fetchTheatricalIndexDirect(region) : fetchTheatricalIndexFromWorker(region)
  ).catch((err: unknown) => {
    theatricalIndexCache = null;
    throw err;
  });
  theatricalIndexCache = { region, promise };
  return promise;
}

// Détail d'une saison (liste des épisodes) — appel séparé de getDetails()
// car TMDB ne renvoie pas les épisodes dans la fiche série elle-même
// (seulement le résumé `seasons[]` : nombre d'épisodes, pas leur liste).
// Chargé à la demande (saison dépliée) plutôt que tout d'un coup.
export function getSeasonDetails(
  tvId: string | number,
  seasonNumber: number
): Promise<SeasonDetails> {
  return tmdbFetch(`/tv/${tvId}/season/${seasonNumber}`);
}

// Cache mémoire (même pattern que detailsCache) : évite un second appel
// réseau si le même titre est demandé deux fois dans la session.
const watchProvidersCache = new LruCache<string, Promise<RegionWatchProviders | null>>(500);
export function getWatchProviders(
  mediaType: MediaType,
  id: string | number,
  region: string = DEFAULT_REGION
): Promise<RegionWatchProviders | null> {
  const key = `${mediaType}:${id}:${region}`;
  const cached = watchProvidersCache.get(key);
  if (cached) {
    return cached;
  }
  const promise = tmdbFetch<WatchProvidersResponse>(`/${mediaType}/${id}/watch/providers`)
    .then((data) => data.results?.[region] || null)
    .catch((err: unknown) => {
      watchProvidersCache.delete(key);
      throw err;
    });
  watchProvidersCache.set(key, promise);
  return promise;
}

// Extrait les plateformes déjà incluses dans une fiche détail chargée via
// getDetails() (append_to_response=watch/providers) — évite un second appel
// getWatchProviders() en plus de getDetails() sur les écrans qui chargent
// déjà la fiche complète (fiche détail, roue aléatoire). Réservé aux appels
// "un titre à la fois" : les grilles (badge plateforme sur les cartes)
// continuent d'utiliser getWatchProviders() seul, une fiche complète par
// carte serait bien plus lourde que le nécessaire.
export function watchProvidersFromDetails(
  details: MediaDetails,
  region: string = DEFAULT_REGION
): RegionWatchProviders | null {
  return details["watch/providers"]?.results?.[region] || null;
}

// Badge dynamique "Prochainement" (prochaine sortie/diffusion) -----------
//
// Sur Prochainement, tout est par définition pas encore sorti : le badge
// doit dire OÙ/COMMENT une sortie à venir est prévue, pas réutiliser
// /watch/providers qui ne reflète que ce qui est DÉJÀ disponible.

// Cache mémoire par film : la réponse /release_dates change rarement.
const movieReleaseDatesCache = new LruCache<number, ReturnType<typeof tmdbFetch>>(500);
export function getMovieReleaseDates(movieId: number) {
  const cached = movieReleaseDatesCache.get(movieId);
  if (cached) {
    return cached;
  }
  const promise = tmdbFetch(`/movie/${movieId}/release_dates`).catch((err: unknown) => {
    movieReleaseDatesCache.delete(movieId);
    throw err;
  });
  movieReleaseDatesCache.set(movieId, promise);
  return promise;
}

// Fournisseurs de streaming "principaux" ----------------------------------
// Le catalogue TMDB complet (~90-100 entrées pour la France) mélange les
// vraies plateformes avec des chaînes additionnelles greffées sur un compte
// existant ("X Amazon Channel"), des paliers avec pub et des doublons de
// palier — inutilisable comme filtre pratique. TMDB n'expose aucun signal
// fiable "principal vs additionnel", d'où une liste choisie à la main.
// Revue le 16/08/2026 contre les vraies données TMDB (France) — à ajuster
// si un service majeur manque ou change d'id.
const MAIN_PROVIDER_IDS = new Set<number>([
  8, // Netflix
  119, // Amazon Prime Video
  337, // Disney Plus
  350, // Apple TV (Apple TV+)
  381, // Canal+
  1899, // HBO Max
  531, // Paramount Plus
  283, // Crunchyroll
  11, // MUBI
  234, // Arte
  147, // M6+
  2, // Apple TV Store (achat/location)
  3, // Google Play Movies (achat/location)
  35, // Rakuten TV (achat/location)
  192, // YouTube (achat/location)
  10, // Amazon Video (achat/location)
]);

export interface WatchProviderOption {
  id: number;
  name: string;
  logoPath?: string | null;
}

// Renvoie les plateformes de streaming "principales" disponibles dans la
// région donnée (abonnement, location, achat confondus), triées par
// pertinence locale.
export async function getWatchProvidersList(
  mediaType: MediaType,
  region: string = DEFAULT_REGION
): Promise<WatchProviderOption[]> {
  const data = await tmdbFetch<{ results?: WatchProviderEntry[] }>(
    `/watch/providers/${mediaType}`,
    {
      watch_region: region,
    }
  );
  const results = data.results || [];
  return results
    .filter((p) => MAIN_PROVIDER_IDS.has(p.provider_id))
    .sort(
      (a, b) => (a.display_priorities?.[region] ?? 999) - (b.display_priorities?.[region] ?? 999)
    )
    .map((p) => ({ id: p.provider_id, name: p.provider_name, logoPath: p.logo_path }));
}
