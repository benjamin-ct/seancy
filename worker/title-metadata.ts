// Métadonnées des titres de la bibliothèque et des listes perso venues de
// TMDB plutôt que du client (ticket « Réhydrater la bibliothèque depuis
// TMDB ») : à l'écriture, le titre, l'affiche et les genres poussés par le
// client sont remplacés par ceux de la fiche TMDB, et un identifiant que TMDB
// ne connaît pas est écarté. Les fiches sont gardées dans un cache D1 partagé
// entre comptes (`tmdb_titles`, migration 0026) : un titre n'a rien de
// personnel, et la plupart des écritures (un titre coché, une liste déjà
// vérifiée qu'on réordonne) ne coûtent ainsi aucun appel TMDB.
//
// Ce module ne fait que les règles (fraîcheur, budget d'appels, application
// au titre) : D1 et TMDB sont injectés par worker/tmdb-titles.ts, pour rester
// testable sous node (scripts/verify-title-metadata.ts).

import type { MediaTypeStr } from "./validate.ts";

export interface TitleKey {
  mediaType: MediaTypeStr;
  id: number;
}

export interface TitleMetadata {
  title: string | null;
  posterPath: string | null;
  genreIds: number[];
}

// Entrée du cache : fiche trouvée, ou 404 de TMDB (gardé aussi, pour qu'un
// identifiant inexistant renvoyé en boucle ne coûte pas un appel à chaque
// fois).
export type CachedTitle =
  { found: true; meta: TitleMetadata; fetchedAt: number } | { found: false; fetchedAt: number };

export type FetchedTitle =
  { status: "found"; meta: TitleMetadata } | { status: "missing" } | { status: "error" };

// `unverified` : ni en cache ni vérifiable maintenant (budget d'appels
// épuisé, TMDB en panne) — l'item garde alors ce qu'a envoyé le client,
// nettoyé par worker/validate.ts. Une écriture n'échoue jamais à cause de
// TMDB : le client ne la renverrait pas (voir LibraryContext).
export type TitleResolution =
  { status: "found"; meta: TitleMetadata } | { status: "missing" } | { status: "unverified" };

// Ce que reçoivent les écritures (worker/index.ts, replaceLibraryForUser) :
// un résolveur déjà lié à la langue et au compte de la requête (voir
// titleResolverFor dans worker/tmdb-titles.ts).
export type TitleResolver = (keys: TitleKey[]) => Promise<Map<string, TitleResolution>>;

export interface TitleSource {
  read(keys: TitleKey[], language: string): Promise<Map<string, CachedTitle>>;
  fetch(key: TitleKey, language: string): Promise<FetchedTitle>;
  write(entries: Array<{ key: TitleKey; entry: CachedTitle }>, language: string): Promise<void>;
  // Appelé avant chaque appel TMDB : `false` arrête les appels de cette
  // écriture (plafond par compte, voir worker/tmdb-titles.ts).
  allowFetch(): boolean;
}

// Une fiche TMDB change rarement (nouvelle affiche, titre traduit) : on la
// relit au bout d'un mois, quand une écriture la touche. Un 404 est relu dès
// le lendemain, au cas où.
export const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MISSING_TTL_MS = 24 * 60 * 60 * 1000;
// Appels TMDB par écriture, sous les 50 sous-requêtes permises par
// invocation en plan Workers Free. Un usage normal n'en demande qu'une
// poignée (un titre coché, un titre ajouté à une liste) ; au-delà (vieille
// liste jamais vérifiée), le reste est vérifié aux écritures suivantes.
export const MAX_FETCHES_PER_WRITE = 20;

// Langues TMDB des titres, comme côté client (TMDB_LANGUAGE_BY_LOCALE dans
// src/core/api/tmdbClient.ts) : le cache est tenu par langue, le titre et
// l'affiche dépendant de la langue de l'interface.
const TMDB_LANGUAGE_BY_LOCALE: Record<string, string> = { fr: "fr-FR", en: "en-US" };
const DEFAULT_TMDB_LANGUAGE = "fr-FR";
const TMDB_LANGUAGES = new Set(Object.values(TMDB_LANGUAGE_BY_LOCALE));

// Langue de l'écriture : celle que le client annonce (en-tête, seulement une
// des langues de l'app)...
export function declaredTitleLanguage(value: string | null): string | null {
  return value && TMDB_LANGUAGES.has(value) ? value : null;
}

// ...sinon celle du compte (users.locale), sinon le français.
export function accountTitleLanguage(locale: string | null): string {
  return (locale && TMDB_LANGUAGE_BY_LOCALE[locale]) || DEFAULT_TMDB_LANGUAGE;
}

export function titleKeyOf(key: TitleKey): string {
  return `${key.mediaType}:${key.id}`;
}

export function isFresh(entry: CachedTitle, now: number): boolean {
  return now - entry.fetchedAt < (entry.found ? FOUND_TTL_MS : MISSING_TTL_MS);
}

const MAX_TITLE_LENGTH = 300;
const MAX_POSTER_PATH_LENGTH = 200;
const MAX_GENRES = 20;

interface TmdbDetails {
  title?: unknown;
  name?: unknown;
  original_title?: unknown;
  original_name?: unknown;
  poster_path?: unknown;
  genres?: unknown;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// Fiche TMDB (/movie/<id> ou /tv/<id>) → ce que stocke un item. Mêmes
// bornes que worker/validate.ts (sanitizeItem) pour un item envoyé par le
// client.
export function metadataFromTmdbDetails(mediaType: MediaTypeStr, data: unknown): TitleMetadata {
  const details = (data && typeof data === "object" ? data : {}) as TmdbDetails;
  const title =
    mediaType === "movie"
      ? (nonEmptyString(details.title) ?? nonEmptyString(details.original_title))
      : (nonEmptyString(details.name) ?? nonEmptyString(details.original_name));
  const posterPath =
    typeof details.poster_path === "string" &&
    details.poster_path.startsWith("/") &&
    details.poster_path.length <= MAX_POSTER_PATH_LENGTH
      ? details.poster_path
      : null;
  const genreIds = Array.isArray(details.genres)
    ? details.genres
        .map((genre) => Number((genre as { id?: unknown } | null)?.id))
        .filter((id) => Number.isInteger(id) && id > 0)
        .slice(0, MAX_GENRES)
    : [];
  return { title: title ? title.slice(0, MAX_TITLE_LENGTH) : null, posterPath, genreIds };
}

// Fiches de `keys` (doublons ignorés) : le cache d'abord, puis TMDB pour les
// titres absents ou périmés, dans la limite de `maxFetches` appels et dans
// l'ordre de `keys` (l'appelant y met d'abord ce qui compte le plus). Une
// fiche périmée qu'on n'a pas pu relire sert encore : elle vient toujours de
// TMDB. Ne lève pas : un cache illisible ou impossible à écrire fait juste
// passer par TMDB, ou laisser l'item tel quel.
export async function resolveTitles(
  keys: TitleKey[],
  language: string,
  source: TitleSource,
  now: number,
  maxFetches = MAX_FETCHES_PER_WRITE
): Promise<Map<string, TitleResolution>> {
  const unique = new Map<string, TitleKey>();
  for (const key of keys) {
    unique.set(titleKeyOf(key), { mediaType: key.mediaType, id: key.id });
  }
  const resolutions = new Map<string, TitleResolution>();
  if (unique.size === 0) {
    return resolutions;
  }
  const cached = await source.read([...unique.values()], language).catch(() => new Map());

  const toFetch: TitleKey[] = [];
  let canFetch = maxFetches > 0;
  for (const [k, key] of unique) {
    const entry = cached.get(k) as CachedTitle | undefined;
    if (entry && isFresh(entry, now)) {
      resolutions.set(
        k,
        entry.found ? { status: "found", meta: entry.meta } : { status: "missing" }
      );
    } else if (canFetch) {
      canFetch = source.allowFetch();
      if (canFetch) {
        toFetch.push(key);
        canFetch = toFetch.length < maxFetches;
      }
    }
  }

  const fetched = await Promise.all(
    toFetch.map(async (key) => ({
      key,
      result: await source.fetch(key, language).catch((): FetchedTitle => ({ status: "error" })),
    }))
  );
  const writes: Array<{ key: TitleKey; entry: CachedTitle }> = [];
  for (const { key, result } of fetched) {
    if (result.status === "found") {
      resolutions.set(titleKeyOf(key), { status: "found", meta: result.meta });
      writes.push({ key, entry: { found: true, meta: result.meta, fetchedAt: now } });
    } else if (result.status === "missing") {
      resolutions.set(titleKeyOf(key), { status: "missing" });
      writes.push({ key, entry: { found: false, fetchedAt: now } });
    }
  }
  if (writes.length > 0) {
    await source.write(writes, language).catch(() => undefined);
  }

  for (const k of unique.keys()) {
    if (resolutions.has(k)) {
      continue;
    }
    // Pas relu (budget, erreur TMDB) : une fiche trouvée, même périmée, sert
    // encore. Un ancien 404 ne suffit pas à écarter un titre.
    const stale = cached.get(k) as CachedTitle | undefined;
    resolutions.set(
      k,
      stale?.found ? { status: "found", meta: stale.meta } : { status: "unverified" }
    );
  }
  return resolutions;
}

export interface TitleFields {
  mediaType: MediaTypeStr;
  id: number;
  title: string;
  posterPath: string | null;
  genreIds: number[];
}

// Item à écrire d'après la fiche TMDB : `null` si TMDB ne connaît pas le
// titre (item écarté), sinon l'item avec le titre, l'affiche et les genres de
// TMDB. La date n'est pas reprise : l'item stocke la date de sortie en salle
// de la région de l'utilisateur quand elle est connue (voir DetailPage),
// différente de la date TMDB mondiale ; worker/validate.ts n'en accepte
// déjà plus que le format AAAA-MM-JJ.
export function canonicalItem<T extends TitleFields>(
  item: T,
  resolution: TitleResolution | undefined
): T | null {
  if (resolution?.status === "missing") {
    return null;
  }
  if (resolution?.status !== "found") {
    return item;
  }
  const { meta } = resolution;
  return {
    ...item,
    title: meta.title ?? item.title,
    posterPath: meta.posterPath,
    genreIds: meta.genreIds,
  };
}

export function canonicalItems<T extends TitleFields>(
  items: T[],
  resolutions: Map<string, TitleResolution>
): T[] {
  return items.flatMap((item) => {
    const canonical = canonicalItem(item, resolutions.get(titleKeyOf(item)));
    return canonical ? [canonical] : [];
  });
}
