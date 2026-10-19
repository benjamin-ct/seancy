// Suggestions « Pour vous ce soir » générées par Workers AI (carte Trello
// "Worker AI pour l'algo V2"). L'algo heuristique "Pour toi" (v1,
// recommendations.ts) reste en place pour le scroll infini de Découvrir ;
// ce module ne remplace que la section du haut, et ne réutilise l'algo v1
// qu'en repli (quota dépassé, erreur IA, profil trop maigre).
//
// Déroulé : le premier GET du jour (pas de lot valide en base) pose un
// verrou 'pending' et lance la génération en arrière-plan (`ctx.waitUntil`,
// même principe que les ThumbHash, voir images/posterThumbhash.ts) ; la
// réponse HTTP repart aussitôt en "pending" et le client interroge à nouveau
// toutes les quelques secondes jusqu'à ce que le lot soit prêt. Jamais
// d'attente de 2-4 s dans la réponse elle-même.
//
// Le prompt reprend la variante « C30 » validée par les benchmarks joints à
// la carte (rapport-synthese-final.md §3.3, rapport-scout-prompt-durci…) :
// résumé des goûts pondéré par ancienneté, titres vus sur 30 jours, liste
// compacte des anciens titres vus dans les 2 genres dominants (c'est elle
// qui évite que le modèle re-propose les classiques déjà vus hors fenêtre),
// genres exclus, titres ignorés et déjà proposés — titres en langue
// originale. L'historique brut complet n'est jamais envoyé (dilue
// l'attention du modèle, coût x3 à x7 d'après les mêmes mesures).
import type { Env } from "./types.ts";
import type { LibraryItem } from "../src/core/types/library.ts";
import type { MediaType } from "../src/core/types/tmdb.ts";
import { getExcludedGenresForUser, getLibraryForUser, getNotInterestedForUser } from "./db.ts";
import {
  buildTasteProfile,
  getRecommendationCandidates,
  rankRecommendations,
} from "./recommendations.ts";
import {
  nextParisMidnight,
  nextUtcMidnight,
  normalizeTitle,
  parseSuggestions,
} from "./ai-suggestions-format.ts";
import { tmdbFetch } from "./tmdb.ts";
import { logError } from "./logger.ts";

// Seul endroit où le modèle est nommé : en changer ne demande que de
// modifier cette constante (après un nouveau benchmark, la qualité des
// suggestions variant beaucoup d'un modèle à l'autre — voir carte Trello).
// Il est aussi enregistré sur chaque lot (`ai_suggestion_batches.model`).
export const AI_SUGGESTIONS_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Sur-échantillonnage anti-hallucination (décision sur la carte) : on en
// demande 12 pour en garder 10 qui existent vraiment côté TMDB et passent les
// filtres. S'il en reste moins, on affiche ce qu'il y a, sans relancer l'IA.
const REQUESTED_COUNT = 12;
const KEPT_COUNT = 10;
// Même consigne système que pendant les benchmarks.
const SYSTEM_PROMPT =
  "Tu es un systeme de recommandation de films/series. Tu reponds de facon tres concise, sans jamais halluciner un titre qui n'existe pas.";
// Large pour 12 lignes « Titre (Année) » (~200 tokens mesurés).
const MAX_OUTPUT_TOKENS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_DAYS = 30;
const RECENT_CAP = 30;
const GENRE_SEEN_CAP = 40;
// Garde-fou sur la taille du prompt pour un gros « skippeur » : tous les
// skips actifs restent filtrés côté serveur, seuls les plus récents sont
// cités au modèle.
const SKIPS_PROMPT_CAP = 60;
const PREVIOUS_DAYS = 7;
// Un jour de plus que PREVIOUS_DAYS, au-delà les lots ne servent plus à rien.
const BATCH_RETENTION_DAYS = PREVIOUS_DAYS + 1;
const HALF_LIFE_DAYS = 120;

// Verrou de génération : bien au-delà des ~5 s mesurées (IA + TMDB) et des
// 30 s que Cloudflare laisse à `waitUntil`, pour qu'un Worker coupé en route
// ne bloque l'utilisateur que quelques minutes, pas toute la journée.
const PENDING_TTL_MS = 2 * 60 * 1000;
// Repli après une erreur IA autre que le quota (panne, timeout, binding
// absent) : on retentera l'IA une heure plus tard.
const FALLBACK_RETRY_MS = 60 * 60 * 1000;
const SKIP_TTL_MONTHS = 6;

// Les recherches TMDB des 12 titres proposés coûtent 24 sous-requêtes (film
// + série) sur les 50 permises par invocation en plan Workers Free : il en
// reste de quoi compléter quelques titres originaux inconnus par génération,
// le cache `tmdb_title_labels` se remplissant au fil des jours.
const LABEL_FETCH_BUDGET = 15;
// Workers n'ouvre que 6 connexions sortantes simultanées par invocation :
// au-delà, lancer tout en parallèle n'apporte rien, et en test local les
// requêtes en trop finissaient en « Network connection lost ». Une
// résolution = 2 recherches (film + série), d'où 3 titres à la fois.
const MAX_CONCURRENT_FETCHES = 6;
// Limite de paramètres liés d'une requête D1 (même valeur que db.ts).
const MAX_BOUND_IDS = 90;

// Libellés envoyés au modèle (sans accents, comme pendant les benchmarks).
// Les genres séries composites de TMDB sont ramenés à leur équivalent film.
const GENRE_LABELS: Record<number, string> = {
  28: "Action",
  12: "Aventure",
  16: "Animation",
  35: "Comedie",
  80: "Crime/polar",
  99: "Documentaire",
  18: "Drame",
  10751: "Familial",
  14: "Fantastique",
  36: "Histoire",
  27: "Horreur",
  10402: "Musique",
  9648: "Mystere",
  10749: "Romance",
  878: "Science-fiction",
  53: "Thriller",
  10752: "Guerre",
  37: "Western",
  10770: "Telefilm",
  10759: "Action",
  10762: "Jeunesse",
  10763: "Actualites",
  10764: "Telerealite",
  10765: "Science-fiction",
  10766: "Feuilleton",
  10767: "Talk-show",
  10768: "Guerre",
};
const TV_GENRE_EQUIVALENTS: Record<number, number[]> = {
  10759: [28, 12],
  10765: [878, 14],
  10768: [10752],
};
const DRAMA_GENRE_ID = 18;
const ANIMATION_GENRE_ID = 16;

export type TonightSuggestionsResult =
  | { status: "pending" }
  | { status: "ready" | "fallback"; items: Array<{ mediaType: MediaType; id: number }> };

type BatchStatus = "pending" | "ready" | "fallback";

interface TitleLabel {
  title: string | null;
  originalTitle: string | null;
  originalLanguage: string | null;
  releaseYear: number | null;
}

interface ListedTitle extends TitleLabel {
  mediaType: MediaType;
  tmdbId: number;
}

interface ResolvedTitle extends TitleLabel {
  mediaType: MediaType;
  tmdbId: number;
  genreIds: number[];
  popularity: number;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function keyOf(mediaType: string, tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

function skipExpiry(now: number): number {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() + SKIP_TTL_MONTHS);
  return date.getTime();
}

function yearOf(dateStr: string | null | undefined): number | null {
  const year = dateStr ? Number(dateStr.slice(0, 4)) : NaN;
  return Number.isFinite(year) && year > 1800 ? year : null;
}

// Erreur 3036 (quota gratuit journalier épuisé, HTTP 429) : partagée par tout
// le compte et tous les modèles, aucun autre modèle ne peut donc prendre le
// relais — d'où le repli sur l'algo v1.
function isQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b3036\b|\b429\b|daily free allocation/i.test(message);
}

// Lecture -----------------------------------------------------------------

async function getCurrentBatch(
  env: Env,
  userId: number,
  now: number
): Promise<{ id: number; status: BatchStatus } | null> {
  return env.DB.prepare(
    `SELECT id, status FROM ai_suggestion_batches
      WHERE user_id = ? AND expires_at > ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`
  )
    .bind(userId, now)
    .first<{ id: number; status: BatchStatus }>();
}

// Titres du lot encore à proposer : moins ceux ignorés depuis et ceux
// marqués vus entre-temps (y compris depuis un autre appareil).
async function getBatchItems(
  env: Env,
  userId: number,
  batchId: number,
  now: number
): Promise<Array<{ mediaType: MediaType; id: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT t.media_type, t.tmdb_id FROM ai_suggestion_titles t
      WHERE t.batch_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM ai_suggestion_skips s
           WHERE s.user_id = ? AND s.media_type = t.media_type AND s.tmdb_id = t.tmdb_id
             AND s.expires_at > ?)
        AND NOT EXISTS (
          SELECT 1 FROM library_items l
           WHERE l.user_id = ? AND l.media_type = t.media_type AND l.tmdb_id = t.tmdb_id
             AND l.status = 'watched')
      ORDER BY t.rank`
  )
    .bind(batchId, userId, now, userId)
    .all<{ media_type: MediaType; tmdb_id: number }>();
  return results.map((row) => ({ mediaType: row.media_type, id: row.tmdb_id }));
}

// Pose le verrou 'pending' seulement si aucun lot valide (prêt, repli ou
// génération en cours) n'existe : un seul statement, donc atomique côté D1
// même si deux onglets interrogent au même moment. Renvoie l'id du lot créé,
// ou null si quelqu'un d'autre l'a déjà posé.
async function claimGeneration(env: Env, userId: number, now: number): Promise<number | null> {
  const row = await env.DB.prepare(
    `INSERT INTO ai_suggestion_batches (user_id, status, created_at, expires_at)
     SELECT ?, 'pending', ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM ai_suggestion_batches WHERE user_id = ? AND expires_at > ?)
     RETURNING id`
  )
    .bind(userId, now, now + PENDING_TTL_MS, userId, now)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function getTonightSuggestions(
  env: Env,
  ctx: ExecutionContext,
  userId: number
): Promise<TonightSuggestionsResult> {
  const now = Date.now();
  const current = await getCurrentBatch(env, userId, now);
  if (current?.status === "pending") {
    return { status: "pending" };
  }
  if (current) {
    return { status: current.status, items: await getBatchItems(env, userId, current.id, now) };
  }
  const batchId = await claimGeneration(env, userId, now);
  if (batchId != null) {
    ctx.waitUntil(generateSuggestions(env, userId, batchId));
  }
  return { status: "pending" };
}

export async function skipTonightSuggestion(
  env: Env,
  userId: number,
  mediaType: MediaType,
  tmdbId: number
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO ai_suggestion_skips (user_id, media_type, tmdb_id, skipped_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, media_type, tmdb_id) DO UPDATE SET
       skipped_at = excluded.skipped_at, expires_at = excluded.expires_at`
  )
    .bind(userId, mediaType, tmdbId, now, skipExpiry(now))
    .run();
}

// Signaux de l'utilisateur ------------------------------------------------

interface UserSignals {
  watched: LibraryItem[];
  watchlist: LibraryItem[];
  excludedGenreIds: number[];
  notInterested: Awaited<ReturnType<typeof getNotInterestedForUser>>;
  skips: ListedTitle[];
  previous: ListedTitle[];
}

interface LabelRow {
  media_type: MediaType;
  tmdb_id: number;
  title: string | null;
  original_title: string | null;
  original_language: string | null;
  release_year: number | null;
}

function listedFromRow(row: LabelRow): ListedTitle {
  return {
    mediaType: row.media_type,
    tmdbId: row.tmdb_id,
    title: row.title,
    originalTitle: row.original_title,
    originalLanguage: row.original_language,
    releaseYear: row.release_year,
  };
}

async function loadSignals(
  env: Env,
  userId: number,
  batchId: number,
  now: number
): Promise<UserSignals> {
  const [library, excludedGenreIds, notInterested, skips, previous] = await Promise.all([
    getLibraryForUser(env.DB, userId),
    getExcludedGenresForUser(env.DB, userId),
    getNotInterestedForUser(env.DB, userId),
    env.DB.prepare(
      `SELECT s.media_type, s.tmdb_id, l.title, l.original_title, l.original_language, l.release_year
         FROM ai_suggestion_skips s
         LEFT JOIN tmdb_title_labels l ON l.media_type = s.media_type AND l.tmdb_id = s.tmdb_id
        WHERE s.user_id = ? AND s.expires_at > ?
        ORDER BY s.skipped_at DESC`
    )
      .bind(userId, now)
      .all<LabelRow>(),
    env.DB.prepare(
      `SELECT DISTINCT t.media_type, t.tmdb_id, l.title, l.original_title, l.original_language, l.release_year
         FROM ai_suggestion_titles t
         JOIN ai_suggestion_batches b ON b.id = t.batch_id
         LEFT JOIN tmdb_title_labels l ON l.media_type = t.media_type AND l.tmdb_id = t.tmdb_id
        WHERE b.user_id = ? AND b.id != ? AND b.status != 'pending' AND b.created_at > ?`
    )
      .bind(userId, batchId, now - PREVIOUS_DAYS * DAY_MS)
      .all<LabelRow>(),
  ]);
  return {
    watched: Object.values(library.watched),
    watchlist: Object.values(library.watchlist),
    excludedGenreIds,
    notInterested,
    skips: skips.results.map(listedFromRow),
    previous: previous.results.map(listedFromRow),
  };
}

// Titres originaux --------------------------------------------------------

async function getLabels(
  env: Env,
  keys: Array<{ mediaType: MediaType; tmdbId: number }>
): Promise<Map<string, TitleLabel>> {
  const labels = new Map<string, TitleLabel>();
  const ids = [...new Set(keys.map((key) => key.tmdbId))];
  if (ids.length === 0) {
    return labels;
  }
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += MAX_BOUND_IDS) {
    const chunk = ids.slice(i, i + MAX_BOUND_IDS);
    statements.push(
      env.DB.prepare(
        `SELECT media_type, tmdb_id, title, original_title, original_language, release_year
           FROM tmdb_title_labels WHERE tmdb_id IN (${chunk.map(() => "?").join(", ")})`
      ).bind(...chunk)
    );
  }
  for (const { results } of await env.DB.batch<LabelRow>(statements)) {
    for (const row of results) {
      labels.set(keyOf(row.media_type, row.tmdb_id), listedFromRow(row));
    }
  }
  return labels;
}

function upsertLabelStatement(env: Env, title: ListedTitle, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO tmdb_title_labels
         (media_type, tmdb_id, title, original_title, original_language, release_year, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (media_type, tmdb_id) DO UPDATE SET
         title = COALESCE(excluded.title, title),
         original_title = COALESCE(excluded.original_title, original_title),
         original_language = COALESCE(excluded.original_language, original_language),
         release_year = COALESCE(excluded.release_year, release_year),
         updated_at = excluded.updated_at`
  ).bind(
    title.mediaType,
    title.tmdbId,
    title.title,
    title.originalTitle,
    title.originalLanguage,
    title.releaseYear,
    now
  );
}

interface TmdbTitleDetails {
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  original_language?: string;
  release_date?: string;
  first_air_date?: string;
}

// Complète `tmdb_title_labels` pour les titres cités dans le prompt dont on
// ne connaît pas encore le titre original, dans la limite de
// LABEL_FETCH_BUDGET fiches TMDB (ordre de `keys` = priorité).
async function fetchMissingLabels(
  env: Env,
  keys: Array<{ mediaType: MediaType; tmdbId: number }>,
  labels: Map<string, TitleLabel>,
  now: number
): Promise<void> {
  const seen = new Set<string>();
  const missing = keys.filter((key) => {
    const k = keyOf(key.mediaType, key.tmdbId);
    if (seen.has(k) || labels.get(k)?.originalTitle) {
      return false;
    }
    seen.add(k);
    return true;
  });
  const fetched = await mapWithConcurrency(
    missing.slice(0, LABEL_FETCH_BUDGET),
    MAX_CONCURRENT_FETCHES,
    async (key) => {
      try {
        const data = await tmdbFetch<TmdbTitleDetails>(env, `/${key.mediaType}/${key.tmdbId}`);
        return {
          mediaType: key.mediaType,
          tmdbId: key.tmdbId,
          title: data.title || data.name || null,
          originalTitle: data.original_title || data.original_name || null,
          originalLanguage: data.original_language || null,
          releaseYear: yearOf(data.release_date || data.first_air_date),
        } satisfies ListedTitle;
      } catch {
        return null;
      }
    }
  );
  const complete = fetched.filter((title): title is ListedTitle => title !== null);
  if (complete.length === 0) {
    return;
  }
  for (const title of complete) {
    labels.set(keyOf(title.mediaType, title.tmdbId), title);
  }
  await env.DB.batch(complete.map((title) => upsertLabelStatement(env, title, now)));
}

// Prompt ------------------------------------------------------------------

function watchedAtOf(item: LibraryItem): number {
  return item.watchedAt ?? item.addedAt ?? item.updatedAt ?? 0;
}

// Note sur 10 → poids : un titre adoré compte plus qu'un titre vu sans note,
// un titre détesté ne compte presque plus (même formule que pendant les
// benchmarks).
function ratingFactor(rating: number | null | undefined): number {
  return rating == null ? 0.6 : Math.min(1.2, Math.max(0.1, (rating - 4) / 5));
}

function recencyWeight(item: LibraryItem, now: number): number {
  const ageDays = (now - watchedAtOf(item)) / DAY_MS;
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS) * ratingFactor(item.rating);
}

function isAnime(genreIds: number[], label: TitleLabel | undefined): boolean {
  return label?.originalLanguage === "ja" && genreIds.includes(ANIMATION_GENRE_ID);
}

// Titre original s'il est en alphabet latin (le modèle fait mieux le lien
// avec ses connaissances), sinon le titre français.
function promptName(fallbackTitle: string | null, label: TitleLabel | undefined): string | null {
  const original = label?.originalTitle;
  if (original && !/(?=\p{L})\P{Script=Latin}/u.test(original)) {
    return original;
  }
  return fallbackTitle || label?.title || original || null;
}

function promptTitle(
  fallbackTitle: string | null,
  year: number | null,
  label: TitleLabel | undefined
): string | null {
  const name = promptName(fallbackTitle, label);
  if (!name) {
    return null;
  }
  return year ? `${name} (${year})` : name;
}

function libraryPromptTitle(item: LibraryItem, labels: Map<string, TitleLabel>): string | null {
  return promptTitle(item.title, yearOf(item.date), labels.get(keyOf(item.mediaType, item.id)));
}

function listedPromptTitle(title: ListedTitle): string | null {
  return promptTitle(title.title, title.releaseYear, title);
}

function tasteSummary(
  watched: LibraryItem[],
  labels: Map<string, TitleLabel>,
  now: number
): string[] {
  const score = new Map<string, number>();
  const rawCount = new Map<string, number>();
  let tvWeight = 0;
  let totalWeight = 0;
  for (const item of watched) {
    const weight = recencyWeight(item, now);
    totalWeight += weight;
    if (item.mediaType === "tv") {
      tvWeight += weight;
    }
    const genreIds = item.genreIds ?? [];
    const names = isAnime(genreIds, labels.get(keyOf(item.mediaType, item.id)))
      ? ["Anime japonais"]
      : [...new Set(genreIds.map((id) => GENRE_LABELS[id] ?? "Autre"))];
    for (const name of names) {
      score.set(name, (score.get(name) ?? 0) + weight);
      rawCount.set(name, (rawCount.get(name) ?? 0) + 1);
    }
  }
  const max = Math.max(0, ...score.values());
  const ranked = [...score.entries()]
    .map(([name, value]): [string, number] => [name, max > 0 ? value / max : 0])
    .sort((a, b) => b[1] - a[1]);
  const top = ranked.filter(([, w]) => w >= 0.15).slice(0, 7);
  const faded = ranked
    .filter(([name, w]) => w < 0.15 && (rawCount.get(name) ?? 0) >= 8)
    .slice(0, 3);
  const favorites = watched
    .filter(
      (item) =>
        typeof item.rating === "number" &&
        item.rating >= 9 &&
        now - watchedAtOf(item) <= 180 * DAY_MS
    )
    .slice(0, 5)
    .map((item) => libraryPromptTitle(item, labels))
    .filter((title): title is string => !!title);

  const tvShare = totalWeight > 0 ? Math.round((100 * tvWeight) / totalWeight) : 0;
  const lines = [
    `Profil : ${watched.length} titres vus au total, dont ${tvShare} % de series (en poids recent).`,
  ];
  if (top.length) {
    lines.push(
      `Affinites ponderees par recence (1.00 = gout dominant actuel) : ${top
        .map(([name, w]) => `${name} ${w.toFixed(2)}`)
        .join(", ")}.`
    );
  }
  if (faded.length) {
    lines.push(
      `Phases anciennes, a ne plus proposer sauf exception : ${faded
        .map(([name, w]) => `${name} (${rawCount.get(name)} titres, poids ${w.toFixed(2)})`)
        .join(", ")}.`
    );
  }
  if (favorites.length) {
    lines.push(`Coups de coeur recents (note >= 9) : ${favorites.join(", ")}.`);
  }
  return lines;
}

function normalizedGenreIds(genreIds: number[]): number[] {
  return genreIds.flatMap((id) => [id, ...(TV_GENRE_EQUIVALENTS[id] ?? [])]);
}

// Deux genres dominants (pondérés par ancienneté, Drame mis à part : trop
// transversal pour délimiter quoi que ce soit) — base de la liste « autres
// titres déjà vus dans ces genres ».
function topGenreIds(watched: LibraryItem[], now: number): number[] {
  const score = new Map<number, number>();
  for (const item of watched) {
    const weight = recencyWeight(item, now);
    for (const id of item.genreIds ?? []) {
      const key = TV_GENRE_EQUIVALENTS[id]?.[0] ?? id;
      score.set(key, (score.get(key) ?? 0) + weight);
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .filter((id) => id !== DRAMA_GENRE_ID)
    .slice(0, 2);
}

interface PromptLists {
  recent: LibraryItem[];
  recentWindowCount: number;
  older: LibraryItem[];
  skips: ListedTitle[];
}

// Choisit les titres de la bibliothèque cités dans le prompt (avant d'en
// chercher les titres originaux) : historique trié du plus récent au plus
// ancien, sur la date de visionnage réelle quand elle existe.
function selectPromptLists(signals: UserSignals, now: number): PromptLists {
  const history = [...signals.watched].sort((a, b) => watchedAtOf(b) - watchedAtOf(a));
  const window = history.filter((item) => now - watchedAtOf(item) <= RECENT_WINDOW_DAYS * DAY_MS);
  const recent = window.slice(0, RECENT_CAP);
  const recentKeys = new Set(recent.map((item) => keyOf(item.mediaType, item.id)));
  const top = topGenreIds(history, now);
  const older = history
    .filter(
      (item) =>
        !recentKeys.has(keyOf(item.mediaType, item.id)) &&
        (item.genreIds ?? []).some((id) => top.includes(TV_GENRE_EQUIVALENTS[id]?.[0] ?? id))
    )
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || watchedAtOf(b) - watchedAtOf(a))
    .slice(0, GENRE_SEEN_CAP);
  return {
    recent,
    recentWindowCount: window.length,
    older,
    skips: signals.skips.slice(0, SKIPS_PROMPT_CAP),
  };
}

function buildPrompt(
  signals: UserSignals,
  lists: PromptLists,
  labels: Map<string, TitleLabel>,
  now: number
): string {
  const history = [...signals.watched].sort((a, b) => watchedAtOf(b) - watchedAtOf(a));
  const recentEntries = lists.recent
    .map((item) => {
      const title = libraryPromptTitle(item, labels);
      return title && (typeof item.rating === "number" ? `${title} ${item.rating}` : title);
    })
    .filter((entry): entry is string => !!entry);
  const truncated =
    lists.recentWindowCount > lists.recent.length
      ? ` sur ${lists.recentWindowCount}, les plus recents`
      : "";
  const older = lists.older
    .map((item) => libraryPromptTitle(item, labels))
    .filter((title): title is string => !!title);
  const excludedGenres = [
    ...new Set(signals.excludedGenreIds.map((id) => GENRE_LABELS[id]).filter(Boolean)),
  ];
  const skips = lists.skips.map(listedPromptTitle).filter((title): title is string => !!title);
  const previous = signals.previous
    .map(listedPromptTitle)
    .filter((title): title is string => !!title);

  const lines = [
    ...tasteSummary(history, labels, now),
    "",
    `Tous les titres vus sur les ${RECENT_WINDOW_DAYS} derniers jours (${recentEntries.length}${truncated}) (titre (annee) note/10) : ${recentEntries.join("; ") || "aucun"}`,
    "",
  ];
  if (older.length) {
    lines.push(
      `Autres titres deja vus dans ces genres (ne pas reproposer) : ${older.join(", ")}`,
      ""
    );
  }
  lines.push(`Genres exclus : ${excludedGenres.join(", ") || "aucun"}`);
  lines.push(`Titres ignores (ne jamais proposer) : ${skips.join(", ") || "aucun"}`);
  if (previous.length) {
    lines.push(`Deja proposes les jours precedents (ne pas reproposer) : ${previous.join(", ")}`);
  }
  lines.push(
    "",
    `Propose exactement ${REQUESTED_COUNT} films ou series reels (deja sortis) pour ce soir, adaptes au gout actuel ci-dessus, qui ne figurent dans aucune des listes ci-dessus, en respectant les genres exclus.`,
    `Reponds UNIQUEMENT avec une liste numerotee de ${REQUESTED_COUNT} lignes au format "Titre (Annee)", sans aucune explication.`
  );
  return lines.join("\n");
}

// Sortie du modèle --------------------------------------------------------

interface TmdbSearchResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  original_language?: string;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  popularity?: number;
}

async function searchTmdb(
  env: Env,
  mediaType: MediaType,
  title: string,
  year: number
): Promise<ResolvedTitle[]> {
  try {
    // `year` (et non primary_release_year/first_air_date_year) : tolère un
    // décalage entre la sortie en festival, en salle ou par pays.
    const data = await tmdbFetch<{ results?: TmdbSearchResult[] }>(env, `/search/${mediaType}`, {
      query: title,
      year,
      include_adult: "false",
    });
    return (data.results || []).slice(0, 5).map((result) => ({
      mediaType,
      tmdbId: result.id,
      title: result.title || result.name || null,
      originalTitle: result.original_title || result.original_name || null,
      originalLanguage: result.original_language || null,
      releaseYear: yearOf(result.release_date || result.first_air_date),
      genreIds: result.genre_ids || [],
      popularity: result.popularity ?? 0,
    }));
  } catch {
    return [];
  }
}

function matchScore(candidate: ResolvedTitle, query: string, year: number): number {
  let best = 0;
  for (const name of [candidate.title, candidate.originalTitle]) {
    const normalized = name ? normalizeTitle(name) : "";
    if (!normalized) {
      continue;
    }
    if (normalized === query) {
      best = Math.max(best, 3);
    } else if (
      Math.min(normalized.length, query.length) >= 4 &&
      (normalized.includes(query) || query.includes(normalized))
    ) {
      best = Math.max(best, 1);
    }
  }
  return best > 0 && candidate.releaseYear === year ? best + 1 : best;
}

// « Titre (Année) » → titre TMDB. Le modèle ne précise pas film ou série :
// on cherche des deux côtés et on garde le meilleur résultat dont le titre
// correspond vraiment (un titre inventé ne correspond à rien et est écarté —
// c'est le filet anti-hallucination prévu par le sur-échantillonnage).
async function resolveSuggestion(
  env: Env,
  suggestion: { title: string; year: number }
): Promise<ResolvedTitle | null> {
  const [movies, shows] = await Promise.all([
    searchTmdb(env, "movie", suggestion.title, suggestion.year),
    searchTmdb(env, "tv", suggestion.title, suggestion.year),
  ]);
  const query = normalizeTitle(suggestion.title);
  let best: { candidate: ResolvedTitle; score: number } | null = null;
  for (const candidate of [...movies, ...shows]) {
    const score = matchScore(candidate, query, suggestion.year);
    if (
      score > 0 &&
      (!best ||
        score > best.score ||
        (score === best.score && candidate.popularity > best.candidate.popularity))
    ) {
      best = { candidate, score };
    }
  }
  return best?.candidate ?? null;
}

function responseText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  const response = (output as { response?: unknown } | null)?.response;
  return typeof response === "string" ? response : "";
}

// Génération (arrière-plan) -----------------------------------------------

async function generateSuggestions(env: Env, userId: number, batchId: number): Promise<void> {
  const now = Date.now();
  let signals: UserSignals;
  try {
    signals = await loadSignals(env, userId, batchId, now);
  } catch (err) {
    // Rien à proposer sans les signaux, pas même le repli : le verrou
    // 'pending' expirera de lui-même (PENDING_TTL_MS) et le prochain GET
    // retentera.
    logError("Suggestions IA : lecture des signaux impossible", err);
    return;
  }

  const profile = buildTasteProfile(
    signals.watched,
    signals.watchlist,
    signals.notInterested,
    signals.excludedGenreIds
  );
  // Profil trop maigre (même seuil que l'algo v1) : l'IA ne ferait que
  // redonner des titres populaires, autant ne pas consommer le quota.
  if (profile.isColdStart) {
    await fillWithFallback(env, userId, batchId, signals, nextParisMidnight(now));
    return;
  }

  let output: unknown;
  try {
    const lists = selectPromptLists(signals, now);
    const labelKeys = [
      ...lists.recent.map((item) => ({ mediaType: item.mediaType, tmdbId: item.id })),
      ...lists.skips,
      ...lists.older.map((item) => ({ mediaType: item.mediaType, tmdbId: item.id })),
      ...signals.previous,
    ];
    const labels = await getLabels(env, labelKeys);
    await fetchMissingLabels(env, labelKeys, labels, now);
    // Les skips et déjà-proposés portent leur libellé depuis la jointure SQL :
    // on y reporte ce que fetchMissingLabels vient de compléter.
    for (const listed of [...lists.skips, ...signals.previous]) {
      Object.assign(listed, labels.get(keyOf(listed.mediaType, listed.tmdbId)) ?? {});
    }
    const prompt = buildPrompt(signals, lists, labels, now);
    output = await env.AI.run(AI_SUGGESTIONS_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    const quota = isQuotaError(err);
    logError(
      quota
        ? "Suggestions IA : quota Workers AI dépassé (3036), repli sur l'algo v1"
        : "Suggestions IA : échec de la génération, repli sur l'algo v1",
      err
    );
    const expiresAt = quota
      ? nextUtcMidnight(now)
      : Math.min(now + FALLBACK_RETRY_MS, nextParisMidnight(now));
    await fillWithFallback(env, userId, batchId, signals, expiresAt);
    return;
  }

  try {
    const suggestions = parseSuggestions(responseText(output), REQUESTED_COUNT);
    const resolved = await mapWithConcurrency(suggestions, MAX_CONCURRENT_FETCHES / 2, (s) =>
      resolveSuggestion(env, s)
    );

    const excluded = new Set<string>([
      ...profile.seenKeys,
      ...signals.skips.map((s) => keyOf(s.mediaType, s.tmdbId)),
    ]);
    const excludedGenres = new Set(signals.excludedGenreIds);
    const kept: ResolvedTitle[] = [];
    for (const title of resolved) {
      if (!title || kept.length >= KEPT_COUNT) {
        continue;
      }
      const key = keyOf(title.mediaType, title.tmdbId);
      if (
        excluded.has(key) ||
        normalizedGenreIds(title.genreIds).some((id) => excludedGenres.has(id))
      ) {
        continue;
      }
      excluded.add(key);
      kept.push(title);
    }

    if (kept.length === 0) {
      // Réponse illisible ou entièrement hors filtres : pas de nouvel appel
      // IA aujourd'hui (sobriété sur le quota), l'algo v1 prend le relais.
      logError(
        "Suggestions IA : aucun titre exploitable, repli sur l'algo v1",
        new Error(`Réponse du modèle : ${responseText(output).slice(0, 500)}`)
      );
      await fillWithFallback(env, userId, batchId, signals, nextParisMidnight(now));
      return;
    }

    const usage = (output as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
      ?.usage;
    await env.DB.batch([
      ...kept.map((title, rank) =>
        env.DB.prepare(
          "INSERT INTO ai_suggestion_titles (batch_id, rank, media_type, tmdb_id) VALUES (?, ?, ?, ?)"
        ).bind(batchId, rank, title.mediaType, title.tmdbId)
      ),
      ...resolved
        .filter((title): title is ResolvedTitle => !!title)
        .map((title) => upsertLabelStatement(env, title, now)),
      env.DB.prepare(
        `UPDATE ai_suggestion_batches
            SET status = 'ready', model = ?, prompt_tokens = ?, completion_tokens = ?,
                completed_at = ?, expires_at = ?
          WHERE id = ?`
      ).bind(
        AI_SUGGESTIONS_MODEL,
        usage?.prompt_tokens ?? null,
        usage?.completion_tokens ?? null,
        Date.now(),
        nextParisMidnight(now),
        batchId
      ),
      ...pruneStatements(env, userId, now),
    ]);
  } catch (err) {
    logError("Suggestions IA : échec de l'enregistrement, repli sur l'algo v1", err);
    await fillWithFallback(
      env,
      userId,
      batchId,
      signals,
      Math.min(now + FALLBACK_RETRY_MS, nextParisMidnight(now))
    );
  }
}

// Lots plus vieux qu'une semaine : ne servent plus de « déjà proposés ».
// Titres supprimés explicitement d'abord, comme deleteUserAccount (db.ts),
// sans compter sur le ON DELETE CASCADE.
function pruneStatements(env: Env, userId: number, now: number): D1PreparedStatement[] {
  const cutoff = now - BATCH_RETENTION_DAYS * DAY_MS;
  return [
    env.DB.prepare(
      `DELETE FROM ai_suggestion_titles WHERE batch_id IN (
         SELECT id FROM ai_suggestion_batches WHERE user_id = ? AND created_at < ?)`
    ).bind(userId, cutoff),
    env.DB.prepare("DELETE FROM ai_suggestion_batches WHERE user_id = ? AND created_at < ?").bind(
      userId,
      cutoff
    ),
  ];
}

// « Le vrai repli reste l'algo non-IA déjà en place » (carte Trello) : mêmes
// candidats/profil/classement que la grille "Pour toi", limités à 10, hors
// titres déjà ignorés ici. Lot marqué 'fallback' avec une durée de vie
// propre (`expiresAt`), pour retenter l'IA plus tôt qu'un lot 'ready'.
async function fillWithFallback(
  env: Env,
  userId: number,
  batchId: number,
  signals: UserSignals,
  expiresAt: number
): Promise<void> {
  const now = Date.now();
  try {
    const profile = buildTasteProfile(
      signals.watched,
      signals.watchlist,
      signals.notInterested,
      signals.excludedGenreIds
    );
    const candidateLists = await Promise.all([
      getRecommendationCandidates(env, "movie"),
      getRecommendationCandidates(env, "tv"),
    ]);
    const items = rankRecommendations(candidateLists.flat(), profile, {
      limit: KEPT_COUNT,
      excludeKeys: new Set(signals.skips.map((s) => keyOf(s.mediaType, s.tmdbId))),
    });
    await env.DB.batch([
      ...items.map((item, rank) =>
        env.DB.prepare(
          "INSERT INTO ai_suggestion_titles (batch_id, rank, media_type, tmdb_id) VALUES (?, ?, ?, ?)"
        ).bind(batchId, rank, item.mediaType, item.id)
      ),
      // Titre français seulement (pas d'original dans `popular_titles`) :
      // suffit pour citer le titre au modèle s'il est ignoré, l'original sera
      // complété par fetchMissingLabels à une génération suivante.
      ...items.map((item) =>
        upsertLabelStatement(
          env,
          {
            mediaType: item.mediaType,
            tmdbId: item.id,
            title: item.title,
            originalTitle: null,
            originalLanguage: null,
            releaseYear: yearOf(item.releaseDate),
          },
          now
        )
      ),
      env.DB.prepare(
        `UPDATE ai_suggestion_batches
            SET status = 'fallback', completed_at = ?, expires_at = ?
          WHERE id = ?`
      ).bind(now, expiresAt, batchId),
      ...pruneStatements(env, userId, now),
    ]);
  } catch (err) {
    logError("Suggestions IA : échec du repli sur l'algo v1", err);
  }
}
