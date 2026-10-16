// Recommandations personnalisées "Pour toi" (v1) — tout le calcul tourne
// ici, côté Worker (voir ticket Trello "Recommandations personnalisées
// « Pour toi »") : le client ne fait qu'afficher le résultat de
// getRecommendations/getWeightedRandomPick.
//
// Candidats : plutôt que d'appeler TMDB /discover en direct à chaque
// requête (coût CPU + budget TMDB par utilisateur, voir contraintes du
// ticket), on filtre/score le cache local `popular_titles` (~200 titres les
// plus populaires par type, resynchronisé quotidiennement — voir
// search-index.ts). Compromis assumé pour ce v1 : le pool de candidats est
// borné à ce cache (pas de /discover par genre ni /recommendations par
// titre), donc moins exhaustif qu'un calcul TMDB complet, mais strictement
// gratuit en appels TMDB supplémentaires et déjà représentatif des genres
// (genre_ids y est indexé).
import type { Env } from "./types.ts";
import type { LibraryItem } from "../src/core/types/library.ts";
import type { NotInterestedRow } from "./db.ts";

export type RecommendationMediaType = "movie" | "tv";

export type RecommendationReason =
  { kind: "genre"; genreId: number } | { kind: "decade"; decade: number } | { kind: "trending" };

export interface RecommendationCandidate {
  id: number;
  mediaType: RecommendationMediaType;
  title: string;
  posterPath: string | null;
  releaseDate: string | null;
  voteAverage: number | null;
  popularity: number;
  genreIds: number[];
}

export interface RecommendationItem extends RecommendationCandidate {
  reason: RecommendationReason;
  score: number;
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
}

// Nombre minimum de titres notés/vus avant d'appliquer le profil de goûts
// (sinon trop peu de signal pour qu'une affinité calculée soit fiable) —
// voir critère d'acceptation "cold start".
const COLD_START_THRESHOLD = 5;
// Au-delà de ce nombre de rejets sans aucun avis positif, un genre/une
// décennie n'est plus proposé du tout (voir "seuil d'exclusion" du ticket).
// Volontairement élevé : un genre ne doit pas disparaître sur un ou deux
// rejets isolés.
const EXCLUSION_MIN_SAMPLES = 5;
const EXCLUSION_NEGATIVE_RATIO = 0.8;
// Centre de l'échelle de note (0-10, voir ratingTier.ts) : une note
// au-dessus devient un signal positif, en-dessous un signal négatif, à
// distance proportionnelle de l'écart.
const RATING_CENTER = 5.5;
const RATING_SPAN = 4.5;
// Pas plus de 2 suggestions consécutives du même genre dominant, pour
// garder de la variété dans la liste (voir "diversité" du ticket).
const MAX_CONSECUTIVE_SAME_GENRE = 2;

function decadeOf(dateStr: string | null | undefined): number | null {
  const year = dateStr ? Number(dateStr.slice(0, 4)) : NaN;
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return null;
  }
  return Math.floor(year / 10) * 10;
}

interface SignalWeight {
  genreIds: number[];
  decade: number | null;
  weight: number;
}

function signalsFromWatched(items: LibraryItem[]): SignalWeight[] {
  return items.map((item) => {
    const rating = typeof item.rating === "number" ? item.rating : null;
    // Vu sans note : léger positif (voir "signaux utilisés" du ticket).
    const weight = rating == null ? 0.3 : (rating - RATING_CENTER) / RATING_SPAN;
    return { genreIds: item.genreIds ?? [], decade: decadeOf(item.date), weight };
  });
}

function signalsFromWatchlist(items: LibraryItem[]): SignalWeight[] {
  // Intérêt déclaré, pas encore validé : positif modéré.
  return items.map((item) => ({
    genreIds: item.genreIds ?? [],
    decade: decadeOf(item.date),
    weight: 0.5,
  }));
}

function signalsFromNotInterested(items: NotInterestedRow[]): SignalWeight[] {
  return items.map((item) => ({
    genreIds: item.genreIds,
    decade: decadeOf(item.releaseDate),
    weight: -1,
  }));
}

export interface TasteProfile {
  genreScore: Map<number, number>;
  decadeScore: Map<number, number>;
  excludedGenreIds: Set<number>;
  excludedDecades: Set<number>;
  explicitlyExcludedGenreIds: Set<number>;
  seenKeys: Set<string>;
  isColdStart: boolean;
  topGenreIds: number[];
}

function accumulate(
  scores: Map<number, { positive: number; negative: number; total: number }>,
  key: number | null,
  weight: number
): void {
  if (key == null) {
    return;
  }
  const entry = scores.get(key) ?? { positive: 0, negative: 0, total: 0 };
  if (weight > 0) {
    entry.positive += weight;
  } else if (weight < 0) {
    entry.negative += -weight;
  }
  entry.total += weight;
  scores.set(key, entry);
}

export function buildTasteProfile(
  watched: LibraryItem[],
  watchlist: LibraryItem[],
  notInterested: NotInterestedRow[],
  explicitlyExcludedGenreIds: number[]
): TasteProfile {
  const signals = [
    ...signalsFromWatched(watched),
    ...signalsFromWatchlist(watchlist),
    ...signalsFromNotInterested(notInterested),
  ];

  const genreAgg = new Map<number, { positive: number; negative: number; total: number }>();
  const decadeAgg = new Map<number, { positive: number; negative: number; total: number }>();
  for (const signal of signals) {
    for (const genreId of signal.genreIds) {
      accumulate(genreAgg, genreId, signal.weight);
    }
    accumulate(decadeAgg, signal.decade, signal.weight);
  }

  const genreScore = new Map<number, number>();
  const excludedGenreIds = new Set<number>();
  for (const [genreId, agg] of genreAgg) {
    genreScore.set(genreId, agg.total);
    const samples = agg.positive + agg.negative;
    if (samples >= EXCLUSION_MIN_SAMPLES && agg.negative / samples >= EXCLUSION_NEGATIVE_RATIO) {
      excludedGenreIds.add(genreId);
    }
  }

  const decadeScore = new Map<number, number>();
  const excludedDecades = new Set<number>();
  for (const [decade, agg] of decadeAgg) {
    decadeScore.set(decade, agg.total);
    const samples = agg.positive + agg.negative;
    if (samples >= EXCLUSION_MIN_SAMPLES && agg.negative / samples >= EXCLUSION_NEGATIVE_RATIO) {
      excludedDecades.add(decade);
    }
  }

  const seenKeys = new Set<string>();
  for (const item of [...watched, ...watchlist]) {
    seenKeys.add(`${item.mediaType}:${item.id}`);
  }
  for (const item of notInterested) {
    seenKeys.add(`${item.mediaType}:${item.tmdbId}`);
  }

  const ratedOrWatchedCount = watched.length;
  const topGenreIds = [...genreScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id);

  return {
    genreScore,
    decadeScore,
    excludedGenreIds,
    excludedDecades,
    explicitlyExcludedGenreIds: new Set(explicitlyExcludedGenreIds),
    seenKeys,
    isColdStart: ratedOrWatchedCount < COLD_START_THRESHOLD,
    topGenreIds,
  };
}

export async function getRecommendationCandidates(
  env: Env,
  mediaType: RecommendationMediaType,
  limit = 200
): Promise<RecommendationCandidate[]> {
  const { results } = await env.DB.prepare(
    `SELECT tmdb_id, media_type, title, release_date, poster_path, popularity, vote_average, genre_ids
       FROM popular_titles
      WHERE media_type = ?
      ORDER BY popularity DESC
      LIMIT ?`
  )
    .bind(mediaType, limit)
    .all<PopularTitleRow>();
  return (results || []).map((row) => ({
    id: row.tmdb_id,
    mediaType: row.media_type as RecommendationMediaType,
    title: row.title,
    posterPath: row.poster_path,
    releaseDate: row.release_date,
    voteAverage: row.vote_average,
    popularity: row.popularity,
    genreIds: JSON.parse(row.genre_ids || "[]"),
  }));
}

function scoreCandidate(candidate: RecommendationCandidate, profile: TasteProfile): number {
  let score = 0;
  for (const genreId of candidate.genreIds) {
    score += profile.genreScore.get(genreId) ?? 0;
  }
  const decade = decadeOf(candidate.releaseDate);
  if (decade != null) {
    score += (profile.decadeScore.get(decade) ?? 0) * 0.5;
  }
  // Petit bonus pour vote_average, comme demandé par le ticket — pondéré
  // léger pour ne pas écraser l'affinité personnelle.
  if (candidate.voteAverage != null) {
    score += (candidate.voteAverage - 5) / 20;
  }
  return score;
}

function reasonFor(
  candidate: RecommendationCandidate,
  profile: TasteProfile
): RecommendationReason {
  const bestGenre = candidate.genreIds
    .map((id) => ({ id, score: profile.genreScore.get(id) ?? 0 }))
    .sort((a, b) => b.score - a.score)[0];
  if (bestGenre && bestGenre.score > 0) {
    return { kind: "genre", genreId: bestGenre.id };
  }
  const decade = decadeOf(candidate.releaseDate);
  if (decade != null && (profile.decadeScore.get(decade) ?? 0) > 0) {
    return { kind: "decade", decade };
  }
  return { kind: "trending" };
}

export interface RankOptions {
  limit?: number;
  excludeKeys?: Set<string>;
}

// Exclusions, score, puis fenêtre de diversité (jamais plus de
// MAX_CONSECUTIVE_SAME_GENRE suggestions consécutives du même genre
// dominant) — voir "diversité" du ticket.
export function rankRecommendations(
  candidates: RecommendationCandidate[],
  profile: TasteProfile,
  { limit = 20, excludeKeys }: RankOptions = {}
): RecommendationItem[] {
  const eligible = candidates.filter((candidate) => {
    const key = `${candidate.mediaType}:${candidate.id}`;
    if (profile.seenKeys.has(key) || excludeKeys?.has(key)) {
      return false;
    }
    if (candidate.genreIds.some((id) => profile.explicitlyExcludedGenreIds.has(id))) {
      return false;
    }
    if (candidate.genreIds.some((id) => profile.excludedGenreIds.has(id))) {
      return false;
    }
    const decade = decadeOf(candidate.releaseDate);
    if (decade != null && profile.excludedDecades.has(decade)) {
      return false;
    }
    return true;
  });

  const scored = eligible
    .map((candidate) => ({
      ...candidate,
      score: profile.isColdStart ? candidate.popularity : scoreCandidate(candidate, profile),
      reason: profile.isColdStart
        ? ({ kind: "trending" } as RecommendationReason)
        : reasonFor(candidate, profile),
    }))
    .sort((a, b) => b.score - a.score);

  const result: RecommendationItem[] = [];
  let consecutiveGenre: number | null = null;
  let consecutiveCount = 0;
  const deferred: RecommendationItem[] = [];
  for (const item of scored) {
    const dominantGenre = item.genreIds[0] ?? null;
    if (dominantGenre != null && dominantGenre === consecutiveGenre) {
      if (consecutiveCount >= MAX_CONSECUTIVE_SAME_GENRE) {
        deferred.push(item);
        continue;
      }
      consecutiveCount += 1;
    } else {
      consecutiveGenre = dominantGenre;
      consecutiveCount = 1;
    }
    result.push(item);
    if (result.length >= limit) {
      break;
    }
  }
  // Complète avec les titres mis de côté par la diversité si la limite
  // n'est pas atteinte (mieux qu'une liste trop courte).
  for (const item of deferred) {
    if (result.length >= limit) {
      break;
    }
    result.push(item);
  }
  return result;
}
