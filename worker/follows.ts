// Accès D1 du domaine "suivre des profils" (migration 0011). Règles de
// visibilité, appliquées ici plutôt qu'à chaque appelant :
// - on ne peut suivre qu'un profil partagé, résolu par son slug public ;
// - un profil devenu privé disparaît des listes d'abonnements, des
//   compteurs d'abonnements et du fil d'activité de ceux qui le suivent (la
//   ligne reste en base et réapparaît s'il repartage son profil) ;
// - un abonné au profil privé reste compté et listé chez la personne qu'il
//   suit, mais anonymisé (ni nom ni lien) : il n'a rien choisi de rendre
//   public.
import { decodeHtmlEntities } from "./validate.ts";
import type { EpisodeRef, LibraryItem } from "../src/core/types/library.ts";
import type {
  FeedEntry,
  FollowCounts,
  ProfileSummary,
  TitleActivity,
} from "../src/core/types/social.ts";

export const FEED_LIMIT = 60;
const LIST_LIMIT = 500;
const SEARCH_LIMIT = 20;

export async function getUserIdBySlug(db: D1Database, slug: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM users WHERE share_slug = ?")
    .bind(slug)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/** `true` si l'abonnement vient d'être créé (pas déjà existant). */
export async function follow(db: D1Database, followerId: number, followedId: number) {
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)"
    )
    .bind(followerId, followedId, Date.now())
    .run();
  return result.meta.changes > 0;
}

export async function unfollow(db: D1Database, followerId: number, followedId: number) {
  await db
    .prepare("DELETE FROM follows WHERE follower_id = ? AND followed_id = ?")
    .bind(followerId, followedId)
    .run();
}

export async function isFollowing(db: D1Database, followerId: number, followedId: number) {
  const row = await db
    .prepare("SELECT 1 AS found FROM follows WHERE follower_id = ? AND followed_id = ?")
    .bind(followerId, followedId)
    .first<{ found: number }>();
  return row !== null;
}

export async function getFollowCounts(db: D1Database, userId: number): Promise<FollowCounts> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM follows WHERE followed_id = ?1) AS followers,
         (SELECT COUNT(*) FROM follows JOIN users ON users.id = follows.followed_id
            WHERE follows.follower_id = ?1 AND users.share_slug IS NOT NULL) AS following`
    )
    .bind(userId)
    .first<FollowCounts>();
  return { followers: row?.followers ?? 0, following: row?.following ?? 0 };
}

// « Suivie par Tom, Inès et N autres personnes que vous suivez » : parmi les
// profils suivis par le visiteur (encore partagés), ceux qui suivent aussi
// `userId`. Les premiers noms seulement, plus le total.
const FOLLOWED_BY_PREVIEW = 3;

export async function getFollowedByViewerFollowing(
  db: D1Database,
  userId: number,
  viewerId: number
): Promise<{ profiles: { slug: string; displayName: string | null }[]; total: number }> {
  const from = `FROM follows mine
       JOIN follows theirs ON theirs.follower_id = mine.followed_id AND theirs.followed_id = ?1
       JOIN users ON users.id = mine.followed_id AND users.share_slug IS NOT NULL
       WHERE mine.follower_id = ?2 AND mine.followed_id <> ?1`;
  const [{ results }, count] = await Promise.all([
    db
      .prepare(
        `SELECT users.share_slug, users.display_name ${from}
         ORDER BY theirs.created_at DESC LIMIT ${FOLLOWED_BY_PREVIEW}`
      )
      .bind(userId, viewerId)
      .all<{ share_slug: string; display_name: string | null }>(),
    db
      .prepare(`SELECT COUNT(*) AS total ${from}`)
      .bind(userId, viewerId)
      .first<{ total: number }>(),
  ]);
  return {
    profiles: results.map((row) => ({ slug: row.share_slug, displayName: row.display_name })),
    total: count?.total ?? 0,
  };
}

interface SummaryRow {
  id: number;
  share_slug: string | null;
  display_name: string | null;
  viewer_follows: number;
  watched_count: number;
  common_count: number;
}

function toSummary(row: SummaryRow, viewerId: number | null): ProfileSummary {
  const isPublic = row.share_slug !== null;
  return {
    slug: row.share_slug,
    displayName: isPublic ? row.display_name : null,
    viewerFollows: row.viewer_follows === 1,
    isSelf: row.id === viewerId,
    // Un profil privé n'expose rien de sa bibliothèque, pas même un compteur.
    watchedCount: isPublic ? row.watched_count : null,
    commonCount: isPublic && viewerId !== null && row.id !== viewerId ? row.common_count : null,
  };
}

// `viewer_follows` : le visiteur connecté (ou personne, id -1) suit-il ce
// profil ? Calculé dans la même requête pour afficher directement le bon
// bouton Suivre/Suivi dans la liste.
const VIEWER_FOLLOWS = `EXISTS (SELECT 1 FROM follows v WHERE v.follower_id = ?2 AND v.followed_id = users.id)`;

// « N vus · N en commun avec vous » (modale « Réseau de X ») : titres vus du
// profil, et ceux que le visiteur (id -1 s'il n'est pas connecté) a vus aussi.
// Comptés sur l'index library_items(user_id, status, media_type, tmdb_id)
// (migration 0017) sans lire les lignes elles-mêmes (audit M6).
const WATCHED_COUNTS = `(SELECT COUNT(*) FROM library_items w
    WHERE w.user_id = users.id AND w.status = 'watched') AS watched_count,
  (SELECT COUNT(*) FROM library_items w
    JOIN library_items c ON c.user_id = ?2 AND c.status = 'watched'
      AND c.media_type = w.media_type AND c.tmdb_id = w.tmdb_id
    WHERE w.user_id = users.id AND w.status = 'watched') AS common_count`;

export async function getFollowers(
  db: D1Database,
  userId: number,
  viewerId: number | null
): Promise<ProfileSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT users.id, users.share_slug, users.display_name, ${VIEWER_FOLLOWS} AS viewer_follows,
              ${WATCHED_COUNTS}
       FROM follows JOIN users ON users.id = follows.follower_id
       WHERE follows.followed_id = ?1
       ORDER BY follows.created_at DESC LIMIT ${LIST_LIMIT}`
    )
    .bind(userId, viewerId ?? -1)
    .all<SummaryRow>();
  return results.map((row) => toSummary(row, viewerId));
}

export async function getFollowing(
  db: D1Database,
  userId: number,
  viewerId: number | null
): Promise<ProfileSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT users.id, users.share_slug, users.display_name, ${VIEWER_FOLLOWS} AS viewer_follows,
              ${WATCHED_COUNTS}
       FROM follows JOIN users ON users.id = follows.followed_id
       WHERE follows.follower_id = ?1 AND users.share_slug IS NOT NULL
       ORDER BY follows.created_at DESC LIMIT ${LIST_LIMIT}`
    )
    .bind(userId, viewerId ?? -1)
    .all<SummaryRow>();
  return results.map((row) => toSummary(row, viewerId));
}

// Recherche par nom affiché, limitée aux profils partagés (un profil privé
// n'est jamais trouvable). LIKE insensible à la casse pour l'ASCII ; les
// jokers saisis par l'utilisateur sont échappés.
export async function searchProfiles(
  db: D1Database,
  query: string,
  viewerId: number
): Promise<ProfileSummary[]> {
  const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { results } = await db
    .prepare(
      `SELECT users.id, users.share_slug, users.display_name, ${VIEWER_FOLLOWS} AS viewer_follows,
              ${WATCHED_COUNTS}
       FROM users
       WHERE users.share_slug IS NOT NULL AND users.id <> ?2
         AND users.display_name LIKE ?1 ESCAPE '\\'
       ORDER BY users.display_name COLLATE NOCASE LIMIT ${SEARCH_LIMIT}`
    )
    .bind(pattern, viewerId)
    .all<SummaryRow>();
  return results.map((row) => toSummary(row, viewerId));
}

// Fil d'activité : dernières entrées "vu" / "envie de voir" des profils
// suivis encore partagés, du plus récent au plus ancien. `updated_at` bouge
// aussi quand un titre est noté : une note récente remonte donc le titre.
// Les FEED_LIMIT plus récentes du fil sont forcément parmi les FEED_LIMIT
// plus récentes de chaque profil : seules celles-là sont lues, via l'index
// (user_id, updated_at), au lieu de toute la bibliothèque de chaque profil
// suivi (audit M6). Aucune entrée ne peut donc manquer au fil.
export async function getFeed(db: D1Database, userId: number): Promise<FeedEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT users.share_slug, users.display_name, library_items.status,
              library_items.data, library_items.updated_at
       FROM follows
       JOIN users ON users.id = follows.followed_id AND users.share_slug IS NOT NULL
       JOIN library_items ON library_items.rowid IN (
         SELECT recent.rowid FROM library_items recent
         WHERE recent.user_id = users.id
         ORDER BY recent.updated_at DESC LIMIT ${FEED_LIMIT}
       )
       WHERE follows.follower_id = ?
       ORDER BY CASE WHEN library_items.status = 'watched'
                  THEN COALESCE(json_extract(library_items.data, '$.watchedAt'), library_items.updated_at)
                  ELSE library_items.updated_at END DESC
       LIMIT ${FEED_LIMIT}`
    )
    .bind(userId)
    .all<{
      share_slug: string;
      display_name: string | null;
      status: "watched" | "watchlist";
      data: string;
      updated_at: number;
    }>();
  return results.map((row) => {
    const { watchedEpisodes: _watchedEpisodes, ...item } = JSON.parse(row.data) as LibraryItem;
    // Un titre "vu" daté dans le passé (voir LibraryContext, toggleWatched) doit
    // apparaître comme tel dans le fil — pas comme "à l'instant" sous prétexte
    // que c'est maintenant qu'il a été coché (cf. ticket "ne pas spammer mes
    // contacts de récemment vu par").
    const effectiveDate =
      row.status === "watched" && typeof item.watchedAt === "number"
        ? item.watchedAt
        : row.updated_at;
    return {
      profile: { slug: row.share_slug, displayName: row.display_name },
      status: row.status,
      item: {
        ...item,
        title: typeof item.title === "string" ? decodeHtmlEntities(item.title) : item.title,
        updatedAt: effectiveDate,
      },
    };
  });
}

// Bloc « Vos abonnements » de la fiche : ce que les profils suivis (encore
// partagés) ont fait d'un titre précis — vu (avec leur note) ou envie de
// voir. `following` sert au client pour masquer le bloc quand on ne suit
// personne (et seulement dans ce cas).
// Dernier épisode vu au sens chronologique (hors épisodes spéciaux, saison
// 0), à partir des clés "saison-épisode" de `watchedEpisodes`.
function lastWatchedEpisode(keys: string[] | undefined): EpisodeRef | null {
  let last: EpisodeRef | null = null;
  for (const key of Array.isArray(keys) ? keys : []) {
    const [seasonNumber, episodeNumber] = String(key).split("-").map(Number);
    if (!(seasonNumber > 0) || !(episodeNumber > 0)) {
      continue;
    }
    if (
      !last ||
      seasonNumber > last.seasonNumber ||
      (seasonNumber === last.seasonNumber && episodeNumber > last.episodeNumber)
    ) {
      last = { seasonNumber, episodeNumber };
    }
  }
  return last;
}

export async function getTitleActivity(
  db: D1Database,
  userId: number,
  mediaType: string,
  tmdbId: number
): Promise<TitleActivity> {
  const [counts, { results }] = await Promise.all([
    getFollowCounts(db, userId),
    db
      .prepare(
        `SELECT users.share_slug, users.display_name, library_items.status, library_items.data,
                library_items.updated_at
         FROM follows
         JOIN users ON users.id = follows.followed_id AND users.share_slug IS NOT NULL
         JOIN library_items ON library_items.user_id = users.id
           AND library_items.media_type = ? AND library_items.tmdb_id = ?
         WHERE follows.follower_id = ?
         ORDER BY library_items.status = 'watched' DESC,
                  CASE WHEN library_items.status = 'watched'
                    THEN COALESCE(json_extract(library_items.data, '$.watchedAt'), library_items.updated_at)
                    ELSE library_items.updated_at END DESC
         LIMIT ${LIST_LIMIT}`
      )
      .bind(mediaType, tmdbId, userId)
      .all<{
        share_slug: string;
        display_name: string | null;
        status: "watched" | "watchlist";
        data: string;
        updated_at: number;
      }>(),
  ]);
  return {
    following: counts.following,
    entries: results.map((row) => {
      const { rating, watchedEpisodes, watchedAt } = JSON.parse(row.data) as LibraryItem;
      const effectiveDate =
        row.status === "watched" && typeof watchedAt === "number" ? watchedAt : row.updated_at;
      return {
        profile: { slug: row.share_slug, displayName: row.display_name },
        status: row.status,
        rating: row.status === "watched" && typeof rating === "number" ? rating : null,
        updatedAt: effectiveDate,
        progress: row.status === "watchlist" ? lastWatchedEpisode(watchedEpisodes) : null,
      };
    }),
  };
}
