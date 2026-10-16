import type { LibraryItem } from "../../core/types/library.ts";
import type { MediaItem } from "../../core/types/tmdb.ts";

// `LibraryItem` (bibliothèque personnelle : localStorage + D1) stocke ses
// champs en camelCase (`posterPath`, `date`, `genreIds`) — une forme propre
// au domaine "bibliothèque", distincte du `MediaItem` TMDB brut (snake_case :
// `poster_path`, `release_date`, `genre_ids`) que MediaCard sait afficher.
// Les deux se ressemblent mais ne sont PAS interchangeables : passer un
// LibraryItem directement là où un MediaItem est attendu ne lève aucune
// erreur (les deux formes ont un `id`/`title`/`mediaType`) mais MediaCard lit
// `item.poster_path`, toujours absent d'un LibraryItem — chaque carte retombe
// silencieusement sur son repli "pas d'affiche" (voir le ticket Trello
// "Toutes les affiches disparaissent dans l'onglet « Envie de voir »").
//
// Résultat mis en cache par objet : appelée dans le rendu des grilles
// (Ma liste, listes perso, profil et liste publics), une conversion neuve à
// chaque rendu donnait un nouvel `item` à chaque MediaCard et annulait son
// memo — toute la grille se re-rendait à chaque action ou glisser-déposer.
// Les mises à jour de la bibliothèque recopient l'état sans toucher aux
// titres inchangés, qui gardent donc le même objet et la même conversion.
const converted = new WeakMap<LibraryItem, MediaItem>();

export function libraryItemToMediaItem(item: LibraryItem): MediaItem {
  let mediaItem = converted.get(item);
  if (!mediaItem) {
    mediaItem = {
      id: item.id,
      mediaType: item.mediaType,
      title: item.title,
      release_date: item.date,
      poster_path: item.posterPath,
      genre_ids: item.genreIds,
    };
    converted.set(item, mediaItem);
  }
  return mediaItem;
}
