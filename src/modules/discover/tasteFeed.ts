// Suite du défilement "Pour toi" une fois le lot personnalisé épuisé :
// titres de TMDB /discover sur les genres préférés du profil (voir
// buildTasteContinuation, worker/recommendations.ts), filtrés ici comme le
// lot (titres déjà vus, dans la liste, écartés ou déjà affichés, décennies
// écartées) et marqués d'une raison, pour garder le libellé de genre et le
// bouton "je ne veux pas voir" de la grille personnalisée.
import type { RecommendationMediaItem, TasteContinuation } from "../../core/api/recommendations.ts";
import type { MediaSummary, MediaType } from "../../core/types/tmdb.ts";

function decadeOf(date: string | undefined): number | null {
  const year = date ? Number(date.slice(0, 4)) : NaN;
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return null;
  }
  return Math.floor(year / 10) * 10;
}

export function toTasteItems(
  results: MediaSummary[],
  mediaType: MediaType,
  continuation: TasteContinuation,
  isHidden: (id: number) => boolean
): RecommendationMediaItem[] {
  const excludedIds = new Set(continuation.excludeIds);
  const excludedDecades = new Set(continuation.excludeDecades);
  return results.flatMap((result) => {
    if (excludedIds.has(result.id) || isHidden(result.id)) {
      return [];
    }
    const decade = decadeOf(result.release_date || result.first_air_date);
    if (decade != null && excludedDecades.has(decade)) {
      return [];
    }
    // Genre préféré le mieux classé parmi ceux du titre (/discover en OU en
    // garantit au moins un).
    const genreIds = result.genre_ids ?? [];
    const genreId = continuation.genreIds.find((id) => genreIds.includes(id));
    if (genreId == null) {
      return [];
    }
    return [{ ...result, mediaType, reason: { kind: "genre" as const, genreId } }];
  });
}
