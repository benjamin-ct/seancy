// Petites fonctions d'accès à D1. Pas d'ORM : le schéma est simple (voir
// migrations/) et les requêtes préparées suffisent largement.
import { decodeHtmlEntities } from "./validate.ts";
import {
  getFollowCounts,
  getFollowedByViewerFollowing,
  getFollowers,
  getFollowing,
  isFollowing,
} from "./follows.ts";
import { getAvatar } from "./avatars.ts";
import { getRemindersForUser, type ReminderSummary } from "./reminders.ts";
import { SHARE_SLUG_PATTERN, USERNAME_PATTERN } from "./share-slug.ts";
import type {
  CleanCustomListMap,
  CleanGenrePref,
  CleanKey,
  CleanLibraryItem,
  CleanWatchlistItem,
  SyncDelete,
  SyncUpsert,
} from "./validate.ts";
import type { GenrePreferenceRow, SubscriptionRow, WatchlistItemRow } from "./types.ts";
import type {
  CustomListMap,
  LibraryItem,
  LibraryState,
  PublicProfile,
  PublicList,
} from "../src/core/types/library.ts";

// Compte connecté sur l'appareil au moment de l'abonnement (ou de son
// rattachement, voir linkSubscriptionToAccount) — null pour un visiteur
// anonyme. Voir migration 0008.
export interface SubscriptionAccount {
  userId: number;
  syncHost: string;
}

export async function upsertSubscription(
  db: D1Database,
  {
    endpoint,
    p256dh,
    auth,
    locale,
    account,
  }: {
    endpoint: string;
    p256dh: string;
    auth: string;
    locale: string;
    account: SubscriptionAccount | null;
  }
): Promise<number> {
  const existing = await db
    .prepare("SELECT id FROM subscriptions WHERE endpoint = ?")
    .bind(endpoint)
    .first<{ id: number }>();
  if (existing) {
    await db
      .prepare("UPDATE subscriptions SET locale = ?, user_id = ?, sync_host = ? WHERE id = ?")
      .bind(locale, account?.userId ?? null, account?.syncHost ?? null, existing.id)
      .run();
    return existing.id;
  }

  const result = await db
    .prepare(
      "INSERT INTO subscriptions (endpoint, p256dh, auth, created_at, locale, user_id, sync_host) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      endpoint,
      p256dh,
      auth,
      Date.now(),
      locale,
      account?.userId ?? null,
      account?.syncHost ?? null
    )
    .run();
  return Number(result.meta.last_row_id);
}

// Mise à jour de la langue d'un abonnement déjà actif, quand l'utilisateur
// change la langue de l'app après avoir activé les notifications (voir
// NotificationSettings) — sans repasser par un resubscribe complet.
export async function updateSubscriptionLocale(
  db: D1Database,
  endpoint: string,
  locale: string
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE subscriptions SET locale = ? WHERE endpoint = ?")
    .bind(locale, endpoint)
    .run();
  return (result.meta.changes || 0) > 0;
}

// Rattache l'abonnement de cet appareil au compte qui y est connecté, ou
// l'en détache (account null) après une déconnexion : un appareil déconnecté
// ne doit plus recevoir les notifications du compte.
export async function linkSubscriptionToAccount(
  db: D1Database,
  endpoint: string,
  account: SubscriptionAccount | null
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE subscriptions SET user_id = ?, sync_host = ? WHERE endpoint = ?")
    .bind(account?.userId ?? null, account?.syncHost ?? null, endpoint)
    .run();
  return (result.meta.changes || 0) > 0;
}

export async function deleteSubscription(db: D1Database, endpoint: string): Promise<void> {
  await db.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(endpoint).run();
}

export async function deleteSubscriptionById(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM subscriptions WHERE id = ?").bind(id).run();
}

// Remplace entièrement la liste "envie de voir" connue du serveur pour cet
// abonnement (le client est la source de vérité ; on synchronise à chaque
// changement plutôt que de tenter un diff incrémental côté serveur).
//
// Tous les remplacements de ce fichier placent le DELETE dans le MÊME
// db.batch que les INSERT : sur D1, un batch est une transaction, donc si une
// insertion échoue (limite, timeout, contrainte), la suppression est annulée
// au lieu d’effacer les données de l’utilisateur (audit C2, carte fQTc1y7a).
export async function replaceWatchlist(
  db: D1Database,
  subscriptionId: number,
  items: CleanWatchlistItem[]
): Promise<void> {
  const stmt = db.prepare(
    "INSERT INTO watchlist_items (subscription_id, media_type, tmdb_id, title, poster_path, known_providers) VALUES (?, ?, ?, ?, ?, ?)"
  );
  await db.batch([
    db.prepare("DELETE FROM watchlist_items WHERE subscription_id = ?").bind(subscriptionId),
    ...items.map((item) =>
      stmt.bind(
        subscriptionId,
        item.mediaType,
        item.tmdbId,
        item.title,
        item.posterPath || null,
        null
      )
    ),
  ]);
}

export async function replaceGenrePreferences(
  db: D1Database,
  subscriptionId: number,
  genres: CleanGenrePref[]
): Promise<void> {
  const stmt = db.prepare(
    "INSERT INTO genre_preferences (subscription_id, media_type, genre_id) VALUES (?, ?, ?)"
  );
  await db.batch([
    db.prepare("DELETE FROM genre_preferences WHERE subscription_id = ?").bind(subscriptionId),
    ...genres.map((g) => stmt.bind(subscriptionId, g.mediaType, g.genreId)),
  ]);
}

// Résout l'abonnement push depuis son endpoint (seul identifiant que le
// client anonyme connaît) — lookup indexé sur une seule ligne, pas un
// "lire toute la table pour diffs" : c'est une jointure FK normale, pas le
// pattern qu'on cherche à éliminer ci-dessous.
export async function getSubscriptionIdByEndpoint(
  db: D1Database,
  endpoint: string
): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM subscriptions WHERE endpoint = ?")
    .bind(endpoint)
    .first<{ id: number }>();
  return row?.id ?? null;
}

// Applique uniquement les ajouts/retraits fournis par le client (voir
// NotificationSettings : le client connaît son dernier état synchronisé et
// calcule lui-même le delta) — aucune lecture préalable de la table,
// contrairement à replaceWatchlist ci-dessus (toujours utilisée, mais
// seulement pour l'abonnement initial, un vrai remplacement complet).
// `known_providers` est délibérément absent du SET : sur un conflit (item
// déjà connu), on ne touche ni ne réinitialise cette colonne — seule
// knownProvidersUpdate() doit l'écrire. Seul un item réellement nouveau
// démarre à NULL (repli logique : "pas encore observé").
export async function applyWatchlistChanges(
  db: D1Database,
  subscriptionId: number,
  { add, remove }: { add: CleanWatchlistItem[]; remove: CleanKey[] }
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (add.length > 0) {
    const upsertStmt = db.prepare(
      `INSERT INTO watchlist_items (subscription_id, media_type, tmdb_id, title, poster_path, known_providers)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(subscription_id, media_type, tmdb_id) DO UPDATE SET
         title = excluded.title,
         poster_path = excluded.poster_path`
    );
    for (const item of add) {
      statements.push(
        upsertStmt.bind(
          subscriptionId,
          item.mediaType,
          item.tmdbId,
          item.title,
          item.posterPath || null
        )
      );
    }
  }
  if (remove.length > 0) {
    const deleteStmt = db.prepare(
      "DELETE FROM watchlist_items WHERE subscription_id = ? AND media_type = ? AND tmdb_id = ?"
    );
    for (const { mediaType, id } of remove) {
      statements.push(deleteStmt.bind(subscriptionId, mediaType, id));
    }
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }
}

export async function applyGenrePreferenceChanges(
  db: D1Database,
  subscriptionId: number,
  { add, remove }: { add: CleanGenrePref[]; remove: CleanKey[] }
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (add.length > 0) {
    // DO NOTHING plutôt que DO UPDATE : la clé (subscription, media_type,
    // genre_id) porte toute l'information, un conflit ne peut être qu'un
    // doublon inoffensif (ex. requête rejouée), rien à mettre à jour.
    const insertStmt = db.prepare(
      `INSERT INTO genre_preferences (subscription_id, media_type, genre_id) VALUES (?, ?, ?)
       ON CONFLICT(subscription_id, media_type, genre_id) DO NOTHING`
    );
    for (const g of add) {
      statements.push(insertStmt.bind(subscriptionId, g.mediaType, g.genreId));
    }
  }
  if (remove.length > 0) {
    const deleteStmt = db.prepare(
      "DELETE FROM genre_preferences WHERE subscription_id = ? AND media_type = ? AND genre_id = ?"
    );
    for (const g of remove) {
      statements.push(deleteStmt.bind(subscriptionId, g.mediaType, g.id));
    }
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }
}

export async function getAllSubscriptions(db: D1Database): Promise<SubscriptionRow[]> {
  const { results } = await db.prepare("SELECT * FROM subscriptions").all<SubscriptionRow>();
  return results;
}

export async function getSubscriptionsForUser(
  db: D1Database,
  userId: number
): Promise<SubscriptionRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ?")
    .bind(userId)
    .all<SubscriptionRow>();
  return results;
}

export async function getWatchlistForSubscription(
  db: D1Database,
  subscriptionId: number
): Promise<WatchlistItemRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM watchlist_items WHERE subscription_id = ?")
    .bind(subscriptionId)
    .all<WatchlistItemRow>();
  return results;
}

export async function getGenrePreferencesForSubscription(
  db: D1Database,
  subscriptionId: number
): Promise<GenrePreferenceRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM genre_preferences WHERE subscription_id = ?")
    .bind(subscriptionId)
    .all<GenrePreferenceRow>();
  return results;
}

// Nom affiché (ticket #45), mis à jour uniquement sur un save manuel côté
// client (voir AccountCard.tsx) — jamais de synchro automatique en tâche de
// fond.
export async function updateDisplayName(
  db: D1Database,
  userId: number,
  displayName: string
): Promise<void> {
  await db
    .prepare("UPDATE users SET display_name = ? WHERE id = ?")
    .bind(displayName || null, userId)
    .run();
}

// Partage public du profil (migration 0009) : `null` rend le profil privé et
// invalide l'ancien lien.
export async function setShareSlug(
  db: D1Database,
  userId: number,
  shareSlug: string | null
): Promise<void> {
  await db.prepare("UPDATE users SET share_slug = ? WHERE id = ?").bind(shareSlug, userId).run();
}

// Top 5 choisi à la main pour le profil partagé (migration 0011), ordre
// d'affichage conservé. Tableau vide = pas de choix (calcul automatique).
export const TOP_PICKS_MAX = 5;

function parseTopPicks(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === "string").slice(0, TOP_PICKS_MAX)
      : [];
  } catch {
    return [];
  }
}

export async function getTopPicks(db: D1Database, userId: number): Promise<string[]> {
  const row = await db
    .prepare("SELECT top_picks FROM users WHERE id = ?")
    .bind(userId)
    .first<{ top_picks: string | null }>();
  return parseTopPicks(row?.top_picks ?? null);
}

export async function setTopPicks(db: D1Database, userId: number, keys: string[]): Promise<void> {
  await db
    .prepare("UPDATE users SET top_picks = ? WHERE id = ?")
    .bind(keys.length ? JSON.stringify(keys) : null, userId)
    .run();
}

// Pseudo public (migration 0012). `username` doit déjà être normalisé
// (normalizeUsername) ; `null` le retire. Renvoie `false` si le pseudo est
// déjà pris : l'index unique tranche même quand deux comptes le demandent
// au même instant (la vérification de disponibilité côté client n'est
// qu'indicative).
export async function setUsername(
  db: D1Database,
  userId: number,
  username: string | null
): Promise<boolean> {
  try {
    await db.prepare("UPDATE users SET username = ? WHERE id = ?").bind(username, userId).run();
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      return false;
    }
    throw err;
  }
}

// Disponibilité d'un pseudo (déjà normalisé) pour `userId` : son propre
// pseudo actuel compte comme disponible.
export async function isUsernameAvailable(
  db: D1Database,
  username: string,
  userId: number
): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM users WHERE username = ?")
    .bind(username)
    .first<{ id: number }>();
  return !row || row.id === userId;
}

// Le détail des épisodes vus n'est pas exposé : la page publique n'affiche
// que les titres, affiches et notes.
function toPublicItem({ watchedEpisodes: _watchedEpisodes, ...item }: LibraryItem): LibraryItem {
  return item;
}

function byMostRecent(a: LibraryItem, b: LibraryItem): number {
  return (b.updatedAt || b.addedAt || 0) - (a.updatedAt || a.addedAt || 0);
}

// Profil partagé en lecture seule, résolu par le slug aléatoire ou par le
// pseudo (/u/<slug|pseudo> ; les deux formats sont disjoints, voir
// USERNAME_PATTERN). Jamais par un id ou un nom affiché, et le pseudo ne
// résout que les profils dont le partage est actif : un profil privé
// (share_slug NULL) est donc introuvable par construction. `viewerId` :
// compte connecté qui consulte la page (bouton Suivre/Suivi), null sinon.
export async function getPublicProfile(
  db: D1Database,
  handle: string,
  viewerId: number | null
): Promise<PublicProfile | null> {
  const query = SHARE_SLUG_PATTERN.test(handle)
    ? "SELECT id, display_name, username, share_slug, top_picks FROM users WHERE share_slug = ?"
    : USERNAME_PATTERN.test(handle)
      ? "SELECT id, display_name, username, share_slug, top_picks FROM users WHERE username = ? AND share_slug IS NOT NULL"
      : null;
  if (!query) {
    return null;
  }
  const user = await db.prepare(query).bind(handle).first<{
    id: number;
    display_name: string | null;
    username: string | null;
    share_slug: string;
    top_picks: string | null;
  }>();
  if (!user) {
    return null;
  }
  const other = viewerId !== null && viewerId !== user.id ? viewerId : null;
  const [library, customLists, counts, viewerFollows, followsViewer, followedBy] =
    await Promise.all([
      getLibraryForUser(db, user.id),
      getCustomListsForUser(db, user.id),
      getFollowCounts(db, user.id),
      other !== null ? isFollowing(db, other, user.id) : false,
      other !== null ? isFollowing(db, user.id, other) : false,
      other !== null ? getFollowedByViewerFollowing(db, user.id, other) : null,
    ]);
  // Les items des listes perso sont des copies figées au moment de l'ajout :
  // on y reporte la note portée par l'item « vu », comme sur une liste
  // partagée seule (getPublicListBySlug).
  const withRating = (item: LibraryItem): LibraryItem => ({
    ...item,
    rating: library.watched[`${item.mediaType}:${item.id}`]?.rating ?? null,
  });
  return {
    displayName: user.display_name,
    username: user.username,
    // Les endpoints abonnement/photo restent adressés par slug : le client
    // en a besoin même quand la page est ouverte via /u/<pseudo>.
    shareSlug: user.share_slug,
    // Un titre retiré des « vus » depuis sort du Top sans qu'il faille
    // réécrire la colonne.
    topPicks: parseTopPicks(user.top_picks).filter((key) => library.watched[key]),
    watched: Object.values(library.watched).map(toPublicItem).sort(byMostRecent),
    watchlist: Object.values(library.watchlist).map(toPublicItem).sort(byMostRecent),
    customLists: Object.values(customLists)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((list) => ({ ...list, items: list.items.map(toPublicItem).map(withRating) })),
    ...counts,
    viewerFollows,
    followsViewer,
    followedBy: followedBy ?? { profiles: [], total: 0 },
    isSelf: viewerId === user.id,
  };
}

// Email du compte derrière un profil partagé, uniquement pour résoudre sa
// photo Gravatar côté serveur (voir handleGetPublicProfileAvatar) : il ne
// quitte jamais le worker, pas même sous forme de hash.
export async function getSharedProfileEmail(
  db: D1Database,
  shareSlug: string
): Promise<string | null> {
  const row = await db
    .prepare("SELECT email FROM users WHERE share_slug = ?")
    .bind(shareSlug)
    .first<{ email: string }>();
  return row?.email ?? null;
}

// Bibliothèque "vu / envie de voir" synchronisée par compte. -------------

// Renvoie la bibliothèque au même format que l'état client (LibraryContext) :
// { watched: { "movie:123": {...} }, watchlist: { "tv:456": {...} } }.
export async function getLibraryForUser(db: D1Database, userId: number): Promise<LibraryState> {
  const { results } = await db
    .prepare(
      "SELECT media_type, tmdb_id, status, data, updated_at FROM library_items WHERE user_id = ?"
    )
    .bind(userId)
    .all<{
      media_type: string;
      tmdb_id: number;
      status: string;
      data: string;
      updated_at: number;
    }>();
  const watched: LibraryState["watched"] = {};
  const watchlist: LibraryState["watchlist"] = {};
  for (const row of results) {
    const key = `${row.media_type}:${row.tmdb_id}`;
    const item = { ...JSON.parse(row.data), updatedAt: row.updated_at };
    // Répare à la volée les titres encore corrompus par l'ancien bug de
    // double-échappement (voir decodeHtmlEntities) sans attendre une
    // prochaine écriture — la version propre est réécrite en base dès le
    // prochain PUT (toggle) puisque le client renvoie l'état reçu ici tel quel.
    if (typeof item.title === "string") {
      item.title = decodeHtmlEntities(item.title);
    }
    if (row.status === "watched") {
      watched[key] = item;
    } else {
      watchlist[key] = item;
    }
  }
  return { watched, watchlist };
}

// Pour chaque clé, garde l'entrée la plus récente (updatedAt) ; sinon garde
// celle qui existe. Même logique que mergeLists côté client
// (LibraryContext), dupliquée ici : voir replaceLibraryForUser ci-dessous
// pour le pourquoi.
function mergeLibraryList(
  a: Record<string, CleanLibraryItem>,
  b: Record<string, CleanLibraryItem>
): Record<string, CleanLibraryItem> {
  const merged: Record<string, CleanLibraryItem> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const itemA = a[key];
    const itemB = b[key];
    if (itemA && itemB) {
      merged[key] =
        (itemA.updatedAt || itemA.addedAt || 0) >= (itemB.updatedAt || itemB.addedAt || 0)
          ? itemA
          : itemB;
    } else {
      merged[key] = itemA || itemB;
    }
  }
  return merged;
}

// Fusionne avec la bibliothèque déjà en base plutôt que de la remplacer à
// l'aveugle : cet endpoint ne sert qu'à la toute première synchro sur un
// nouvel appareil (voir LibraryContext, SYNCED_FOR_KEY), donc le payload
// client a été construit à partir d'un GET potentiellement déjà périmé.
// Deux appareils qui se connectent au même compte à quelques secondes
// d'intervalle déclenchent chacun ce flux : sans cette fusion côté serveur,
// celui qui écrit en second efface intégralement ce que le premier venait
// d'envoyer (perte de données constatée en test — voir carte Trello
// Au5Ses9w).
export async function replaceLibraryForUser(
  db: D1Database,
  userId: number,
  { watched, watchlist }: LibraryState
): Promise<void> {
  const current = await getLibraryForUser(db, userId);
  const merged = {
    watched: mergeLibraryList(
      current.watched as unknown as Record<string, CleanLibraryItem>,
      (watched || {}) as unknown as Record<string, CleanLibraryItem>
    ),
    watchlist: mergeLibraryList(
      current.watchlist as unknown as Record<string, CleanLibraryItem>,
      (watchlist || {}) as unknown as Record<string, CleanLibraryItem>
    ),
  };

  const rows: Array<{
    mediaType: string;
    tmdbId: string;
    status: "watched" | "watchlist";
    item: CleanLibraryItem;
  }> = [];
  for (const [key, item] of Object.entries(merged.watched)) {
    const [mediaType, tmdbId] = key.split(":");
    rows.push({ mediaType, tmdbId, status: "watched", item: item as unknown as CleanLibraryItem });
  }
  for (const [key, item] of Object.entries(merged.watchlist)) {
    const [mediaType, tmdbId] = key.split(":");
    rows.push({
      mediaType,
      tmdbId,
      status: "watchlist",
      item: item as unknown as CleanLibraryItem,
    });
  }
  const stmt = db.prepare(
    "INSERT INTO library_items (user_id, media_type, tmdb_id, status, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  await db.batch([
    db.prepare("DELETE FROM library_items WHERE user_id = ?").bind(userId),
    ...rows.map(({ mediaType, tmdbId, status, item }) => {
      const { updatedAt, ...rest } = item;
      return stmt.bind(
        userId,
        mediaType,
        Number(tmdbId),
        status,
        JSON.stringify(rest),
        updatedAt || Date.now()
      );
    }),
  ]);
}

// Applique uniquement les items ajoutés/modifiés/retirés depuis le dernier
// envoi (voir LibraryContext : chaque toggle/notation/case cochée alimente
// une file d'opérations en attente) — aucune lecture préalable,
// contrairement à une hypothétique version qui diffuserait l'état complet
// à chaque appel. `replaceLibraryForUser` ci-dessus reste utilisée, mais
// uniquement pour la fusion initiale lors d'une première connexion sur un
// nouvel appareil (un vrai remplacement complet y est correct et rare).
export async function applyLibraryChanges(
  db: D1Database,
  userId: number,
  { upserts, deletes }: { upserts: SyncUpsert[]; deletes: SyncDelete[] }
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (upserts.length > 0) {
    const upsertStmt = db.prepare(
      `INSERT INTO library_items (user_id, media_type, tmdb_id, status, data, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, media_type, tmdb_id) DO UPDATE SET
         status = excluded.status,
         data = excluded.data,
         updated_at = excluded.updated_at`
    );
    for (const u of upserts) {
      const { updatedAt, ...rest } = u.item;
      statements.push(
        upsertStmt.bind(
          userId,
          u.mediaType,
          u.tmdbId,
          u.status,
          JSON.stringify(rest),
          updatedAt || Date.now()
        )
      );
    }
  }
  if (deletes.length > 0) {
    // Une suppression par ligne (pas de "WHERE tmdb_id IN (...)") : reste
    // sous la limite de paramètres liés par requête de D1 même pour un lot
    // volumineux, et garde chaque instruction du batch de forme identique.
    const deleteStmt = db.prepare(
      "DELETE FROM library_items WHERE user_id = ? AND media_type = ? AND tmdb_id = ?"
    );
    for (const d of deletes) {
      statements.push(deleteStmt.bind(userId, d.mediaType, d.id));
    }
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }
}

// Listes personnalisées synchronisées par compte. -----------------------

// Renvoie les listes perso au même format que l'état client (LibraryContext),
// items déjà triés par `position` (le tri manuel, voir migrations/).
export async function getCustomListsForUser(
  db: D1Database,
  userId: number
): Promise<CustomListMap> {
  const [{ results: listRows }, { results: itemRows }] = await Promise.all([
    db
      .prepare("SELECT id, name, created_at FROM custom_lists WHERE user_id = ?")
      .bind(userId)
      .all<{ id: string; name: string; created_at: number }>(),
    db
      .prepare(
        "SELECT list_id, media_type, tmdb_id, data FROM custom_list_items WHERE user_id = ? ORDER BY list_id, position"
      )
      .bind(userId)
      .all<{ list_id: string; media_type: string; tmdb_id: number; data: string }>(),
  ]);

  const customLists: CustomListMap = {};
  for (const row of listRows) {
    customLists[row.id] = { id: row.id, name: row.name, createdAt: row.created_at, items: [] };
  }
  for (const row of itemRows) {
    const list = customLists[row.list_id];
    if (!list) {
      continue;
    }
    const item = JSON.parse(row.data);
    if (typeof item.title === "string") {
      item.title = decodeHtmlEntities(item.title);
    }
    list.items.push(item);
  }
  return customLists;
}

// Remplacement complet volontaire, comme replaceLibraryForUser ci-dessus :
// contrairement à library_items (un toggle par item), une liste perso change
// par opérations qui touchent plusieurs lignes à la fois (création,
// renommage, glisser-déposer) — un vrai diff incrémental côté serveur
// n'apporterait rien ici vu l'échelle (usage personnel).
export async function replaceCustomListsForUser(
  db: D1Database,
  userId: number,
  customLists: CleanCustomListMap
): Promise<void> {
  const lists = Object.values(customLists || {});
  const listStmt = db.prepare(
    "INSERT INTO custom_lists (id, user_id, name, created_at) VALUES (?, ?, ?, ?)"
  );
  const itemStmt = db.prepare(
    "INSERT INTO custom_list_items (user_id, list_id, media_type, tmdb_id, data, position) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM custom_list_items WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM custom_lists WHERE user_id = ?").bind(userId),
  ];
  for (const list of lists) {
    statements.push(listStmt.bind(list.id, userId, list.name, list.createdAt));
    list.items.forEach((item: CleanLibraryItem, index: number) => {
      statements.push(
        itemStmt.bind(userId, list.id, item.mediaType, item.id, JSON.stringify(item), index)
      );
    });
  }
  await db.batch(statements);
}

// Partage des listes perso en lecture seule (migration 0010). -------------

// { listId: slug } pour toutes les listes partagées du compte.
export async function getListSharesForUser(
  db: D1Database,
  userId: number
): Promise<Record<string, string>> {
  const { results } = await db
    .prepare("SELECT list_id, slug FROM list_shares WHERE user_id = ?")
    .bind(userId)
    .all<{ list_id: string; slug: string }>();
  return Object.fromEntries(results.map((row) => [row.list_id, row.slug]));
}

// Idempotent : si la liste est déjà partagée, renvoie le slug existant (le
// lien a déjà pu être envoyé) plutôt que d'en créer un nouveau. Renvoie
// null si la liste n'existe pas (encore) côté serveur pour ce compte.
export async function shareListForUser(
  db: D1Database,
  userId: number,
  listId: string,
  newSlug: string
): Promise<string | null> {
  const list = await db
    .prepare("SELECT 1 FROM custom_lists WHERE user_id = ? AND id = ?")
    .bind(userId, listId)
    .first();
  if (!list) {
    return null;
  }
  await db
    .prepare(
      "INSERT INTO list_shares (slug, user_id, list_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, list_id) DO NOTHING"
    )
    .bind(newSlug, userId, listId, Date.now())
    .run();
  const row = await db
    .prepare("SELECT slug FROM list_shares WHERE user_id = ? AND list_id = ?")
    .bind(userId, listId)
    .first<{ slug: string }>();
  return row?.slug ?? null;
}

export async function unshareListForUser(
  db: D1Database,
  userId: number,
  listId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM list_shares WHERE user_id = ? AND list_id = ?")
    .bind(userId, listId)
    .run();
}

// Liste partagée, résolue UNIQUEMENT par son slug aléatoire. Chaque item
// porte la note que le propriétaire a donnée au titre (bibliothèque "vu"),
// pas celle éventuellement figée dans la liste au moment de l'ajout. Le
// détail des épisodes vus n'est jamais exposé.
export async function getPublicListBySlug(
  db: D1Database,
  slug: string,
  viewerUserId: number | null
): Promise<PublicList | null> {
  const share = await db
    .prepare(
      `SELECT list_shares.user_id, list_shares.list_id, custom_lists.name, custom_lists.created_at,
              users.display_name, users.share_slug, users.username
       FROM list_shares
       JOIN custom_lists ON custom_lists.user_id = list_shares.user_id AND custom_lists.id = list_shares.list_id
       JOIN users ON users.id = list_shares.user_id
       WHERE list_shares.slug = ?`
    )
    .bind(slug)
    .first<{
      user_id: number;
      list_id: string;
      name: string;
      created_at: number;
      display_name: string | null;
      share_slug: string | null;
      username: string | null;
    }>();
  if (!share) {
    return null;
  }
  const [{ results: itemRows }, { results: ratingRows }] = await Promise.all([
    db
      .prepare(
        "SELECT data FROM custom_list_items WHERE user_id = ? AND list_id = ? ORDER BY position"
      )
      .bind(share.user_id, share.list_id)
      .all<{ data: string }>(),
    db
      .prepare(
        "SELECT media_type, tmdb_id, json_extract(data, '$.rating') AS rating FROM library_items WHERE user_id = ? AND status = 'watched' AND json_extract(data, '$.rating') IS NOT NULL"
      )
      .bind(share.user_id)
      .all<{ media_type: string; tmdb_id: number; rating: number }>(),
  ]);
  const ratings = new Map(
    ratingRows.map((row) => [`${row.media_type}:${row.tmdb_id}`, row.rating])
  );
  const items = itemRows.map((row) => {
    const { watchedEpisodes: _watchedEpisodes, ...item } = JSON.parse(row.data) as LibraryItem;
    if (typeof item.title === "string") {
      item.title = decodeHtmlEntities(item.title);
    }
    return { ...item, rating: ratings.get(`${item.mediaType}:${item.id}`) ?? null };
  });
  return {
    name: share.name,
    ownerName: share.display_name,
    // Lien « Par X » vers le profil, seulement s'il est lui-même partagé.
    ownerHandle: share.share_slug ? (share.username ?? share.share_slug) : null,
    // Pas de date de modification en base : le dernier ajout fait foi.
    updatedAt: items.reduce((last, item) => Math.max(last, item.addedAt || 0), share.created_at),
    items,
    ...(viewerUserId === share.user_id ? { ownListId: share.list_id } : {}),
  };
}

// Genres exclus / plateformes favorites synchronisés par compte. ---------
// Même principe que la bibliothèque : remplacement complet à chaque appel
// (voir ExcludedGenresContext/FavoriteProvidersContext) — un simple id
// n'a pas d'historique à fusionner ligne à ligne comme un item de
// bibliothèque, un diff incrémental n'apporterait rien ici.
//
// `merge` (utilisé uniquement par la toute première synchro sur un nouvel
// appareil, voir SYNCED_FOR_KEY côté client) fait l'union avec ce qui est
// déjà en base plutôt que de remplacer à l'aveugle : deux appareils qui se
// connectent au même compte à quelques secondes d'intervalle envoient chacun
// un payload construit à partir d'un GET déjà périmé, et sans cette union
// celui qui écrit en second efface ce que le premier venait d'envoyer (même
// bug que la bibliothèque — voir replaceLibraryForUser). Les mises à jour
// normales (un genre/une plateforme qu'on décoche) doivent en revanche
// rester un vrai remplacement, sans quoi il deviendrait impossible de
// retirer un id déjà synchronisé — `merge` reste donc à `false` par défaut.

export async function getExcludedGenresForUser(db: D1Database, userId: number): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT genre_id FROM excluded_genre_prefs WHERE user_id = ?")
    .bind(userId)
    .all<{ genre_id: number }>();
  return results.map((row) => row.genre_id);
}

export async function replaceExcludedGenresForUser(
  db: D1Database,
  userId: number,
  genreIds: number[],
  merge = false
): Promise<void> {
  const finalIds = merge
    ? [...new Set([...(await getExcludedGenresForUser(db, userId)), ...genreIds])]
    : genreIds;
  const stmt = db.prepare("INSERT INTO excluded_genre_prefs (user_id, genre_id) VALUES (?, ?)");
  await db.batch([
    db.prepare("DELETE FROM excluded_genre_prefs WHERE user_id = ?").bind(userId),
    ...finalIds.map((id) => stmt.bind(userId, id)),
  ]);
}

export async function getFavoriteProvidersForUser(
  db: D1Database,
  userId: number
): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT provider_id FROM favorite_provider_prefs WHERE user_id = ?")
    .bind(userId)
    .all<{ provider_id: number }>();
  return results.map((row) => row.provider_id);
}

export async function replaceFavoriteProvidersForUser(
  db: D1Database,
  userId: number,
  providerIds: number[],
  merge = false
): Promise<void> {
  const finalProviderIds = merge
    ? [...new Set([...(await getFavoriteProvidersForUser(db, userId)), ...providerIds])]
    : providerIds;
  const stmt = db.prepare(
    "INSERT INTO favorite_provider_prefs (user_id, provider_id) VALUES (?, ?)"
  );
  await db.batch([
    db.prepare("DELETE FROM favorite_provider_prefs WHERE user_id = ?").bind(userId),
    ...finalProviderIds.map((id) => stmt.bind(userId, id)),
  ]);
}

export async function getFavoriteLanguagesForUser(
  db: D1Database,
  userId: number
): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT language_code FROM favorite_language_prefs WHERE user_id = ?")
    .bind(userId)
    .all<{ language_code: string }>();
  return results.map((row) => row.language_code);
}

export async function replaceFavoriteLanguagesForUser(
  db: D1Database,
  userId: number,
  languageCodes: string[],
  merge = false
): Promise<void> {
  const finalLanguageCodes = merge
    ? [...new Set([...(await getFavoriteLanguagesForUser(db, userId)), ...languageCodes])]
    : languageCodes;
  const stmt = db.prepare(
    "INSERT INTO favorite_language_prefs (user_id, language_code) VALUES (?, ?)"
  );
  await db.batch([
    db.prepare("DELETE FROM favorite_language_prefs WHERE user_id = ?").bind(userId),
    ...finalLanguageCodes.map((code) => stmt.bind(userId, code)),
  ]);
}

export async function getFavoriteCountriesForUser(
  db: D1Database,
  userId: number
): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT country_code FROM favorite_country_prefs WHERE user_id = ?")
    .bind(userId)
    .all<{ country_code: string }>();
  return results.map((row) => row.country_code);
}

export async function replaceFavoriteCountriesForUser(
  db: D1Database,
  userId: number,
  countryCodes: string[],
  merge = false
): Promise<void> {
  const finalCountryCodes = merge
    ? [...new Set([...(await getFavoriteCountriesForUser(db, userId)), ...countryCodes])]
    : countryCodes;
  const stmt = db.prepare(
    "INSERT INTO favorite_country_prefs (user_id, country_code) VALUES (?, ?)"
  );
  await db.batch([
    db.prepare("DELETE FROM favorite_country_prefs WHERE user_id = ?").bind(userId),
    ...finalCountryCodes.map((code) => stmt.bind(userId, code)),
  ]);
}

export async function getLocaleForUser(db: D1Database, userId: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT locale FROM users WHERE id = ?")
    .bind(userId)
    .first<{ locale: string | null }>();
  return row?.locale ?? null;
}

export async function setLocaleForUser(
  db: D1Database,
  userId: number,
  locale: string
): Promise<void> {
  await db.prepare("UPDATE users SET locale = ? WHERE id = ?").bind(locale, userId).run();
}

export async function getRegionForUser(db: D1Database, userId: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT region FROM users WHERE id = ?")
    .bind(userId)
    .first<{ region: string | null }>();
  return row?.region ?? null;
}

// Régions enregistrées de tous les comptes, pour le cron quotidien (une
// seule requête au lieu d'une par destinataire).
export async function getRegionsByUser(db: D1Database): Promise<Map<number, string>> {
  const { results } = await db
    .prepare("SELECT id, region FROM users WHERE region IS NOT NULL")
    .all<{ id: number; region: string }>();
  return new Map(results.map((row) => [row.id, row.region]));
}

export async function setRegionForUser(
  db: D1Database,
  userId: number,
  region: string
): Promise<void> {
  await db.prepare("UPDATE users SET region = ? WHERE id = ?").bind(region, userId).run();
}

export async function markNotified(
  db: D1Database,
  subscriptionId: number,
  mediaType: string,
  tmdbId: number,
  reason: string
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO notified_releases (subscription_id, media_type, tmdb_id, reason, notified_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(subscriptionId, mediaType, tmdbId, reason, Date.now())
    .run();
}

// Équivalent de markNotified au niveau du compte (voir migration 0008) :
// utilisé pour les abonnements rattachés à un compte.
export async function markUserNotified(
  db: D1Database,
  userId: number,
  mediaType: string,
  tmdbId: number,
  reason: string
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO user_notified_releases (user_id, media_type, tmdb_id, reason, notified_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(userId, mediaType, tmdbId, reason, Date.now())
    .run();
}

// Historique des notifications d'un destinataire (compte + ses abonnements),
// chargé en une fois par le cron au lieu d'un SELECT par titre et par motif
// (audit H5). Clés `${mediaType}:${tmdbId}:${reason}`.
export function notifiedKey(mediaType: string, tmdbId: number, reason: string): string {
  return `${mediaType}:${tmdbId}:${reason}`;
}

// D1 limite le nombre de paramètres liés par requête : les ids sont découpés.
const MAX_BOUND_IDS = 90;

export async function getNotifiedKeys(
  db: D1Database,
  userId: number | null,
  subscriptionIds: number[]
): Promise<Set<string>> {
  const statements: D1PreparedStatement[] = [];
  if (userId !== null) {
    statements.push(
      db
        .prepare("SELECT media_type, tmdb_id, reason FROM user_notified_releases WHERE user_id = ?")
        .bind(userId)
    );
  }
  for (let i = 0; i < subscriptionIds.length; i += MAX_BOUND_IDS) {
    const ids = subscriptionIds.slice(i, i + MAX_BOUND_IDS);
    statements.push(
      db
        .prepare(
          `SELECT media_type, tmdb_id, reason FROM notified_releases
           WHERE subscription_id IN (${ids.map(() => "?").join(", ")})`
        )
        .bind(...ids)
    );
  }
  const keys = new Set<string>();
  if (statements.length === 0) {
    return keys;
  }
  const results = await db.batch<{ media_type: string; tmdb_id: number; reason: string }>(
    statements
  );
  for (const { results: rows } of results) {
    for (const row of rows) {
      keys.add(notifiedKey(row.media_type, row.tmdb_id, row.reason));
    }
  }
  return keys;
}

// Référence des plateformes d'un titre de la watchlist : même contenu dans
// un autre ordre = pas de changement, donc pas d'écriture (audit H5).
export function providersChanged(stored: string | null, current: number[]): boolean {
  if (stored === null) {
    return true;
  }
  const previous: number[] = JSON.parse(stored);
  return (
    previous.length !== current.length ||
    [...previous].sort((a, b) => a - b).join(",") !== [...current].sort((a, b) => a - b).join(",")
  );
}

export function knownProvidersUpdate(
  db: D1Database,
  subscriptionId: number,
  mediaType: string,
  tmdbId: number,
  providerIds: number[]
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE watchlist_items SET known_providers = ? WHERE subscription_id = ? AND media_type = ? AND tmdb_id = ?"
    )
    .bind(JSON.stringify(providerIds), subscriptionId, mediaType, tmdbId);
}

// Parmi `keys` ("movie:123"…), celles que le compte a marquées vues : une
// requête ciblée plutôt que toute la bibliothèque (validation du top 5,
// audit M6).
export async function getWatchedKeys(
  db: D1Database,
  userId: number,
  keys: string[]
): Promise<Set<string>> {
  const pairs = keys
    .map((key) => key.split(":"))
    .filter(([mediaType, id]) => mediaType && Number.isInteger(Number(id)));
  if (pairs.length === 0) {
    return new Set();
  }
  const { results } = await db
    .prepare(
      `SELECT media_type, tmdb_id FROM library_items
       WHERE user_id = ? AND status = 'watched'
         AND (media_type, tmdb_id) IN (VALUES ${pairs.map(() => "(?, ?)").join(", ")})`
    )
    .bind(userId, ...pairs.flatMap(([mediaType, id]) => [mediaType, Number(id)]))
    .all<{ media_type: string; tmdb_id: number }>();
  return new Set(results.map((row) => `${row.media_type}:${row.tmdb_id}`));
}

// Suppression et export de compte en libre-service (audit M14). ----------

// Supprime définitivement le compte et tout ce qui lui est rattaché. Comme
// le reste de ce fichier (voir replaceLibraryForUser, replaceCustomListsForUser…),
// chaque table est vidée explicitement plutôt que de compter sur les `ON
// DELETE CASCADE` déclarés dans les migrations : un seul batch atomique,
// dans un ordre compatible avec les clés étrangères (tables filles d'abord).
// Les abonnements push du compte sont supprimés avec leurs lignes associées
// (watchlist_items/genre_preferences/notified_releases) plutôt que
// seulement détachés (user_id -> NULL) : contrairement à une déconnexion,
// la suppression de compte ne doit laisser aucune trace exploitable.
export async function deleteUserAccount(db: D1Database, userId: number): Promise<void> {
  await db.batch([
    db
      .prepare(
        "DELETE FROM watchlist_items WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = ?)"
      )
      .bind(userId),
    db
      .prepare(
        "DELETE FROM genre_preferences WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = ?)"
      )
      .bind(userId),
    db
      .prepare(
        "DELETE FROM notified_releases WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = ?)"
      )
      .bind(userId),
    db.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM user_notified_releases WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM reminders WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM user_avatars WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM email_changes WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM list_shares WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM follows WHERE follower_id = ? OR followed_id = ?").bind(userId, userId),
    db.prepare("DELETE FROM custom_list_items WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM custom_lists WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM library_items WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM excluded_genre_prefs WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM favorite_provider_prefs WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM favorite_language_prefs WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM favorite_country_prefs WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    // magic_links est indexé par email, pas par user_id : la sous-requête
    // doit s'exécuter avant la suppression de la ligne users ci-dessous.
    db
      .prepare("DELETE FROM magic_links WHERE email = (SELECT email FROM users WHERE id = ?)")
      .bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}

export interface AccountExport {
  account: {
    email: string;
    displayName: string | null;
    username: string | null;
    shareSlug: string | null;
    locale: string | null;
    region: string | null;
    topPicks: string[];
    createdAt: number;
  };
  library: LibraryState;
  customLists: CustomListMap;
  listShares: Record<string, string>;
  reminders: ReminderSummary[];
  excludedGenres: number[];
  favoriteProviders: number[];
  favoriteLanguages: string[];
  favoriteCountries: string[];
  following: { slug: string | null; displayName: string | null }[];
  followers: { slug: string | null; displayName: string | null }[];
  avatar: { contentType: string; dataBase64: string } | null;
}

// Encode un ArrayBuffer en base64 par blocs (une photo de profil fait au
// plus 300 Ko, voir AVATAR_MAX_BYTES, mais `String.fromCharCode(...bytes)`
// sur un tableau de cette taille risquerait de dépasser la limite d'arguments
// de la pile sur certains moteurs).
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Export complet des données du compte (RGPD, droit à la portabilité) : un
// seul objet JSON regroupant tout ce que les autres fonctions de ce fichier
// (et de follows.ts/avatars.ts/reminders.ts) savent lire pour ce compte.
export async function exportUserAccountData(
  db: D1Database,
  userId: number
): Promise<AccountExport | null> {
  const userRow = await db
    .prepare(
      "SELECT email, display_name, username, share_slug, locale, region, top_picks, created_at FROM users WHERE id = ?"
    )
    .bind(userId)
    .first<{
      email: string;
      display_name: string | null;
      username: string | null;
      share_slug: string | null;
      locale: string | null;
      region: string | null;
      top_picks: string | null;
      created_at: number;
    }>();
  if (!userRow) {
    return null;
  }
  const [
    library,
    customLists,
    listShares,
    reminders,
    excludedGenres,
    favoriteProviders,
    favoriteLanguages,
    favoriteCountries,
    followers,
    following,
    topPicks,
    avatar,
  ] = await Promise.all([
    getLibraryForUser(db, userId),
    getCustomListsForUser(db, userId),
    getListSharesForUser(db, userId),
    getRemindersForUser(db, userId),
    getExcludedGenresForUser(db, userId),
    getFavoriteProvidersForUser(db, userId),
    getFavoriteLanguagesForUser(db, userId),
    getFavoriteCountriesForUser(db, userId),
    // Soi-même comme visiteur : les compteurs "en commun"/"suit déjà" n'ont
    // pas de sens pour son propre export, mais les champs utiles (slug, nom
    // affiché) restent corrects.
    getFollowers(db, userId, userId),
    getFollowing(db, userId, userId),
    getTopPicks(db, userId),
    getAvatar(db, userId),
  ]);
  return {
    account: {
      email: userRow.email,
      displayName: userRow.display_name,
      username: userRow.username,
      shareSlug: userRow.share_slug,
      locale: userRow.locale,
      region: userRow.region,
      topPicks,
      createdAt: userRow.created_at,
    },
    library,
    customLists,
    listShares,
    reminders,
    excludedGenres,
    favoriteProviders,
    favoriteLanguages,
    favoriteCountries,
    following: following.map((p) => ({ slug: p.slug, displayName: p.displayName })),
    followers: followers.map((p) => ({ slug: p.slug, displayName: p.displayName })),
    avatar: avatar
      ? { contentType: avatar.contentType, dataBase64: arrayBufferToBase64(avatar.data) }
      : null,
  };
}
