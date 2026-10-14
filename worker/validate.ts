// Validation côté serveur de la bibliothèque envoyée par le client
// (PUT /api/library) — le frontend ne doit jamais être la seule ligne de
// défense sur ce que la base accepte d'écrire. Toute clé non listée ici est
// silencieusement supprimée (whitelist), tout item structurellement invalide
// est écarté plutôt que de faire échouer toute la requête.

import { isMediaType } from "../src/core/validation/mediaType.ts";

const MAX_STRING_LENGTH = 300;
const MAX_ITEMS_PER_LIST = 5000; // large marge au-dessus d'un usage réel, évite un abus qui gonflerait la base indéfiniment
// "saison-épisode" (ex. "1-5") : suivi épisode par épisode pour les séries.
// Aucune série connue ne dépasse quelques centaines d'épisodes, 5000 laisse
// une large marge sans permettre un payload disproportionné.
const MAX_WATCHED_EPISODES = 5000;
const EPISODE_KEY_PATTERN = /^\d{1,4}-\d{1,4}$/;
// Réalisateur·rices/créateur·rices d'un titre (voir Stats, "réalisateurs
// récurrents") — un film a rarement plus de 2-3 co-réalisateurs, une série
// peut avoir plusieurs créateurs ; 10 laisse une large marge.
const MAX_DIRECTORS = 10;
const DIRECTOR_NAME_MAX_LENGTH = 150;

const HTML_ENTITY_DECODES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};
const HTML_ENTITY_PATTERN = /&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g;
const MAX_DECODE_PASSES = 50;

export type MediaTypeStr = "movie" | "tv";

export interface CleanDirector {
  id: number;
  name: string;
}

export interface CleanLibraryItem {
  id: number;
  mediaType: MediaTypeStr;
  title: string;
  posterPath: string | null;
  date: string | undefined;
  genreIds: number[];
  addedAt: number;
  updatedAt: number;
  watchedAt?: number;
  rating?: number;
  runtimeMinutes?: number;
  watchedEpisodes: string[];
  directors: CleanDirector[];
}

export type CleanLibraryList = Record<string, CleanLibraryItem>;

// Décode les entités HTML jusqu'à stabilité. Ce champ était auparavant
// HTML-échappé à l'écriture — mais comme le client renvoie systématiquement
// la bibliothèque entière à chaque toggle, y compris les titres déjà
// échappés reçus du serveur au tour précédent, chaque sync réappliquait
// l'échappement sur du texte déjà échappé et faisait grossir indéfiniment
// les entités. On ne stocke plus que du texte brut : React échappe déjà
// tout ce qui est affiché en JSX (aucun composant n'utilise
// dangerouslySetInnerHTML avec ces champs), donc l'échappement ici
// n'apportait aucune protection réelle tout en corrompant les données. Ce
// décodage répété sert aussi à réparer les titres déjà corrompus par
// l'ancien comportement, dès la prochaine écriture.
export function decodeHtmlEntities(value: string): string {
  let out = value;
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    const next = out.replace(HTML_ENTITY_PATTERN, (m) => HTML_ENTITY_DECODES[m]);
    if (next === out) {
      break;
    }
    out = next;
  }
  return out;
}

function cleanString(value: unknown, maxLength = MAX_STRING_LENGTH): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = decodeHtmlEntities(value.slice(0, maxLength));
  return trimmed || null;
}

function cleanNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Un élément de `directors` : { id, name }. `id` sert à dédupliquer/compter
// les occurrences, `name` n'est affiché que via JSX (React échappe déjà
// tout ce qui est rendu) donc pas besoin d'un traitement plus strict que le
// nettoyage/troncature déjà appliqué aux autres champs texte.
function cleanDirector(raw: unknown): CleanDirector | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const id = cleanNumber(r.id);
  if (id === null || id <= 0) {
    return null;
  }
  const name = cleanString(r.name, DIRECTOR_NAME_MAX_LENGTH);
  if (!name) {
    return null;
  }
  return { id, name };
}

// Renvoie l'item nettoyé (sous-ensemble whitelisté, types coercés/validés),
// ou null si l'item n'est pas exploitable (id/mediaType manquants ou
// invalides — le reste a des valeurs de repli raisonnables).
function sanitizeItem(mediaType: string, tmdbId: unknown, raw: unknown): CleanLibraryItem | null {
  if (!isMediaType(mediaType)) {
    return null;
  }
  const id = cleanNumber(tmdbId);
  if (id === null || id <= 0) {
    return null;
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;

  const title = cleanString(r.title) || "Titre inconnu";
  const posterPath =
    typeof r.posterPath === "string" && r.posterPath.startsWith("/")
      ? r.posterPath.slice(0, 200)
      : null;
  const date = cleanString(r.date, 20) ?? undefined;
  const genreIds = Array.isArray(r.genreIds)
    ? r.genreIds
        .map(cleanNumber)
        .filter((n): n is number => n !== null)
        .slice(0, 20)
    : [];
  const addedAt = cleanNumber(r.addedAt) ?? Date.now();
  const updatedAt = cleanNumber(r.updatedAt) ?? addedAt;
  // Date de visionnage choisie par l'utilisateur (peut être passée) — distincte
  // d'updatedAt (date de l'action de cocher, toujours "maintenant"). Clampée pour
  // qu'un client malveillant ne puisse pas injecter une date future lointaine.
  const rawWatchedAt = cleanNumber(r.watchedAt);
  const watchedAt =
    rawWatchedAt === null ? undefined : Math.min(rawWatchedAt, Date.now() + 86400000);
  const rating =
    r.rating == null ? undefined : Math.min(10, Math.max(0, cleanNumber(r.rating) ?? 0));
  const runtimeMinutes =
    r.runtimeMinutes == null ? undefined : Math.max(0, cleanNumber(r.runtimeMinutes) ?? 0);
  // Uniquement pertinent pour les séries, mais on ne restreint pas à
  // mediaType === "tv" ici : un champ absent/vide pour un film ne coûte rien.
  const watchedEpisodes = Array.isArray(r.watchedEpisodes)
    ? [
        ...new Set(
          r.watchedEpisodes.filter(
            (e): e is string => typeof e === "string" && EPISODE_KEY_PATTERN.test(e)
          )
        ),
      ].slice(0, MAX_WATCHED_EPISODES)
    : [];
  // Rempli progressivement par le backfill de Stats (voir setDirectors dans
  // LibraryContext) — absent tant que l'item n'a pas encore été "revu".
  const directors = Array.isArray(r.directors)
    ? r.directors
        .map(cleanDirector)
        .filter((d): d is CleanDirector => d !== null)
        .slice(0, MAX_DIRECTORS)
    : [];

  return {
    id,
    mediaType: mediaType as MediaTypeStr,
    title,
    posterPath,
    date,
    genreIds,
    addedAt,
    updatedAt,
    watchedAt,
    rating,
    runtimeMinutes,
    watchedEpisodes,
    directors,
  };
}

// `watched`/`watchlist` : { "movie:123": {...}, "tv:456": {...} }. Renvoie
// la même forme, nettoyée, avec au plus MAX_ITEMS_PER_LIST entrées par liste
// (les entrées en trop sont simplement ignorées plutôt que de rejeter tout
// le payload — un client legit ne devrait jamais approcher cette limite).
function sanitizeList(rawList: unknown): CleanLibraryList {
  const out: CleanLibraryList = {};
  if (!rawList || typeof rawList !== "object") {
    return out;
  }
  let count = 0;
  for (const [key, raw] of Object.entries(rawList as Record<string, unknown>)) {
    if (count >= MAX_ITEMS_PER_LIST) {
      break;
    }
    const [mediaType, tmdbId] = String(key).split(":");
    const item = sanitizeItem(mediaType, tmdbId, raw);
    if (!item) {
      continue;
    }
    out[`${mediaType}:${item.id}`] = item;
    count += 1;
  }
  return out;
}

export interface LibraryPayload {
  watched: CleanLibraryList;
  watchlist: CleanLibraryList;
}

export function sanitizeLibraryPayload(body: unknown): LibraryPayload {
  const b = (body as Record<string, unknown>) || {};
  return {
    watched: sanitizeList(b.watched),
    watchlist: sanitizeList(b.watchlist),
  };
}

// Lot incrémental (voir POST /api/library/sync) : contrairement à
// sanitizeLibraryPayload ci-dessus (état complet, clés = "mediaType:id"),
// chaque entrée porte déjà mediaType/id séparément — le client envoie
// exactement ce qui a changé, pas tout l'état. Plafonné bas : une salve
// débattue côté client ne dépasse jamais qu'une poignée d'items en usage
// normal (ex. "tout marquer vu" sur une saison), ceci n'est qu'un
// garde-fou anti-abus.
const MAX_SYNC_BATCH = 500;

export interface SyncUpsert {
  mediaType: MediaTypeStr;
  tmdbId: number;
  status: "watched" | "watchlist";
  item: CleanLibraryItem;
}

export interface SyncDelete {
  mediaType: MediaTypeStr;
  id: number;
}

function sanitizeSyncUpsert(raw: unknown): SyncUpsert | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!isMediaType(r.mediaType)) {
    return null;
  }
  if (r.status !== "watched" && r.status !== "watchlist") {
    return null;
  }
  const item = sanitizeItem(r.mediaType as string, r.id, r.item);
  if (!item) {
    return null;
  }
  return { mediaType: r.mediaType as MediaTypeStr, tmdbId: item.id, status: r.status, item };
}

function sanitizeSyncDelete(raw: unknown): SyncDelete | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!isMediaType(r.mediaType)) {
    return null;
  }
  const id = cleanNumber(r.id);
  if (id === null || id <= 0) {
    return null;
  }
  return { mediaType: r.mediaType as MediaTypeStr, id };
}

export interface LibrarySyncPayload {
  upserts: SyncUpsert[];
  deletes: SyncDelete[];
}

export function sanitizeLibrarySyncPayload(body: unknown): LibrarySyncPayload {
  const b = (body as Record<string, unknown>) || {};
  return {
    upserts: Array.isArray(b.upserts)
      ? b.upserts
          .slice(0, MAX_SYNC_BATCH)
          .map(sanitizeSyncUpsert)
          .filter((u): u is SyncUpsert => u !== null)
      : [],
    deletes: Array.isArray(b.deletes)
      ? b.deletes
          .slice(0, MAX_SYNC_BATCH)
          .map(sanitizeSyncDelete)
          .filter((d): d is SyncDelete => d !== null)
      : [],
  };
}

export interface CleanWatchlistItem {
  mediaType: MediaTypeStr;
  tmdbId: number;
  title: string;
  posterPath: string | null;
}

// Items "envie de voir" pour le mirroir des notifications push (voir
// POST /api/subscribe et /api/subscribe/sync) — `maxItems` est passé par
// l'appelant (MAX_WATCHLIST_ITEMS dans worker/index.ts) plutôt que dupliqué
// ici.
export function sanitizeWatchlistItems(rawItems: unknown, maxItems: number): CleanWatchlistItem[] {
  return (Array.isArray(rawItems) ? rawItems : [])
    .slice(0, maxItems)
    .map((item): CleanWatchlistItem | null => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const r = item as Record<string, unknown>;
      if (!isMediaType(r.mediaType)) {
        return null;
      }
      const tmdbId = cleanNumber(r.tmdbId);
      if (tmdbId === null || tmdbId <= 0) {
        return null;
      }
      const title = cleanString(r.title) || "Titre inconnu";
      const posterPath =
        typeof r.posterPath === "string" && r.posterPath.startsWith("/")
          ? r.posterPath.slice(0, 200)
          : null;
      return { mediaType: r.mediaType as MediaTypeStr, tmdbId, title, posterPath };
    })
    .filter((item): item is CleanWatchlistItem => item !== null);
}

export interface CleanGenrePref {
  mediaType: MediaTypeStr;
  genreId: number;
}

export function sanitizeGenrePrefs(rawGenres: unknown, maxItems: number): CleanGenrePref[] {
  return (Array.isArray(rawGenres) ? rawGenres : [])
    .slice(0, maxItems)
    .map((g): CleanGenrePref | null => {
      if (!g || typeof g !== "object") {
        return null;
      }
      const r = g as Record<string, unknown>;
      if (!isMediaType(r.mediaType)) {
        return null;
      }
      const genreId = cleanNumber(r.genreId);
      if (genreId === null || genreId <= 0) {
        return null;
      }
      return { mediaType: r.mediaType as MediaTypeStr, genreId };
    })
    .filter((g): g is CleanGenrePref => g !== null);
}

// Genres exclus / plateformes favorites : simple liste d'ids TMDB, sans
// media_type ni payload associé (voir excluded_genre_prefs/
// favorite_provider_prefs). TMDB compte au plus quelques dizaines de genres
// et quelques centaines de plateformes ; 500 laisse une large marge sans
// permettre un abus qui gonflerait la base indéfiniment.
const MAX_ID_LIST = 500;

export function sanitizeIdList(rawIds: unknown): number[] {
  if (!Array.isArray(rawIds)) {
    return [];
  }
  const out = new Set<number>();
  for (const raw of rawIds) {
    if (out.size >= MAX_ID_LIST) {
      break;
    }
    const id = cleanNumber(raw);
    if (id !== null && id > 0) {
      out.add(id);
    }
  }
  return [...out];
}

// Langues/pays favoris : mêmes limites qu'excluded_genre_prefs/
// favorite_provider_prefs ci-dessus, pour des codes ISO (chaînes) plutôt que
// des ids numériques TMDB. `pattern` distingue iso_639_1 ("fr", minuscules)
// de iso_3166_1 ("FR", majuscules) — voir isValidRegionCode côté client pour
// le même format de code pays.
export function sanitizeIsoCodeList(rawCodes: unknown, pattern: RegExp): string[] {
  if (!Array.isArray(rawCodes)) {
    return [];
  }
  const out = new Set<string>();
  for (const raw of rawCodes) {
    if (out.size >= MAX_ID_LIST) {
      break;
    }
    if (typeof raw === "string" && pattern.test(raw)) {
      out.add(raw);
    }
  }
  return [...out];
}

export const LANGUAGE_CODE_PATTERN = /^[a-z]{2}$/;
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

// Audit M4 : abaissé de 200/5000 à 50/1000 — une liste perso n'a jamais eu
// besoin de la même marge que watched/watchlist (MAX_ITEMS_PER_LIST), et ces
// plafonds bornent surtout l'amplification d'écritures D1 d'un remplacement
// complet (voir replaceCustomListsForUser et upsertCustomListForUser).
export const MAX_CUSTOM_LISTS = 50;
const MAX_CUSTOM_LIST_ITEMS = 1000;
// Ticket "Ma liste commune" (cadrage du 2026-10-10, point 4) : 10 membres
// max par liste commune, en plus du propriétaire.
export const MAX_LIST_MEMBERS = 10;

export interface CleanCustomList {
  id: string;
  name: string;
  createdAt: number;
  items: CleanLibraryItem[];
}

export type CleanCustomListMap = Record<string, CleanCustomList>;

// Un item de liste perso porte son mediaType/id directement (contrairement à
// `watched`/`watchlist`, où ils viennent de la clé englobante) — voir
// CustomList dans src/core/types/library.ts. On les extrait ici pour
// réutiliser sanitizeItem tel quel.
function sanitizeCustomListItem(raw: unknown): CleanLibraryItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  return sanitizeItem(r.mediaType as string, r.id, r);
}

function sanitizeCustomList(id: string, raw: unknown): CleanCustomList | null {
  if (typeof id !== "string" || !id || id.length > 100) {
    return null;
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const name = cleanString(r.name);
  if (!name) {
    return null;
  }
  const createdAt = cleanNumber(r.createdAt) ?? Date.now();
  const seenKeys = new Set<string>();
  const items = (Array.isArray(r.items) ? r.items : [])
    .map(sanitizeCustomListItem)
    .filter((item): item is CleanLibraryItem => {
      if (!item) {
        return false;
      }
      const key = `${item.mediaType}:${item.id}`;
      if (seenKeys.has(key)) {
        return false;
      }
      seenKeys.add(key);
      return true;
    })
    .slice(0, MAX_CUSTOM_LIST_ITEMS);
  return { id, name, createdAt, items };
}

// Une seule liste (voir PUT /api/custom-lists/:listId) : même validation que
// sanitizeCustomList ci-dessus, `id` venant de l'URL plutôt que de la clé du
// payload.
export function sanitizeSingleCustomList(id: string, body: unknown): CleanCustomList | null {
  return sanitizeCustomList(id, body);
}

// Listes perso complètes (voir PUT /api/custom-lists) : { "list-...": { name,
// items, createdAt } }. Même politique que sanitizeLibraryPayload — clé non
// exploitable silencieusement écartée plutôt que de rejeter tout le payload.
export function sanitizeCustomListsPayload(body: unknown): CleanCustomListMap {
  const out: CleanCustomListMap = {};
  if (!body || typeof body !== "object") {
    return out;
  }
  let count = 0;
  for (const [id, raw] of Object.entries(body as Record<string, unknown>)) {
    if (count >= MAX_CUSTOM_LISTS) {
      break;
    }
    const list = sanitizeCustomList(id, raw);
    if (!list) {
      continue;
    }
    out[list.id] = list;
    count += 1;
  }
  return out;
}

const MAX_DISPLAY_NAME_LENGTH = 80;

// Nom affiché (voir PATCH /api/account/display-name) : chaîne libre, juste
// bornée en taille et décodée comme les autres champs texte utilisateur.
// Une chaîne vide (après trim) est une valeur valide — c'est ainsi que
// l'utilisateur efface son nom affiché.
export function sanitizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return decodeHtmlEntities(value.trim().slice(0, MAX_DISPLAY_NAME_LENGTH));
}

export interface CleanKey {
  mediaType: MediaTypeStr;
  id: number;
}

// Listes de retrait : juste des clés "mediaType:id" (tmdbId ou genreId
// selon l'appelant), pas de payload au-delà du format.
export function sanitizeKeyList(rawKeys: unknown, maxItems: number): CleanKey[] {
  return (Array.isArray(rawKeys) ? rawKeys : [])
    .slice(0, maxItems)
    .map((key): CleanKey | null => {
      const [mediaType, idStr] = String(key).split(":");
      if (!isMediaType(mediaType)) {
        return null;
      }
      const id = cleanNumber(idStr);
      if (id === null || id <= 0) {
        return null;
      }
      return { mediaType: mediaType as MediaTypeStr, id };
    })
    .filter((k): k is CleanKey => k !== null);
}

export interface CleanReminder {
  mediaType: MediaTypeStr;
  tmdbId: number;
  title: string;
  posterPath: string | null;
  // AAAA-MM-JJ, ou null si la date de sortie n'est pas encore connue.
  releaseDate: string | null;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Rappel « Me prévenir » (PUT /api/reminders, voir worker/reminders.ts).
export function sanitizeReminder(raw: unknown): CleanReminder | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const [item] = sanitizeWatchlistItems([raw], 1);
  if (!item) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const releaseDate =
    typeof r.releaseDate === "string" && ISO_DATE_PATTERN.test(r.releaseDate)
      ? r.releaseDate
      : null;
  return { ...item, releaseDate };
}

// Abonnement push anonyme (POST /api/subscribe, audit F1) : endpoint et
// clés fournis par le navigateur à l'abonnement, non authentifiés — n'importe
// quelle URL https:// serait sinon acceptée et contactée chaque jour par le
// cron (petit relais sortant exploitable), avec un stockage non borné.
// Liste blanche des services de push connus : seul le sous-domaine WNS varie
// par datacenter (ex. wns2-par1.notify.windows.com), d'où le suffixe.
const ALLOWED_PUSH_ENDPOINT_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge et autres navigateurs Chromium
  "web.push.apple.com", // Safari (macOS/iOS)
  "updates.push.services.mozilla.com", // Firefox
];
const ALLOWED_PUSH_ENDPOINT_SUFFIX = ".notify.windows.com"; // WNS (Edge legacy/Windows)

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    (ALLOWED_PUSH_ENDPOINT_HOSTS.includes(url.hostname) ||
      url.hostname.endsWith(ALLOWED_PUSH_ENDPOINT_SUFFIX))
  );
}

// Clé publique ECDH P-256 encodée en base64url (~87 caractères en pratique) :
// large marge. Idem pour le secret d'authentification (~22 caractères).
const MAX_PUSH_P256DH_LENGTH = 128;
const MAX_PUSH_AUTH_LENGTH = 64;

export function isValidPushKeys(p256dh: unknown, auth: unknown): boolean {
  return (
    typeof p256dh === "string" &&
    p256dh.length > 0 &&
    p256dh.length <= MAX_PUSH_P256DH_LENGTH &&
    typeof auth === "string" &&
    auth.length > 0 &&
    auth.length <= MAX_PUSH_AUTH_LENGTH
  );
}
