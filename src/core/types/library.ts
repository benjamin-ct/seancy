// Types du domaine "bibliothèque personnelle" (déjà vu / envie de voir /
// listes personnalisées) — forme partagée entre LibraryContext, le worker
// (validation, D1) et tous les modules qui affichent ces données.
import type { MediaType } from "./tmdb.ts";

export interface DirectorRef {
  id: number;
  name: string;
}

/** Item minimal transmis par les pages lors d'un toggle "vu"/"envie de voir" —
 * voir chaque module (Detail, MediaCard...) pour la construction de cette forme. */
export interface LibraryItemInput {
  id: number;
  mediaType: MediaType;
  title: string;
  posterPath: string | null;
  date?: string;
  genreIds?: number[];
  runtimeMinutes?: number | null;
}

/** Item tel que stocké (localStorage + D1) : `LibraryItemInput` enrichi des
 * métadonnées propres au suivi (note, épisodes vus, horodatage...). */
export interface LibraryItem extends LibraryItemInput {
  addedAt: number;
  updatedAt: number;
  /** Date réelle de visionnage, choisie par l'utilisateur (sinon vu "aujourd'hui" :
   * absent, les stats/recommandations retombent alors sur `addedAt`). Sert aussi à
   * ne pas faire apparaître comme "récent" dans le fil social un film vu il y a
   * longtemps mais coché aujourd'hui. */
  watchedAt?: number;
  rating?: number | null;
  /** Uniquement pour les séries — clés "saison-épisode", ex. "1-5". */
  watchedEpisodes?: string[];
  directors?: DirectorRef[];
}

/** Un épisode de série (clé "saison-épisode" dans `watchedEpisodes`). */
export interface EpisodeRef {
  seasonNumber: number;
  episodeNumber: number;
}

export type LibraryItemMap = Record<string, LibraryItem>;

export interface LibraryState {
  watched: LibraryItemMap;
  watchlist: LibraryItemMap;
}

export interface CustomList {
  id: string;
  name: string;
  /** Items stockés directement ici (pas juste des clés vers watched/watchlist) :
   * une liste perso doit fonctionner pour un titre jamais marqué "vu" ni
   * "envie de voir". L'ordre du tableau porte aussi le tri manuel. */
  items: LibraryItem[];
  createdAt: number;
}

export type CustomListMap = Record<string, CustomList>;

/** Profil partagé en lecture seule (GET /api/public-profile/:slug) : jamais
 * d'email ni d'identifiant de compte, uniquement ce que le propriétaire a
 * choisi de rendre visible en activant le partage. Items triés du plus
 * récent au plus ancien, sans le détail des épisodes vus. */
export interface PublicProfile {
  displayName: string | null;
  /** Top 5 choisi à la main (clés "mediaType:id" présentes dans `watched`,
   * dans l'ordre) ; vide = calcul automatique à partir des notes. */
  topPicks: string[];
  username: string | null;
  /** Slug canonique du partage, même quand la page est ouverte via
   * /u/<pseudo> : c'est lui qu'utilisent les endpoints abonnement/photo. */
  shareSlug: string;
  watched: LibraryItem[];
  watchlist: LibraryItem[];
  customLists: CustomList[];
  /** Compteurs d'abonnés / d'abonnements (voir core/types/social.ts). */
  followers: number;
  following: number;
  /** Relation avec le visiteur, s'il est connecté (sinon `false`). */
  viewerFollows: boolean;
  /** Ce profil suit le visiteur connecté (badge « Vous suit »). */
  followsViewer: boolean;
  /** Profils suivis par le visiteur qui suivent aussi ce profil (« Suivie
   * par Tom, Inès et N autres… ») : les premiers seulement + le total. */
  followedBy: { profiles: { slug: string; displayName: string | null }[]; total: number };
  isSelf: boolean;
}

/** Liste perso partagée en lecture seule (GET /api/public-list/:slug) : jamais
 * d'email ni d'identifiant de compte. `rating` de chaque item = note donnée
 * par le propriétaire de la liste (s'il a marqué le titre comme vu).
 * `ownListId` n'est renseigné que si le visiteur EST le propriétaire, pour le
 * renvoyer vers sa vue éditable. */
export interface PublicList {
  name: string;
  ownerName: string | null;
  /** Pseudo (ou slug) du profil public du propriétaire, `null` s'il est privé. */
  ownerHandle: string | null;
  /** Dernier ajout dans la liste (ou sa création), en ms. */
  updatedAt: number;
  items: LibraryItem[];
  ownListId?: string;
}
