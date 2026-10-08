import type { MediaItem, MediaSummary, MediaType } from "../../core/types/tmdb.ts";

// Résultat TMDB complété de son `mediaType` pour MediaCard (recommandations
// d'une fiche, filmographie d'une personne). Même objet d'un rendu à
// l'autre, mis en cache par résultat : un `{ ...item, mediaType }` écrit
// dans le rendu donnait un nouvel `item` à chaque fois et annulait le memo
// de MediaCard (toute la grille se re-rendait à chaque action sur la
// fiche, ou à chaque « Voir plus » de la filmographie).
const withMediaType = new WeakMap<MediaSummary, MediaItem>();

export function toMediaItem(item: MediaSummary, fallbackType: MediaType): MediaItem {
  const mediaType = item.media_type || fallbackType;
  let mediaItem = withMediaType.get(item);
  if (!mediaItem || mediaItem.mediaType !== mediaType) {
    mediaItem = { ...item, mediaType };
    withMediaType.set(item, mediaItem);
  }
  return mediaItem;
}
