// Types du domaine "suivre des profils" (abonnés / abonnements / fil
// d'activité) — forme partagée entre le worker (worker/follows.ts) et le
// client (core/api/follows.ts, composants shared/components/Follow*).
import type { EpisodeRef, LibraryItem } from "./library.ts";

/** Un profil dans une liste d'abonnés/abonnements ou un résultat de
 * recherche. Jamais d'email ni d'identifiant de compte : `slug` et
 * `displayName` sont `null` pour un compte dont le profil est privé (il
 * apparaît alors comme « profil privé », sans lien). */
export interface ProfileSummary {
  slug: string | null;
  displayName: string | null;
  /** Le visiteur connecté suit déjà ce profil. */
  viewerFollows: boolean;
  /** Ce profil est celui du visiteur connecté. */
  isSelf: boolean;
  /** Titres vus par ce profil (`null` s'il est privé). */
  watchedCount: number | null;
  /** Titres vus à la fois par ce profil et par le visiteur connecté
   * (`null` hors connexion, pour soi-même ou pour un profil privé). */
  commonCount: number | null;
}

export interface FollowCounts {
  followers: number;
  following: number;
}

/** Une activité d'un profil suivi : titre vu (avec sa note éventuelle) ou
 * ajouté en « envie de voir ». Items sans le détail des épisodes vus. */
export interface FeedEntry {
  profile: { slug: string; displayName: string | null };
  status: "watched" | "watchlist";
  item: LibraryItem;
}

/** Ce que les profils suivis ont fait d'un titre donné (fiche détail, bloc
 * « Vos abonnements ») : `following` = nombre de profils suivis, pour
 * distinguer « ne suit personne » (bloc masqué) de « personne ne l'a vu ». */
export interface TitleActivity {
  following: number;
  entries: {
    profile: { slug: string; displayName: string | null };
    status: "watched" | "watchlist";
    /** Note sur 10, seulement pour un titre vu et noté. */
    rating: number | null;
    /** Avis texte libre, seulement pour un titre vu et commenté. */
    reviewText: string | null;
    /** Dernière mise à jour (ms) : « il y a 3 jours ». */
    updatedAt: number;
    /** Série entamée (encore en « envie de voir ») : dernier épisode vu,
     * pour « En cours · S2 É2 ». Seul ce repère est exposé, jamais la liste
     * des épisodes vus. */
    progress: EpisodeRef | null;
  }[];
}
