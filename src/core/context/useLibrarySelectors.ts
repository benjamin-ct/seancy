// Sélecteurs fins pour la bibliothèque — voir libraryStore.ts pour le
// pourquoi. Un composant qui n'utilise QUE ces hooks (ex. MediaCard) ne se
// re-rend que si le statut de SON titre change, pas à chaque action sur la
// bibliothèque entière.
import { useSyncExternalStore } from "react";
import { getLibrarySnapshot, subscribeToLibrary } from "./libraryStore.ts";
import type { MediaType } from "../types/tmdb.ts";

function makeKey(mediaType: MediaType, id: number | string): string {
  return `${mediaType}:${id}`;
}

export function useIsWatched(mediaType: MediaType, id: number | string): boolean {
  const key = makeKey(mediaType, id);
  return useSyncExternalStore(subscribeToLibrary, () => Boolean(getLibrarySnapshot().watched[key]));
}

export function useIsInWatchlist(mediaType: MediaType, id: number | string): boolean {
  const key = makeKey(mediaType, id);
  return useSyncExternalStore(subscribeToLibrary, () =>
    Boolean(getLibrarySnapshot().watchlist[key])
  );
}
