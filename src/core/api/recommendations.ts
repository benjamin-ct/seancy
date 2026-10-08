// Client pour les recommandations personnalisées "Pour toi" — tout le
// calcul vit côté Worker (voir worker/recommendations.ts) ; ce module ne
// fait qu'appeler l'API et adapter la forme de la réponse à `MediaItem`
// pour pouvoir réutiliser <MediaCard> tel quel.
import { syncClientHeaders } from "../sync/liveSync.ts";
import type { MediaItem, MediaType } from "../types/tmdb.ts";

export type RecommendationReason =
  { kind: "genre"; genreId: number } | { kind: "decade"; decade: number } | { kind: "trending" };

interface RecommendationApiItem {
  id: number;
  mediaType: MediaType;
  title: string;
  posterPath: string | null;
  releaseDate: string | null;
  voteAverage: number | null;
  popularity: number;
  genreIds: number[];
  reason: RecommendationReason;
}

export interface RecommendationMediaItem extends MediaItem {
  reason: RecommendationReason;
}

function toMediaItem(item: RecommendationApiItem): RecommendationMediaItem {
  return {
    id: item.id,
    media_type: item.mediaType,
    mediaType: item.mediaType,
    title: item.mediaType === "movie" ? item.title : undefined,
    name: item.mediaType === "tv" ? item.title : undefined,
    release_date: item.mediaType === "movie" ? (item.releaseDate ?? undefined) : undefined,
    first_air_date: item.mediaType === "tv" ? (item.releaseDate ?? undefined) : undefined,
    poster_path: item.posterPath,
    vote_average: item.voteAverage ?? undefined,
    popularity: item.popularity,
    genre_ids: item.genreIds,
    reason: item.reason,
  };
}

export class RecommendationsAuthError extends Error {}

// `type` omis ou "all" : films + séries mélangés (voir ticket, section
// "Interface" — filtres Films/Séries/les deux).
export async function getRecommendations(
  type: MediaType | "all" = "all",
  limit = 20,
  signal?: AbortSignal
): Promise<{ items: RecommendationMediaItem[]; coldStart: boolean }> {
  const params = new URLSearchParams({ type, limit: String(limit) });
  const res = await fetch(`/api/recommendations?${params}`, { signal });
  if (res.status === 401) {
    throw new RecommendationsAuthError("Non connecté.");
  }
  if (!res.ok) {
    throw new Error(`Erreur recommandations (${res.status})`);
  }
  const data = (await res.json()) as { items: RecommendationApiItem[]; coldStart: boolean };
  return { items: data.items.map(toMediaItem), coldStart: data.coldStart };
}

export async function postNotInterested(item: MediaItem): Promise<void> {
  const mediaType = item.mediaType ?? item.media_type;
  const releaseDate = item.release_date || item.first_air_date || null;
  const res = await fetch("/api/not-interested", {
    method: "POST",
    headers: { "content-type": "application/json", ...syncClientHeaders() },
    body: JSON.stringify({
      mediaType,
      tmdbId: item.id,
      genreIds: item.genre_ids ?? [],
      releaseDate,
    }),
  });
  if (!res.ok) {
    throw new Error(`Erreur "pas intéressé" (${res.status})`);
  }
}
