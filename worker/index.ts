import {
  upsertSubscription,
  deleteSubscription,
  deleteSubscriptionById,
  replaceWatchlist,
  replaceGenrePreferences,
  applyWatchlistChanges,
  applyGenrePreferenceChanges,
  getSubscriptionIdByEndpoint,
  getAllSubscriptions,
  getLibraryForUser,
  getWatchedKeys,
  replaceLibraryForUser,
  applyLibraryChanges,
  getCustomListsForUser,
  replaceCustomListsForUser,
  getListSharesForUser,
  shareListForUser,
  unshareListForUser,
  getPublicListBySlug,
  updateDisplayName,
  setShareSlug,
  getPublicProfile,
  setUsername,
  isUsernameAvailable,
  getSharedProfileEmail,
  getTopPicks,
  setTopPicks,
  TOP_PICKS_MAX,
  getExcludedGenresForUser,
  replaceExcludedGenresForUser,
  getFavoriteProvidersForUser,
  replaceFavoriteProvidersForUser,
  getFavoriteLanguagesForUser,
  replaceFavoriteLanguagesForUser,
  getFavoriteCountriesForUser,
  replaceFavoriteCountriesForUser,
  getLocaleForUser,
  setLocaleForUser,
  getRegionForUser,
  setRegionForUser,
  updateSubscriptionLocale,
  linkSubscriptionToAccount,
  getSubscriptionsForUser,
  deleteUserAccount,
  exportUserAccountData,
  type SubscriptionAccount,
} from "./db.ts";
import { notifyUser } from "./notify.ts";
import { runDailyCheck } from "./scheduled.ts";
import { searchLocalIndex, syncPopularTitles } from "./search-index.ts";
import { sendPush, ExpiredSubscriptionError } from "./push.ts";
import {
  isValidEmail,
  createMagicLink,
  consumeMagicLink,
  consumeMagicLinkByCode,
  findOrCreateUser,
  createSession,
  deleteSession,
  deleteUserSessions,
  getUserFromRequest,
  sessionCookieHeaders,
  sendMagicLinkEmail,
  createEmailChange,
  confirmEmailChange,
  isEmailUsedByAnotherUser,
  sendEmailChangeCode,
  sendEmailChangedNotice,
  type EmailLocale,
  type AuthUser,
} from "./auth.ts";

const EMAIL_LOCALES: EmailLocale[] = ["fr", "en"];

function sanitizeEmailLocale(value: unknown): EmailLocale {
  return EMAIL_LOCALES.includes(value as EmailLocale) ? (value as EmailLocale) : "fr";
}
import { checkRateLimit, getClientIp, secondsUntilWindowEnd } from "./rate-limit.ts";
import { checkRateLimitInMemory } from "./rate-limit-memory.ts";
import { WORKER_ONLY_PARAMS, isValidRegion, parseTmdbProxyRequest } from "./tmdb-proxy-policy.ts";
import { detectKnownCrawler } from "./bots.ts";
import {
  sanitizeLibraryPayload,
  sanitizeLibrarySyncPayload,
  sanitizeWatchlistItems,
  sanitizeGenrePrefs,
  sanitizeKeyList,
  sanitizeCustomListsPayload,
  sanitizeDisplayName,
  sanitizeIdList,
  sanitizeIsoCodeList,
  LANGUAGE_CODE_PATTERN,
  COUNTRY_CODE_PATTERN,
  sanitizeReminder,
  isAllowedPushEndpoint,
  isValidPushKeys,
} from "./validate.ts";
import { verifyRecaptcha } from "./recaptcha.ts";
import { getTheatricalIndex } from "./tmdb.ts";
import {
  LEGACY_PRODUCTION_HOSTNAME,
  PRODUCTION_HOSTNAME,
  REDIRECTED_TO_PRODUCTION_HOSTNAMES,
  isProductionHostname,
  withSentry,
} from "./sentry.ts";
import { logError } from "./logger.ts";
import { trackEvent } from "./analytics.ts";
import { getTheatricalDateFromDetails } from "../src/core/api/movieMeta.ts";
import type { Env } from "./types.ts";
import { openSyncSocket, publishToUser, revokeUserSockets } from "./sync.ts";
import {
  AVATAR_MAX_BYTES,
  deleteAvatar,
  getAvatar,
  getAvatarVersion,
  getSharedProfileAvatar,
  saveAvatar,
  sniffAvatarType,
} from "./avatars.ts";
import { randomShareSlug, normalizeUsername, SHARE_SLUG_PATTERN } from "./share-slug.ts";
import {
  fetchReleaseDatesCached,
  fetchWatchProvidersCached,
  type TmdbUsage,
} from "./tmdb-edge-cache.ts";
import { SECURITY_HEADERS } from "./security-headers.ts";
import { PAGE_META_ROUTE, servePageWithMeta, serveRobots, serveSitemap } from "./page-meta.ts";
import {
  follow,
  unfollow,
  getUserIdBySlug,
  getFollowCounts,
  getFollowers,
  getFollowing,
  getFeed,
  getTitleActivity,
  searchProfiles,
} from "./follows.ts";
import {
  MAX_REMINDERS,
  addReminder,
  countReminders,
  getRemindersForUser,
  removeReminder,
} from "./reminders.ts";

// Classe Durable Object de la synchro temps réel : doit être exportée par le
// module principal (voir "exports" dans wrangler.jsonc).
export { UserSyncHub } from "./sync.ts";

// `extraHeaders` accepte un tableau pour une clé (typiquement "set-cookie")
// afin de poser plusieurs cookies sur la même réponse : contrairement aux
// autres en-têtes, deux Set-Cookie ne peuvent pas être fusionnés en une
// seule ligne (invalide côté navigateur), d'où le passage par Headers.append
// plutôt que par un objet plein (qui écraserait la valeur précédente).
function json(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string | string[]> = {}
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    // Sans ça, iOS (en particulier en PWA installée sur l'écran d'accueil)
    // peut mettre en cache une réponse d'erreur (ex: 503 avant que les
    // secrets soient déployés) et continuer à la resservir après coup.
    "cache-control": "no-store",
  });
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v);
      }
    } else {
      headers.set(key, value);
    }
  }
  return new Response(JSON.stringify(data), { status, headers });
}

// Factorise le contrôle « connecté ou 401 » répété dans la plupart des
// routes authentifiées (audit M16) : les appelants font
// `if (user instanceof Response) return user;` puis utilisent `user` typé
// `AuthUser` pour le reste de la fonction.
async function requireUser(request: Request, env: Env): Promise<AuthUser | Response> {
  const user = await getUserFromRequest(env.DB, request);
  if (!user) {
    return json({ error: "Non connecté." }, 401);
  }
  return user;
}

// Corps JSON attendu sous forme d'objet : `null` pour un JSON invalide, mais
// aussi pour `null`, un tableau ou un scalaire, sur lesquels un simple
// `body.champ` lèverait une exception.
async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

// Champ texte facultatif d'un corps de requête : toute autre valeur (nombre,
// objet…) est traitée comme absente plutôt que passée telle quelle.
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// En-têtes de durcissement HTTP (CSP, HSTS…), appliqués à toute réponse /api/*
// — voir la fin de fetch() ci-dessous. Définis dans worker/security-headers.ts,
// source unique partagée avec public/_headers (assets statiques).
function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Réponses identiques pour tout visiteur, qui ne changent qu'au déploiement
// (clé publique VAPID, clé de site reCAPTCHA, DSN Sentry, jeton Web
// Analytics) : mises en cache à l'edge comme /api/theatrical-index, pour ne
// plus payer une exécution complète du Worker à chaque appel (notamment les
// crawlers, qui les rappellent à chaque page explorée — voir le ticket
// Trello "Milliers de calls workers").
async function cachedStaticJson(
  request: Request,
  ctx: ExecutionContext,
  data: unknown
): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(request.url);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }
  const response = json(data, 200, { "cache-control": "public, max-age=3600" });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// Doit rester identique à la seconde entrée de "crons" dans wrangler.jsonc.
const SEARCH_INDEX_SYNC_CRON = "30 7 * * *";

const RATE_LIMIT_RESPONSE = (): Response =>
  json({ error: "Trop de requêtes. Réessayez dans quelques minutes." }, 429);

// Variante du proxy TMDB : `retry-after` (fin de la fenêtre d'une minute de
// ses plafonds) permet à tmdbFetch de réessayer tout seul au bon moment
// plutôt que d'afficher une erreur.
const TMDB_RATE_LIMIT_RESPONSE = (): Response => {
  const retryAfter = secondsUntilWindowEnd(60_000);
  return json({ error: "Trop de requêtes. Réessayez dans quelques instants." }, 429, {
    "retry-after": String(retryAfter),
  });
};

// Ces deux endpoints restent volontairement accessibles sans compte (les
// notifications push fonctionnent pour n'importe quel visiteur, connecté ou
// non — c'est le fonctionnement voulu depuis leur conception, avant même
// l'existence des comptes). En échange : limitation de débit par IP contre
// le spam/abus, et bornage strict de la taille des payloads pour empêcher
// de gonfler la base indéfiniment.
const MAX_WATCHLIST_ITEMS = 500;
const MAX_GENRE_PREFS = 50;

// Langue des notifications push envoyées par le scheduler pour cet
// abonnement (voir migration 0005) — par défaut "fr" si absente/invalide.
const SUBSCRIPTION_LOCALES = ["fr", "en"];

function sanitizeSubscriptionLocale(value: unknown): string {
  return typeof value === "string" && SUBSCRIPTION_LOCALES.includes(value) ? value : "fr";
}

// Compte connecté sur l'appareil qui s'abonne (voir migration 0008 et
// worker/notify.ts) : permet au scheduler de livrer ses notifications
// in-app via le hub du compte. `user.id` vient uniquement du cookie de
// session (même garde IDOR que les endpoints authentifiés plus bas).
async function subscriptionAccountOf(
  request: Request,
  env: Env
): Promise<SubscriptionAccount | null> {
  const user = await getUserFromRequest(env.DB, request);
  return user ? { userId: user.id, syncHost: new URL(request.url).hostname } : null;
}

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  const ip = getClientIp(request);
  if (!(await checkRateLimit(env.DB, `subscribe:ip:${ip}`, { limit: 10, windowMs: 60 * 60_000 }))) {
    return RATE_LIMIT_RESPONSE();
  }

  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }

  const { endpoint, keys, watchlist, favoriteGenres, locale } = body as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
    watchlist?: unknown;
    favoriteGenres?: unknown;
    locale?: unknown;
  };
  if (
    typeof endpoint !== "string" ||
    !isAllowedPushEndpoint(endpoint) ||
    !isValidPushKeys(keys?.p256dh, keys?.auth)
  ) {
    return json({ error: "Abonnement push incomplet ou invalide (endpoint/keys manquants)." }, 400);
  }

  const subscriptionId = await upsertSubscription(env.DB, {
    endpoint,
    p256dh: String(keys?.p256dh),
    auth: String(keys?.auth),
    locale: sanitizeSubscriptionLocale(locale),
    account: await subscriptionAccountOf(request, env),
  });

  // Remplacement complet : correct et volontaire ici, cet appel n'a lieu
  // qu'à l'activation des notifications (une fois par appareil), jamais à
  // chaque changement — voir handleSubscribeSync ci-dessous pour la
  // resynchronisation incrémentale qui, elle, se déclenche à chaque toggle.
  await replaceWatchlist(
    env.DB,
    subscriptionId,
    sanitizeWatchlistItems(watchlist, MAX_WATCHLIST_ITEMS)
  );
  await replaceGenrePreferences(
    env.DB,
    subscriptionId,
    sanitizeGenrePrefs(favoriteGenres, MAX_GENRE_PREFS)
  );

  trackEvent(env, "notifications_enabled");
  return json({ ok: true, subscriptionId });
}

// Resynchronisation incrémentale du mirroir des notifications push : appelée
// à chaque changement de la watchlist/des genres favoris tant que les
// notifications sont actives (voir NotificationSettings), avec uniquement
// le delta depuis le dernier envoi calculé côté client — aucune lecture de
// l'état actuel n'est nécessaire ici, contrairement à handleSubscribe
// (remplacement complet, mais rare : une fois par activation).
async function handleSubscribeSync(request: Request, env: Env): Promise<Response> {
  const ip = getClientIp(request);
  if (!(await checkRateLimit(env.DB, `subscribe-sync:ip:${ip}`, { limit: 30, windowMs: 60_000 }))) {
    return RATE_LIMIT_RESPONSE();
  }

  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }

  const { endpoint, watchlistToAdd, watchlistToRemove, genresToAdd, genresToRemove } = body as {
    endpoint?: unknown;
    watchlistToAdd?: unknown;
    watchlistToRemove?: unknown;
    genresToAdd?: unknown;
    genresToRemove?: unknown;
  };
  if (typeof endpoint !== "string") {
    return json({ error: "endpoint manquant." }, 400);
  }

  const subscriptionId = await getSubscriptionIdByEndpoint(env.DB, endpoint);
  if (!subscriptionId) {
    return json({ error: "Abonnement introuvable." }, 404);
  }

  await applyWatchlistChanges(env.DB, subscriptionId, {
    add: sanitizeWatchlistItems(watchlistToAdd, MAX_WATCHLIST_ITEMS),
    remove: sanitizeKeyList(watchlistToRemove, MAX_WATCHLIST_ITEMS),
  });
  await applyGenrePreferenceChanges(env.DB, subscriptionId, {
    add: sanitizeGenrePrefs(genresToAdd, MAX_GENRE_PREFS),
    remove: sanitizeKeyList(genresToRemove, MAX_GENRE_PREFS),
  });

  return json({ ok: true });
}

async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  const ip = getClientIp(request);
  if (
    !(await checkRateLimit(env.DB, `unsubscribe:ip:${ip}`, { limit: 10, windowMs: 60 * 60_000 }))
  ) {
    return RATE_LIMIT_RESPONSE();
  }

  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  if (typeof body.endpoint !== "string") {
    return json({ error: "endpoint manquant." }, 400);
  }
  await deleteSubscription(env.DB, body.endpoint);
  return json({ ok: true });
}

// Connexion/déconnexion sur un appareil dont les notifications sont déjà
// actives (voir usePushAccountLink côté client) : rattache l'abonnement au
// compte désormais connecté, ou l'en détache — un appareil déconnecté ne
// reçoit plus les notifications du compte. Comme les autres endpoints
// /api/subscribe*, la connaissance de l'endpoint (URL secrète propre à
// l'appareil) fait office d'autorisation ; le compte, lui, ne peut être que
// celui de la session.
async function handleLinkSubscriptionAccount(request: Request, env: Env): Promise<Response> {
  const ip = getClientIp(request);
  if (
    !(await checkRateLimit(env.DB, `subscribe-account:ip:${ip}`, { limit: 30, windowMs: 60_000 }))
  ) {
    return RATE_LIMIT_RESPONSE();
  }

  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  if (typeof body.endpoint !== "string") {
    return json({ error: "endpoint manquant." }, 400);
  }

  const account = await subscriptionAccountOf(request, env);
  const updated = await linkSubscriptionToAccount(env.DB, body.endpoint, account);
  if (!updated) {
    return json({ error: "Abonnement introuvable." }, 404);
  }
  return json({ ok: true, linked: account !== null });
}

// Changement de langue pendant que les notifications sont déjà actives (voir
// NotificationSettings) : met à jour la locale de l'abonnement sans repasser
// par un resubscribe complet côté navigateur.
async function handleUpdateSubscriptionLocale(request: Request, env: Env): Promise<Response> {
  const ip = getClientIp(request);
  if (
    !(await checkRateLimit(env.DB, `subscribe-locale:ip:${ip}`, { limit: 30, windowMs: 60_000 }))
  ) {
    return RATE_LIMIT_RESPONSE();
  }

  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  if (typeof body.endpoint !== "string") {
    return json({ error: "endpoint manquant." }, 400);
  }

  const updated = await updateSubscriptionLocale(
    env.DB,
    body.endpoint,
    sanitizeSubscriptionLocale(body.locale)
  );
  if (!updated) {
    return json({ error: "Abonnement introuvable." }, 404);
  }
  return json({ ok: true });
}

// Notification de test pour le compte connecté, envoyée depuis les réglages
// via notifyUser : même choix de canal que le cron (in-app si un appareil du
// compte a l'app ouverte, sinon Web Push), pour le vérifier sans attendre
// une vraie sortie. `delaySeconds` laisse le temps de fermer l'app pour
// tester le repli Web Push (waitUntil garde le Worker en vie jusqu'à 30 s
// après la réponse). Limité au compte de la session, donc sans clé de
// debug, mais rate-limité.
const TEST_NOTIFICATION_MAX_DELAY_S = 20;

async function handleTestAccountNotification(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Outil de validation réservé aux previews PR et au dev local : l'UI le
  // masque en prod, on le ferme aussi ici pour qu'il ne soit pas appelable.
  if (isProductionHostname(new URL(request.url).hostname)) {
    return json({ error: "Introuvable." }, 404);
  }
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  if (
    !(await checkRateLimit(env.DB, `test-notification:user:${user.id}`, {
      limit: 10,
      windowMs: 10 * 60_000,
    }))
  ) {
    return RATE_LIMIT_RESPONSE();
  }

  // Corps absent : envoi immédiat.
  const body = (await readJsonObject(request)) ?? {};
  const delaySeconds =
    typeof body.delaySeconds === "number" && Number.isFinite(body.delaySeconds)
      ? Math.min(Math.max(Math.round(body.delaySeconds), 0), TEST_NOTIFICATION_MAX_DELAY_S)
      : 0;

  // Sans abonnement push, le test in-app reste possible : le hub temps réel
  // de l'hôte courant est visé directement (`syncHost`), comme pour un
  // nouvel abonné. Le test différé, lui, sert à vérifier le repli Web Push.
  const subscriptions = await getSubscriptionsForUser(env.DB, user.id);
  const noPushError = json(
    { error: "Aucun appareil de votre compte n'a activé les notifications push." },
    404
  );
  if (subscriptions.length === 0 && delaySeconds > 0) {
    return noPushError;
  }

  const send = () =>
    notifyUser(
      env,
      { userId: user.id, subscriptions, syncHost: new URL(request.url).hostname },
      { kind: "test", mediaTitle: "", url: "/profil" }
    );

  if (delaySeconds > 0) {
    ctx.waitUntil(new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000)).then(send));
    return json({ ok: true, scheduledInSeconds: delaySeconds });
  }
  const channel = await send();
  if (channel === "push" && subscriptions.length === 0) {
    return noPushError;
  }
  return json({ ok: true, channel });
}

// Comparaison en temps constant d'une clé de debug (évite qu'une différence
// de durée de réponse ne laisse deviner la clé secrète octet par octet,
// audit F2). Passe par un hachage pour que `timingSafeEqual` compare toujours
// deux tampons de même longueur, quelle que soit celle des chaînes d'origine.
async function timingSafeEqualString(received: string | null, expected: string): Promise<boolean> {
  if (received === null) {
    return false;
  }
  const encoder = new TextEncoder();
  const [receivedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(receivedHash, expectedHash);
}

// Déclenchement manuel de la vérification quotidienne, pour diagnostiquer
// sans attendre le prochain passage du cron. Protégé par une clé partagée
// pour éviter qu'un tiers ne déclenche des requêtes TMDB / push à volonté ;
// désactivé par défaut si la clé n'est pas configurée. Le travail est confié
// à `waitUntil` (comme le vrai cron) : la requête HTTP ne reste pas ouverte
// le temps de toute la vérification quotidienne (audit F2).
async function handleManualRun(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const expected = env.DEBUG_TRIGGER_KEY;
  if (!expected || !(await timingSafeEqualString(request.headers.get("x-debug-key"), expected))) {
    return json({ error: "Non autorisé." }, 401);
  }
  ctx.waitUntil(runDailyCheck(env));
  return json({ ok: true });
}

// Déclenche la synchro de l'index local de recherche (voir search-index.ts)
// sans attendre le prochain passage du cron dédié. Même protection que
// /api/run-check.
async function handleManualSyncSearchIndex(request: Request, env: Env): Promise<Response> {
  const expected = env.DEBUG_TRIGGER_KEY;
  if (!expected || !(await timingSafeEqualString(request.headers.get("x-debug-key"), expected))) {
    return json({ error: "Non autorisé." }, 401);
  }
  await syncPopularTitles(env);
  return json({ ok: true });
}

// Filtre "commence par" sur l'index local des titres populaires (voir
// search-index.ts) : complète searchMultiRanked côté client pour les
// requêtes courtes, que TMDB ne fait pas remonter par préfixe. Rate-limité
// comme le proxy TMDB (même raison : endpoint public, pas d'auth).
async function handleSearchIndex(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) {
    return json({ results: [] });
  }
  const ip = getClientIp(request);
  if (!checkRateLimitInMemory(`search-index:ip:${ip}`, { limit: 60, windowMs: 60_000 })) {
    return json({ error: "Trop de requêtes." }, 429);
  }
  const results = await searchLocalIndex(env, q);
  return json({ results });
}

// Déclenche un envoi de test vers Sentry, pour vérifier la chaîne de
// remontée d'erreurs (SDK Worker, DSN, projet Sentry) sans attendre qu'une
// vraie erreur survienne en prod. Même protection que /api/run-check.
async function handleTestError(request: Request, env: Env): Promise<Response> {
  const expected = env.DEBUG_TRIGGER_KEY;
  if (!expected || !(await timingSafeEqualString(request.headers.get("x-debug-key"), expected))) {
    return json({ error: "Non autorisé." }, 401);
  }
  logError(
    "Erreur de test",
    new Error("Erreur de test — déclenchée manuellement via /api/test-error")
  );
  return json({ ok: true });
}

// Envoie une notification de test à UN SEUL abonnement (?subscriptionId=…),
// pour vérifier que toute la chaîne fonctionne (VAPID, service worker,
// permission navigateur) sans dépendre de la logique métier. Ciblé plutôt que
// diffusé à tous les abonnés de la prod (audit F2 : un appel par erreur ne
// doit pas spammer toute la base).
async function handleTestNotification(request: Request, env: Env): Promise<Response> {
  const expected = env.DEBUG_TRIGGER_KEY;
  if (!expected || !(await timingSafeEqualString(request.headers.get("x-debug-key"), expected))) {
    return json({ error: "Non autorisé." }, 401);
  }

  const subscriptionId = Number(new URL(request.url).searchParams.get("subscriptionId"));
  if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
    return json(
      {
        error:
          "Paramètre ?subscriptionId=<id> requis (évite un envoi à tous les abonnés par erreur).",
      },
      400
    );
  }

  const subscriptions = await getAllSubscriptions(env.DB);
  const subscription = subscriptions.find((s) => s.id === subscriptionId);
  if (!subscription) {
    return json({ error: "Abonnement introuvable." }, 404);
  }

  try {
    await sendPush(
      subscription,
      {
        title: "Seancy 🎬",
        body: "Ceci est une notification de test — si vous la voyez, tout fonctionne !",
        url: "/ma-liste",
      },
      env
    );
    return json({ results: [{ id: subscription.id, ok: true }] });
  } catch (err) {
    if (err instanceof ExpiredSubscriptionError) {
      await deleteSubscriptionById(env.DB, subscription.id);
    }
    return json({
      results: [
        { id: subscription.id, ok: false, error: err instanceof Error ? err.message : String(err) },
      ],
    });
  }
}

// Compte (lien magique) ---------------------------------------------------

async function handleRequestLink(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  const email = String(body?.email || "")
    .trim()
    .toLowerCase();
  if (!isValidEmail(email)) {
    return json({ error: "Adresse email invalide." }, 400);
  }
  const locale = sanitizeEmailLocale(body?.locale);

  const recaptcha = await verifyRecaptcha(env, optionalString(body.recaptchaToken), "request_link");
  if (!recaptcha.ok) {
    return json({ error: "Vérification anti-robot échouée. Réessayez." }, 403);
  }

  // Par email (empêche de spammer la boîte mail d'un tiers) ET par IP
  // (empêche un seul client de solliciter l'endpoint en boucle avec des
  // emails différents).
  const ip = getClientIp(request);
  const withinLimits = await Promise.all([
    checkRateLimit(env.DB, `link:email:${email}:m`, { limit: 1, windowMs: 60_000 }),
    checkRateLimit(env.DB, `link:email:${email}:h`, { limit: 5, windowMs: 60 * 60_000 }),
    checkRateLimit(env.DB, `link:ip:${ip}:h`, { limit: 20, windowMs: 60 * 60_000 }),
  ]);
  if (withinLimits.some((ok) => !ok)) {
    return RATE_LIMIT_RESPONSE();
  }

  const { token, code } = await createMagicLink(env.DB, email);
  const requestUrl = new URL(request.url);
  const link = `${requestUrl.origin}/auth/verify?token=${token}`;

  try {
    const { skipped } = await sendMagicLinkEmail(env, email, link, code, locale);
    // Sans RESEND_API_KEY (dev local) ou hors prod (previews PR incluses) :
    // pas de vraie boîte mail de test à disposition, donc on renvoie le lien
    // et le code directement pour pouvoir tester le flux de connexion.
    // isProductionHostname ne peut jamais matcher un hostname de preview, ce
    // qui garantit que ce cas ne se produit jamais en production.
    const showDevCredentials = skipped || !isProductionHostname(requestUrl.hostname);
    return json({
      ok: true,
      devLink: showDevCredentials ? link : undefined,
      devCode: showDevCredentials ? code : undefined,
    });
  } catch (err) {
    // L'erreur brute d'un service tiers (Resend) ne doit jamais atteindre le
    // client : elle peut révéler des détails de config (mode test, domaine
    // vérifié...) voire, selon le cas, l'email associé au compte. On la
    // journalise côté serveur et on renvoie un message générique.
    logError("Échec de l'envoi du lien de connexion :", err);
    return json(
      { error: "Impossible d'envoyer le lien de connexion pour le moment. Réessayez plus tard." },
      502
    );
  }
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
  // Limite par IP les tentatives de vérification (jeton ou code) : c'est la
  // seule protection efficace contre un bruteforce du code court à 6
  // caractères (32^6 ≈ 1 milliard de combinaisons — déjà solide seule, mais
  // sans limite de débit un bruteforce distribué reste théoriquement
  // possible pendant la fenêtre de validité de 15 min).
  const ip = getClientIp(request);
  if (!(await checkRateLimit(env.DB, `verify:ip:${ip}`, { limit: 10, windowMs: 15 * 60_000 }))) {
    return RATE_LIMIT_RESPONSE();
  }

  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  const token = optionalString(body.token);
  const code = optionalString(body.code);
  if (!token && !code) {
    return json({ error: "Jeton ou code manquant." }, 400);
  }
  // Code court : lié à l'adresse qui l'a demandé, avec une limite de
  // tentatives par adresse en plus de celle par IP, qu'un bruteforce
  // distribué contourne (audit M2). Le jeton du lien (256 bits) n'en a pas
  // besoin.
  const codeEmail = String(body.email || "")
    .trim()
    .toLowerCase();
  if (!token) {
    if (!isValidEmail(codeEmail)) {
      return json({ error: "Adresse email invalide." }, 400);
    }
    if (
      !(await checkRateLimit(env.DB, `verify:email:${codeEmail}`, {
        limit: 10,
        windowMs: 15 * 60_000,
      }))
    ) {
      return RATE_LIMIT_RESPONSE();
    }
  }

  const recaptcha = await verifyRecaptcha(env, optionalString(body.recaptchaToken), "verify");
  if (!recaptcha.ok) {
    return json({ error: "Vérification anti-robot échouée. Réessayez." }, 403);
  }

  const email = token
    ? await consumeMagicLink(env.DB, token)
    : await consumeMagicLinkByCode(env.DB, codeEmail, code);
  if (!email) {
    return json(
      {
        error: code
          ? "Ce code est invalide, expiré, ou déjà utilisé."
          : "Ce lien de connexion est invalide, expiré, ou déjà utilisé.",
      },
      400
    );
  }

  const user = await findOrCreateUser(env.DB, email);
  const sessionToken = await createSession(env.DB, user.id);

  return json(
    {
      ok: true,
      email: user.email,
      displayName: user.displayName,
      shareSlug: user.shareSlug,
      username: user.username,
      avatarVersion: await getAvatarVersion(env.DB, user.id),
    },
    200,
    { "set-cookie": sessionCookieHeaders(request, sessionToken) }
  );
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  return json(
    {
      email: user.email,
      displayName: user.displayName,
      shareSlug: user.shareSlug,
      username: user.username,
      avatarVersion: await getAvatarVersion(env.DB, user.id),
    },
    200,
    // Session ouverte sous les anciens noms de cookies (bobine_*) : appelé à
    // chaque démarrage de l'app, c'est ici qu'elle passe aux nouveaux noms.
    user.legacyCookie
      ? { "set-cookie": sessionCookieHeaders(request, user.sessionToken, user.expiresAt) }
      : undefined
  );
}

// Photo de profil personnelle (ticket « Ajouter son propre avatar ») --------
//
// Même garde IDOR que le reste : le compte vient uniquement du cookie. Le
// client ajoute la version à l'URL (?v=<updated_at>), d'où un cache long :
// une nouvelle photo change l'URL.
async function handleGetOwnAvatar(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const avatar = await getAvatar(env.DB, user.id);
  if (!avatar) {
    return new Response(null, { status: 404, headers: { "cache-control": "private, no-store" } });
  }
  return new Response(avatar.data, {
    headers: {
      "content-type": avatar.contentType,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

// Corps = l'image elle-même (déjà recadrée en 256 px par le navigateur), pas
// du JSON. Le format réel est vérifié sur les octets (voir worker/avatars.ts).
async function handlePutAvatar(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  if (!(await env.AVATAR_RATE_LIMITER.limit({ key: `avatar:user:${user.id}` })).success) {
    return RATE_LIMIT_RESPONSE();
  }
  if (Number(request.headers.get("content-length") ?? 0) > AVATAR_MAX_BYTES) {
    return json({ error: "Image trop lourde.", reason: "too-large" }, 413);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > AVATAR_MAX_BYTES) {
    return json({ error: "Image trop lourde.", reason: "too-large" }, 413);
  }
  const contentType = sniffAvatarType(bytes);
  if (!contentType) {
    return json({ error: "Format d'image non pris en charge.", reason: "invalid" }, 400);
  }
  const avatarVersion = await saveAvatar(env.DB, user.id, contentType, bytes);
  // Les autres appareils rechargent /api/auth/me, qui porte la version.
  publishToUser(request, user.id, { type: "display-name" });
  return json({ ok: true, avatarVersion });
}

async function handleDeleteAvatar(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  await deleteAvatar(env.DB, user.id);
  publishToUser(request, user.id, { type: "display-name" });
  return json({ ok: true, avatarVersion: null });
}

// Nom affiché (ticket #45) : mis à jour uniquement sur un save manuel côté
// client (bouton "Enregistrer" d'AccountCard), jamais en synchro automatique.
// Même garde IDOR que les autres endpoints authentifiés ci-dessous :
// user.id vient uniquement du cookie de session.
async function handleUpdateDisplayName(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  const displayName = sanitizeDisplayName(body?.displayName);
  if (displayName === null) {
    return json({ error: "Nom affiché invalide." }, 400);
  }
  await updateDisplayName(env.DB, user.id, displayName);
  publishToUser(request, user.id, { type: "display-name" });
  return json({ ok: true, displayName });
}

// Changement d'adresse email (ticket « modifier l'adresse mail ») ---------
//
// En deux temps, depuis une session déjà ouverte : 1) request envoie un code
// à la NOUVELLE adresse (preuve qu'on la contrôle), 2) confirm applique le
// changement si le code correspond à la demande en attente du compte, puis
// avertit l'ANCIENNE adresse. Les sessions en cours restent ouvertes. Même
// garde IDOR que les autres endpoints authentifiés : user.id vient
// uniquement du cookie de session.
async function handleRequestEmailChange(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  const newEmail = String(body?.email || "")
    .trim()
    .toLowerCase();
  if (!isValidEmail(newEmail)) {
    return json({ error: "Adresse email invalide.", reason: "invalid" }, 400);
  }
  if (newEmail === user.email) {
    return json({ error: "C'est déjà votre adresse actuelle.", reason: "same" }, 400);
  }
  const locale = sanitizeEmailLocale(body?.locale);

  // Par compte (évite de s'en servir pour sonder quelles adresses ont un
  // compte, voir plus bas) ET par adresse cible (évite de spammer la boîte
  // d'un tiers). Pas de limite par minute sur le compte : corriger une faute
  // de frappe ou essayer une autre adresse juste après doit rester possible
  // (retour de review : « trop de tentatives » à chaque essai).
  const limits = [
    { key: `email-change:user:${user.id}:h`, limit: 10, windowMs: 60 * 60_000 },
    { key: `email-change:email:${newEmail}:m`, limit: 1, windowMs: 60_000 },
    { key: `email-change:email:${newEmail}:h`, limit: 5, windowMs: 60 * 60_000 },
  ];
  const withinLimits = await Promise.all(
    limits.map(({ key, limit, windowMs }) => checkRateLimit(env.DB, key, { limit, windowMs }))
  );
  if (withinLimits.some((ok) => !ok)) {
    // Le client affiche le délai exact plutôt que « quelques minutes ».
    const retryAfter = Math.max(
      ...limits.filter((_, i) => !withinLimits[i]).map((l) => secondsUntilWindowEnd(l.windowMs))
    );
    return json({ error: "Trop de tentatives.", reason: "rate-limited", retryAfter }, 429, {
      "retry-after": String(retryAfter),
    });
  }

  // Deux comptes ne peuvent pas partager une adresse (index unique sur
  // users.email). Le dire explicitement révèle qu'un compte existe à cette
  // adresse, mais seulement à un membre connecté et au débit ci-dessus.
  if (await isEmailUsedByAnotherUser(env.DB, newEmail, user.id)) {
    return json(
      { error: "Cette adresse est déjà utilisée par un autre compte.", reason: "taken" },
      409
    );
  }

  const code = await createEmailChange(env.DB, user.id, newEmail);
  try {
    const { skipped } = await sendEmailChangeCode(env, newEmail, code, locale);
    // Même logique que handleRequestLink : le code n'est renvoyé que sans
    // RESEND_API_KEY (dev local) ou hors prod (previews PR incluses).
    const showDevCode = skipped || !isProductionHostname(new URL(request.url).hostname);
    return json({ ok: true, email: newEmail, devCode: showDevCode ? code : undefined });
  } catch (err) {
    logError("Échec de l'envoi du code de changement d'adresse :", err);
    return json(
      { error: "Impossible d'envoyer le code pour le moment. Réessayez plus tard." },
      502
    );
  }
}

async function handleConfirmEmailChange(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  // Seule vraie protection contre un bruteforce du code à 6 caractères,
  // comme pour /api/auth/verify.
  if (
    !(await checkRateLimit(env.DB, `email-change-confirm:user:${user.id}`, {
      limit: 10,
      windowMs: 15 * 60_000,
    }))
  ) {
    const retryAfter = secondsUntilWindowEnd(15 * 60_000);
    return json({ error: "Trop de tentatives.", reason: "rate-limited", retryAfter }, 429, {
      "retry-after": String(retryAfter),
    });
  }
  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  const result = await confirmEmailChange(env.DB, user.id, optionalString(body.code));
  if (!result.ok) {
    return result.reason === "taken"
      ? json(
          { error: "Cette adresse est déjà utilisée par un autre compte.", reason: "taken" },
          409
        )
      : json(
          { error: "Ce code est invalide, expiré, ou déjà utilisé.", reason: "invalid-code" },
          400
        );
  }
  try {
    await sendEmailChangedNotice(
      env,
      result.oldEmail,
      result.newEmail,
      sanitizeEmailLocale(body?.locale)
    );
  } catch (err) {
    // Le changement est déjà fait : un échec de l'avertissement ne doit pas
    // le faire passer pour raté côté client.
    logError("Échec de l'envoi de l'avertissement de changement d'adresse :", err);
  }
  // Les autres appareils sont déconnectés (audit M1) : si l'ancienne adresse
  // était compromise, ses sessions ne doivent pas survivre au changement.
  await deleteUserSessions(env.DB, user.id, user.sessionToken);
  await revokeUserSockets(request, user.id, "others");
  return json({ ok: true, email: result.newEmail });
}

// Pseudo public (ticket « Ajoute de pseudo ») -----------------------------
//
// Facultatif et unique ; une fois choisi il devient l'URL du profil partagé
// (/u/<pseudo>) à la place du slug aléatoire. La disponibilité est vérifiée
// pendant la saisie (GET, plafonné par compte pour ne pas servir à lister
// les pseudos existants), puis de nouveau à l'enregistrement (PUT), où
// l'index unique fait foi.
async function handleUsernameAvailability(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  if (!checkRateLimitInMemory(`username-check:user:${user.id}`, { limit: 60, windowMs: 60_000 })) {
    return RATE_LIMIT_RESPONSE();
  }
  const username = normalizeUsername(new URL(request.url).searchParams.get("username"));
  if (username === null) {
    return json({ username: null, available: false, reason: "invalid" });
  }
  const available = await isUsernameAvailable(env.DB, username, user.id);
  return json({ username, available, reason: available ? null : "taken" });
}

async function handleUpdateUsername(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  // Chaîne vide ou null : retire le pseudo (le lien de partage repasse sur
  // le slug aléatoire).
  const raw = body?.username;
  const clearing = raw === null || (typeof raw === "string" && raw.trim() === "");
  const username = clearing ? null : normalizeUsername(raw);
  if (!clearing && username === null) {
    return json({ error: "Pseudo invalide.", reason: "invalid" }, 400);
  }
  if (username !== user.username && !(await setUsername(env.DB, user.id, username))) {
    return json({ error: "Ce pseudo est déjà pris.", reason: "taken" }, 409);
  }
  // Même événement que le nom affiché : les autres appareils rechargent
  // /api/auth/me, qui porte aussi le pseudo.
  publishToUser(request, user.id, { type: "display-name" });
  return json({ ok: true, username });
}

// Partage public du profil (lecture seule) -------------------------------
//
// Opt-in explicite : activer génère un slug aléatoire (96 bits, non
// devinable) qui devient l'URL publique /u/<slug> ; désactiver le remet à
// NULL, ce qui invalide l'ancien lien. Réactiver en génère un nouveau plutôt
// que de ressusciter l'ancien, pour qu'un lien révoqué le reste (seul
// /u/<pseudo>, qui dépend du pseudo et pas du slug, redevient joignable si
// le pseudo n'a pas changé entre-temps). Même garde
// IDOR que les autres endpoints authentifiés : user.id vient uniquement du
// cookie de session.
async function handleUpdateProfileShare(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  if (typeof body?.enabled !== "boolean") {
    return json({ error: 'Paramètre "enabled" invalide.' }, 400);
  }
  // Déjà actif : on garde le lien existant (déjà potentiellement envoyé).
  const shareSlug = body.enabled ? (user.shareSlug ?? randomShareSlug()) : null;
  if (shareSlug !== user.shareSlug) {
    await setShareSlug(env.DB, user.id, shareSlug);
  }
  return json({ ok: true, shareSlug });
}

// Top 5 du profil partagé choisi à la main, façon « films favoris » de
// Letterboxd. Seuls des titres « vus » du compte sont acceptés ; l'ordre du
// tableau est l'ordre d'affichage.
async function handleGetTopPicks(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  return json({ topPicks: await getTopPicks(env.DB, user.id) });
}

async function handlePutTopPicks(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  if (!Array.isArray(body?.topPicks) || body.topPicks.length > TOP_PICKS_MAX) {
    return json({ error: 'Paramètre "topPicks" invalide.' }, 400);
  }
  const keys = [
    ...new Set(sanitizeKeyList(body.topPicks, TOP_PICKS_MAX).map((k) => `${k.mediaType}:${k.id}`)),
  ];
  // Seules les clés proposées sont vérifiées, pas toute la bibliothèque (audit M6).
  const watched = await getWatchedKeys(env.DB, user.id, keys);
  const topPicks = keys.filter((key) => watched.has(key));
  await setTopPicks(env.DB, user.id, topPicks);
  return json({ ok: true, topPicks });
}

// Rappels « Me prévenir » (migration 0014, worker/reminders.ts) ----------
async function handleGetReminders(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  return json({ reminders: await getRemindersForUser(env.DB, user.id) });
}

async function handlePutReminder(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  if (
    !(await checkRateLimit(env.DB, `reminders:user:${user.id}`, {
      limit: 300,
      windowMs: 60 * 60_000,
    }))
  ) {
    return RATE_LIMIT_RESPONSE();
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON invalide." }, 400);
  }
  const reminder = sanitizeReminder(body);
  if (!reminder) {
    return json({ error: "Rappel invalide." }, 400);
  }
  if ((await countReminders(env.DB, user.id)) >= MAX_REMINDERS) {
    return json({ error: "Trop de rappels." }, 400);
  }
  await addReminder(env.DB, user.id, reminder, new URL(request.url).hostname);
  return json({ ok: true });
}

async function handleDeleteReminder(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  const [key] = sanitizeKeyList([body?.key], 1);
  if (!key) {
    return json({ error: 'Paramètre "key" invalide.' }, 400);
  }
  await removeReminder(env.DB, user.id, key.mediaType, key.id);
  return json({ ok: true });
}

// Accessible sans compte (c'est tout l'intérêt d'un lien de partage), mais
// plafonné par IP pour qu'on ne puisse pas balayer l'espace des slugs.
async function handleGetPublicProfile(request: Request, env: Env, slug: string): Promise<Response> {
  const ip = getClientIp(request);
  if (!(await env.PUBLIC_SLUG_RATE_LIMITER.limit({ key: `public-profile:ip:${ip}` })).success) {
    return RATE_LIMIT_RESPONSE();
  }
  const viewer = await getUserFromRequest(env.DB, request);
  const profile = await getPublicProfile(env.DB, slug, viewer?.id ?? null);
  if (!profile) {
    return json({ error: "Profil introuvable ou privé." }, 404);
  }
  return json(profile);
}

// Suivre des profils (migration 0011, worker/follows.ts) -----------------
//
// La cible est toujours résolue par son slug public : un profil privé ne
// peut donc pas être suivi, et aucun identifiant de compte ne transite. Le
// suiveur, lui, n'a pas besoin d'avoir partagé son propre profil.
async function handleFollow(
  request: Request,
  env: Env,
  slug: string,
  ctx: ExecutionContext
): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  if (
    !(await checkRateLimit(env.DB, `follow:user:${user.id}`, { limit: 120, windowMs: 60 * 60_000 }))
  ) {
    return RATE_LIMIT_RESPONSE();
  }
  const targetId = SHARE_SLUG_PATTERN.test(slug) ? await getUserIdBySlug(env.DB, slug) : null;
  if (targetId === null) {
    return json({ error: "Profil introuvable ou privé." }, 404);
  }
  if (targetId === user.id) {
    return json({ error: "Impossible de vous suivre vous-même." }, 400);
  }

  if (request.method === "DELETE") {
    await unfollow(env.DB, user.id, targetId);
  } else if (await follow(env.DB, user.id, targetId)) {
    ctx.waitUntil(notifyNewFollower(request, env, user, targetId));
  }
  const counts = await getFollowCounts(env.DB, targetId);
  return json({ ok: true, following: request.method !== "DELETE", counts });
}

// Au plus une notification par couple (abonné, profil suivi) et par jour :
// suivre / ne plus suivre en boucle ne doit pas spammer la personne suivie.
async function notifyNewFollower(
  request: Request,
  env: Env,
  follower: { id: number; displayName: string | null; shareSlug: string | null },
  followedId: number
): Promise<void> {
  try {
    if (
      !(await checkRateLimit(env.DB, `follow-notify:${follower.id}:${followedId}`, {
        limit: 1,
        windowMs: 24 * 60 * 60_000,
      }))
    ) {
      return;
    }
    const subscriptions = await getSubscriptionsForUser(env.DB, followedId);
    // Abonné au profil privé : ni nom ni lien vers son profil.
    const isPublic = follower.shareSlug !== null;
    await notifyUser(
      env,
      { userId: followedId, subscriptions, syncHost: new URL(request.url).hostname },
      {
        kind: "newFollower",
        mediaTitle: isPublic ? (follower.displayName ?? "") : "",
        url: isPublic ? `/u/${follower.shareSlug}` : "/profil?tab=communaute",
      }
    );
  } catch (err) {
    logError("Notification de nouvel abonné impossible :", err);
  }
}

// Listes publiques d'abonnés / d'abonnements d'un profil partagé. Même
// plafond par IP que la page de profil publique.
async function handleGetPublicFollowList(
  request: Request,
  env: Env,
  slug: string,
  kind: "followers" | "following"
): Promise<Response> {
  const ip = getClientIp(request);
  if (!(await env.PUBLIC_SLUG_RATE_LIMITER.limit({ key: `public-profile:ip:${ip}` })).success) {
    return RATE_LIMIT_RESPONSE();
  }
  const targetId = SHARE_SLUG_PATTERN.test(slug) ? await getUserIdBySlug(env.DB, slug) : null;
  if (targetId === null) {
    return json({ error: "Profil introuvable ou privé." }, 404);
  }
  const viewer = await getUserFromRequest(env.DB, request);
  const viewerId = viewer?.id ?? null;
  const profiles =
    kind === "followers"
      ? await getFollowers(env.DB, targetId, viewerId)
      : await getFollowing(env.DB, targetId, viewerId);
  return json({ profiles });
}

// Mêmes listes pour le compte connecté, que son profil soit partagé ou non.
async function handleGetAccountFollowList(
  request: Request,
  env: Env,
  kind: "followers" | "following"
): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const profiles =
    kind === "followers"
      ? await getFollowers(env.DB, user.id, user.id)
      : await getFollowing(env.DB, user.id, user.id);
  return json({ profiles });
}

async function handleGetFeed(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  return json({ entries: await getFeed(env.DB, user.id) });
}

// Bloc « Vos abonnements » de la fiche détail : qui, parmi les profils
// suivis, a vu (et noté) ou veut voir ce titre.
async function handleGetTitleActivity(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const mediaType = url.searchParams.get("mediaType");
  const tmdbId = Number(url.searchParams.get("id"));
  if (
    (mediaType !== "movie" && mediaType !== "tv") ||
    !Number.isSafeInteger(tmdbId) ||
    tmdbId <= 0
  ) {
    return json({ error: "Titre invalide." }, 400);
  }
  return json(await getTitleActivity(env.DB, user.id, mediaType, tmdbId));
}

// Recherche par nom affiché parmi les profils partagés, réservée aux
// membres connectés (c'est pour trouver qui suivre) et plafonnée pour
// qu'on ne puisse pas lister tous les profils publics à la chaîne.
const PROFILE_SEARCH_MIN_LENGTH = 2;
const PROFILE_SEARCH_MAX_LENGTH = 50;

async function handleSearchProfiles(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  if (!checkRateLimitInMemory(`profile-search:user:${user.id}`, { limit: 30, windowMs: 60_000 })) {
    return RATE_LIMIT_RESPONSE();
  }
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length < PROFILE_SEARCH_MIN_LENGTH || query.length > PROFILE_SEARCH_MAX_LENGTH) {
    return json({ profiles: [] });
  }
  return json({ profiles: await searchProfiles(env.DB, query, user.id) });
}

// Photo de profil d'un profil partagé : la photo personnelle du compte si
// elle existe, sinon Gravatar, résolu ici plutôt que
// dans le navigateur, car l'URL Gravatar contient le MD5 de l'email — un
// hash qui se retrouve facilement par dictionnaire et révélerait l'adresse
// que la page publique promet de ne jamais exposer. 404 si le profil est
// privé ou si le compte n'a ni photo ni Gravatar (la page affiche alors ses
// initiales).
async function handleGetPublicProfileAvatar(
  request: Request,
  env: Env,
  slug: string
): Promise<Response> {
  const ip = getClientIp(request);
  if (!(await env.PUBLIC_SLUG_RATE_LIMITER.limit({ key: `public-profile:ip:${ip}` })).success) {
    return RATE_LIMIT_RESPONSE();
  }
  if (!SHARE_SLUG_PATTERN.test(slug)) {
    return json({ error: "Profil introuvable ou privé." }, 404);
  }
  // Photo personnelle d'abord (cache court, pour qu'un changement se voie
  // vite), Gravatar ensuite.
  const custom = await getSharedProfileAvatar(env.DB, slug);
  if (custom) {
    return new Response(custom.data, {
      headers: {
        "content-type": custom.contentType,
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  }
  const email = await getSharedProfileEmail(env.DB, slug);
  if (!email) {
    return json({ error: "Profil introuvable ou privé." }, 404);
  }
  const digest = await crypto.subtle.digest(
    "MD5",
    new TextEncoder().encode(email.trim().toLowerCase())
  );
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const upstream = await fetch(`https://www.gravatar.com/avatar/${hash}?s=192&d=404`);
  const contentType = upstream.headers.get("content-type") || "";
  if (!upstream.ok || !contentType.startsWith("image/")) {
    return new Response(null, { status: 404, headers: { "cache-control": "public, max-age=600" } });
  }
  return new Response(upstream.body, {
    headers: { "content-type": contentType, "cache-control": "public, max-age=3600" },
  });
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const user = await getUserFromRequest(env.DB, request);
  if (user) {
    await deleteSession(env.DB, user.sessionToken);
    await revokeUserSockets(request, user.id, "self");
  }
  return json({ ok: true }, 200, {
    "set-cookie": sessionCookieHeaders(request, null),
  });
}

// « Se déconnecter de tous les appareils » (audit M1) : toutes les sessions
// du compte, y compris celle-ci, et toutes ses WebSockets de synchro. Les
// autres appareils s'en aperçoivent aussitôt (fermeture 4001, voir
// liveSync.ts) ou à leur prochaine requête.
async function handleLogoutAll(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  await deleteUserSessions(env.DB, user.id);
  await revokeUserSockets(request, user.id, "all");
  return json({ ok: true }, 200, {
    "set-cookie": sessionCookieHeaders(request, null),
  });
}

// Suppression de compte en libre-service (audit M14) : confirmation forte
// déjà faite côté client (saisie de l'adresse e-mail dans AccountSettings),
// ce endpoint ne la revérifie pas — la seule preuve d'identité qui compte
// ici est la session (cookie httpOnly), comme pour tout autre endpoint
// authentifié de ce fichier. Supprime toutes les tables liées en un seul
// batch atomique (voir deleteUserAccount), puis ferme les WebSockets du
// compte et efface le cookie de session, exactement comme une déconnexion.
async function handleDeleteAccount(request: Request, env: Env): Promise<Response> {
  const user = await getUserFromRequest(env.DB, request);
  if (!user) {
    return json({ error: "Non connecté." }, 401);
  }
  await deleteUserAccount(env.DB, user.id);
  await revokeUserSockets(request, user.id, "all");
  return json({ ok: true }, 200, {
    "set-cookie": sessionCookieHeaders(request, null),
  });
}

// Export de compte en libre-service (audit M14, droit à la portabilité) :
// un seul fichier JSON téléchargeable regroupant toutes les données
// connues du compte. `content-disposition: attachment` déclenche le
// téléchargement direct depuis un clic de lien côté client (pas besoin de
// passer par un Blob/URL.createObjectURL).
async function handleExportAccount(request: Request, env: Env): Promise<Response> {
  const user = await getUserFromRequest(env.DB, request);
  if (!user) {
    return json({ error: "Non connecté." }, 401);
  }
  const data = await exportUserAccountData(env.DB, user.id);
  if (!data) {
    return json({ error: "Non connecté." }, 401);
  }
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="seancy-export.json"',
      "cache-control": "no-store",
    },
  });
}

// Bibliothèque synchronisée ------------------------------------------------
//
// Isolation entre comptes (IDOR) : `user.id` vient UNIQUEMENT de
// getUserFromRequest (jointure sessions/users sur le cookie httpOnly), et
// c'est le seul identifiant jamais utilisé pour lire/écrire une bibliothèque
// — ni le corps de la requête, ni la query string, ni aucun header ne sont
// consultés pour ça. Un compte A ne peut donc pas cibler les données d'un
// compte B, quoi qu'il mette dans le payload (vérifié empiriquement : un
// PUT avec un `userId`/`user_id` arbitraire dans le corps est simplement
// ignoré, sanitizeLibraryPayload ne whiteliste que watched/watchlist).
// ⚠️ Si un jour un paramètre d'id explicite est ajouté ici (ex. pour une
// vue admin), il doit être validé contre `user.id` et jamais faire
// confiance à une valeur fournie par le client sans ce contrôle.
async function handleGetLibrary(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const library = await getLibraryForUser(env.DB, user.id);
  return json(library);
}

async function handlePutLibrary(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON invalide." }, 400);
  }
  // Le client est la source de vérité fonctionnelle (voir replaceLibraryForUser),
  // mais jamais la seule ligne de défense sur ce qui est écrit en base :
  // types coercés/validés, clés non prévues supprimées, tailles bornées.
  // Remplacement complet volontaire ici : cet endpoint ne sert plus qu'à la
  // fusion initiale lors d'une première connexion sur un nouvel appareil
  // (voir LibraryContext, SYNCED_FOR_KEY) — un vrai remplacement complet y
  // est correct et rare. Chaque toggle/notation/case cochée régulier passe
  // désormais par handleLibrarySync ci-dessous (delta uniquement).
  await replaceLibraryForUser(env.DB, user.id, sanitizeLibraryPayload(body));
  // Remplacement complet (fusion initiale d'un nouvel appareil) : pas de
  // delta à transmettre, les autres appareils rechargent la bibliothèque.
  publishToUser(request, user.id, { type: "library" });
  return json({ ok: true });
}

// Synchronisation incrémentale : le client envoie uniquement ce qui a
// changé depuis le dernier envoi (voir LibraryContext, pendingOpsRef) —
// aucune lecture de l'état actuel n'est nécessaire, contrairement à une
// diffusion de l'état complet qui devrait d'abord lire l'existant pour
// savoir quoi écrire. Même garde IDOR que handleGetLibrary/handlePutLibrary
// ci-dessus : user.id vient uniquement du cookie de session.
async function handleLibrarySync(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON invalide." }, 400);
  }
  const { upserts, deletes } = sanitizeLibrarySyncPayload(body);
  if (upserts.length === 0 && deletes.length === 0) {
    return json({ ok: true });
  }
  await applyLibraryChanges(env.DB, user.id, { upserts, deletes });
  if (upserts.length > 0) {
    trackEvent(env, "library_change");
  }
  // Delta transmis tel quel : les autres appareils l'appliquent directement
  // à leur état local, sans aucun aller-retour serveur.
  publishToUser(request, user.id, { type: "library", payload: { upserts, deletes } });
  return json({ ok: true });
}

// Listes personnalisées synchronisées ------------------------------------
//
// Même garde IDOR que handleGetLibrary/handlePutLibrary : user.id vient
// uniquement du cookie de session, jamais du corps de la requête.
async function handleGetCustomLists(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const customLists = await getCustomListsForUser(env.DB, user.id);
  return json(customLists);
}

// Remplacement complet à chaque appel (voir LibraryContext : anti-rebond côté
// client, un PUT par salve de changements) — pas de synchronisation
// incrémentale ici, contrairement à /api/library/sync : une liste perso
// change par opérations multi-lignes (création, renommage, glisser-déposer)
// qu'un diff incrémental compliquerait pour un gain nul à cette échelle.
async function handlePutCustomLists(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON invalide." }, 400);
  }
  await replaceCustomListsForUser(env.DB, user.id, sanitizeCustomListsPayload(body));
  publishToUser(request, user.id, { type: "custom-lists" });
  return json({ ok: true });
}

// Partage des listes perso en lecture seule --------------------------------
//
// Un lien par liste, créé à la demande (bouton « Partager ») : slug
// aléatoire de 96 bits, non devinable. Même garde IDOR que les autres
// endpoints authentifiés : user.id vient uniquement du cookie de session,
// et une liste n'est partageable que si elle appartient à ce compte.
async function handleGetListShares(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  return json(await getListSharesForUser(env.DB, user.id));
}

async function handlePutListShare(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const body = await readJsonObject(request);
  if (!body) {
    return json({ error: "JSON invalide." }, 400);
  }
  const listId = body?.listId;
  if (typeof listId !== "string" || !listId || listId.length > 100) {
    return json({ error: "Liste invalide." }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return json({ error: 'Paramètre "enabled" invalide.' }, 400);
  }
  if (!body.enabled) {
    await unshareListForUser(env.DB, user.id, listId);
    return json({ ok: true, slug: null });
  }
  const slug = await shareListForUser(env.DB, user.id, listId, randomShareSlug());
  if (!slug) {
    // Liste pas encore synchronisée (anti-rebond côté client) ou supprimée.
    return json({ error: "Liste introuvable." }, 404);
  }
  return json({ ok: true, slug });
}

// Accessible sans compte (c'est tout l'intérêt d'un lien de partage), mais
// plafonné par IP pour qu'on ne puisse pas balayer l'espace des slugs. La
// session est lue seulement pour reconnaître le propriétaire (renvoyé vers
// sa vue éditable côté client).
async function handleGetPublicList(request: Request, env: Env, slug: string): Promise<Response> {
  const ip = getClientIp(request);
  if (!(await env.PUBLIC_SLUG_RATE_LIMITER.limit({ key: `public-list:ip:${ip}` })).success) {
    return RATE_LIMIT_RESPONSE();
  }
  if (!SHARE_SLUG_PATTERN.test(slug)) {
    return json({ error: "Liste introuvable ou plus partagée." }, 404);
  }
  const viewer = await getUserFromRequest(env.DB, request);
  const list = await getPublicListBySlug(env.DB, slug, viewer?.id ?? null);
  if (!list) {
    return json({ error: "Liste introuvable ou plus partagée." }, 404);
  }
  return json(list);
}

// Genres exclus synchronisés ----------------------------------------------
//
// Même garde IDOR que handleGetLibrary/handlePutLibrary : user.id vient
// uniquement du cookie de session, jamais du corps de la requête.
async function handleGetExcludedGenres(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const genreIds = await getExcludedGenresForUser(env.DB, user.id);
  return json({ genreIds });
}

async function handlePutExcludedGenres(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON invalide." }, 400);
  }
  const genreIds = sanitizeIdList((body as { genreIds?: unknown })?.genreIds);
  const merge = (body as { merge?: unknown })?.merge === true;
  await replaceExcludedGenresForUser(env.DB, user.id, genreIds, merge);
  publishToUser(request, user.id, { type: "excluded-genres" });
  return json({ ok: true });
}

// Plateformes favorites synchronisées -------------------------------------
//
// Même garde IDOR que handleGetLibrary/handlePutLibrary : user.id vient
// uniquement du cookie de session, jamais du corps de la requête.
async function handleGetFavoriteProviders(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const providerIds = await getFavoriteProvidersForUser(env.DB, user.id);
  return json({ providerIds });
}

async function handlePutFavoriteProviders(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON invalide." }, 400);
  }
  const providerIds = sanitizeIdList((body as { providerIds?: unknown })?.providerIds);
  const merge = (body as { merge?: unknown })?.merge === true;
  await replaceFavoriteProvidersForUser(env.DB, user.id, providerIds, merge);
  publishToUser(request, user.id, { type: "favorite-providers" });
  return json({ ok: true });
}

// Langues favorites synchronisées -----------------------------------------
//
// Même garde IDOR que handleGetLibrary/handlePutLibrary : user.id vient
// uniquement du cookie de session, jamais du corps de la requête.
async function handleGetFavoriteLanguages(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const languageCodes = await getFavoriteLanguagesForUser(env.DB, user.id);
  return json({ languageCodes });
}

async function handlePutFavoriteLanguages(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON invalide." }, 400);
  }
  const languageCodes = sanitizeIsoCodeList(
    (body as { languageCodes?: unknown })?.languageCodes,
    LANGUAGE_CODE_PATTERN
  );
  const merge = (body as { merge?: unknown })?.merge === true;
  await replaceFavoriteLanguagesForUser(env.DB, user.id, languageCodes, merge);
  publishToUser(request, user.id, { type: "favorite-languages" });
  return json({ ok: true });
}

// Pays favoris synchronisés -------------------------------------------------
//
// Même garde IDOR que handleGetLibrary/handlePutLibrary : user.id vient
// uniquement du cookie de session, jamais du corps de la requête.
async function handleGetFavoriteCountries(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const countryCodes = await getFavoriteCountriesForUser(env.DB, user.id);
  return json({ countryCodes });
}

async function handlePutFavoriteCountries(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON invalide." }, 400);
  }
  const countryCodes = sanitizeIsoCodeList(
    (body as { countryCodes?: unknown })?.countryCodes,
    COUNTRY_CODE_PATTERN
  );
  const merge = (body as { merge?: unknown })?.merge === true;
  await replaceFavoriteCountriesForUser(env.DB, user.id, countryCodes, merge);
  publishToUser(request, user.id, { type: "favorite-countries" });
  return json({ ok: true });
}

// Langue d'interface synchronisée par compte -------------------------------
//
// Même garde IDOR que les autres réglages de compte : user.id vient
// uniquement du cookie de session, jamais du corps de la requête. Duplique
// volontairement la liste des langues supportées (voir SUPPORTED_LOCALES
// côté front, src/core/i18n/i18n.ts) plutôt que de la partager entre les
// deux bundles indépendants (front Vite / Worker).
const SUPPORTED_LOCALES = ["fr", "en"];

async function handleGetLocale(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const locale = await getLocaleForUser(env.DB, user.id);
  return json({ locale });
}

async function handlePutLocale(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON invalide." }, 400);
  }
  const locale = (body as { locale?: unknown })?.locale;
  if (typeof locale !== "string" || !SUPPORTED_LOCALES.includes(locale)) {
    return json({ error: "Langue invalide." }, 400);
  }
  await setLocaleForUser(env.DB, user.id, locale);
  publishToUser(request, user.id, { type: "locale" });
  return json({ ok: true });
}

// Région choisie manuellement par compte -----------------------------------
//
// Même garde IDOR que /api/locale. Contrairement à SUPPORTED_LOCALES (2
// valeurs fixes), les régions possibles sont la liste des pays TMDB
// (~250, non dupliquée côté Worker) : on valide donc le format ISO 3166-1
// alpha-2 (2 lettres) plutôt qu'une énumération, exactement comme
// /api/region le renvoie déjà sans validation de liste (request.cf.country).
const ISO_3166_1_ALPHA_2 = /^[A-Z]{2}$/;

async function handleGetRegion(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  const region = await getRegionForUser(env.DB, user.id);
  return json({ region });
}

async function handlePutRegion(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) {
    return user;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON invalide." }, 400);
  }
  const region = (body as { region?: unknown })?.region;
  if (typeof region !== "string" || !ISO_3166_1_ALPHA_2.test(region)) {
    return json({ error: "Région invalide." }, 400);
  }
  await setRegionForUser(env.DB, user.id, region);
  publishToUser(request, user.id, { type: "region" });
  return json({ ok: true });
}

// Index "au cinéma"/"bientôt" (voir getTheatricalIndex, worker/tmdb.ts) pour
// une région : mis en cache à l'edge, si bien qu'un seul visiteur par région
// et par heure paie le parcours complet de now_playing/upcoming — les
// suivants reçoivent la réponse déjà calculée. Remplace en production le
// parcours équivalent que src/core/api/tmdb.ts ferait sinon depuis CHAQUE
// navigateur à CHAQUE session (voir getTheatricalStatusIndex, dont le cache
// mémoire ne survit pas à un rechargement).
async function handleTheatricalIndex(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  const region = url.searchParams.get("region") || "FR";
  // Chaque région inédite coûte ~20 appels TMDB : format validé (audit H3).
  if (!isValidRegion(region)) {
    return json({ error: "Région invalide." }, 400);
  }
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/api/theatrical-index?region=${region}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }
  // Après le cache, comme pour le proxy : un visiteur n'en a besoin qu'une
  // fois par session et par région.
  if (
    !checkRateLimitInMemory(`theatrical:ip:${getClientIp(request)}`, {
      limit: 10,
      windowMs: 5 * 60_000,
    })
  ) {
    return TMDB_RATE_LIMIT_RESPONSE();
  }
  const index = await getTheatricalIndex(env, region);
  const response = json(index, 200, { "cache-control": "public, max-age=3600" });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// Grilles (Nouveautés...) : plutôt que de laisser chaque carte affichée
// déclencher son propre appel /watch/providers depuis le navigateur une
// fois visible (voir MediaCard.tsx), le badge plateforme est résolu ici en
// un aller-retour serveur→TMDB par titre, en parallèle, fusionné dans la
// réponse /discover renvoyée au client. Sans ça, une grille de ~20 cartes
// gonfle son propre chargement de ~20 requêtes réseau côté client — un coût
// payé pour rien puisque TMDB est de toute façon interrogé une fois par
// titre, avec ou sans ce détour.
async function enrichDiscoverResultsWithProviders(
  data: { results?: Array<{ id: number }> },
  mediaType: "movie" | "tv",
  region: string,
  origin: string,
  env: Env,
  ctx: ExecutionContext,
  usage: TmdbUsage
): Promise<void> {
  await Promise.all(
    (data.results || []).map(async (item) => {
      const results = await fetchWatchProvidersCached(
        origin,
        mediaType,
        item.id,
        env.TMDB_API_KEY!,
        caches.default,
        ctx,
        usage
      );
      (item as { watch_providers?: unknown }).watch_providers = results?.[region] ?? null;
    })
  );
}

// Grille Découvrir (films) : `release_date` renvoyé par /discover/movie est
// la date de sortie "primaire" globale de TMDB, pas région-consciente (voir
// MediaCard.tsx et getTheatricalDateFromDetails, source de vérité partagée
// avec la fiche détail) — sans ça, un visiteur en région US peut voir une
// date différente de la vraie sortie US (ex. sortie "primaire" mexicaine).
// Même principe qu'enrichDiscoverResultsWithProviders : un aller-retour
// serveur par titre, en parallèle, fusionné avant renvoi au client, plutôt
// qu'un appel /release_dates par carte depuis le navigateur.
async function enrichDiscoverResultsWithRegionDate(
  data: { results?: Array<{ id: number; media_type?: string }> },
  region: string,
  origin: string,
  env: Env,
  ctx: ExecutionContext,
  usage: TmdbUsage
): Promise<void> {
  await Promise.all(
    (data.results || [])
      // /search/multi mélange films, séries et personnes dans un seul
      // tableau (media_type par item) ; /release_dates n'existe que pour
      // les films, contrairement à /discover/movie ou /search/movie qui ne
      // renvoient déjà que des films (pas de media_type par item).
      .filter((item) => item.media_type === undefined || item.media_type === "movie")
      .map(async (item) => {
        const releaseDates = await fetchReleaseDatesCached(
          origin,
          item.id,
          env.TMDB_API_KEY!,
          caches.default,
          ctx,
          usage
        );
        (item as { region_release_date?: string | null }).region_release_date =
          getTheatricalDateFromDetails(
            releaseDates ? { release_dates: releaseDates } : null,
            region
          );
      })
  );
}

// Proxy TMDB : la clé API TMDB n'est plus exposée côté client (elle
// n'apparaît dans aucune requête réseau visible depuis le navigateur). Le
// front (src/core/api/tmdbClient.ts) appelle /api/tmdb/<chemin TMDB> ; ce
// handler relaie vers l'API TMDB en y injectant la clé côté serveur, en
// ignorant toute valeur `api_key` que le client aurait pu fournir.
async function handleTmdbProxy(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const crawler = detectKnownCrawler(request);
  if (!env.TMDB_API_KEY) {
    return json({ error: "TMDB_API_KEY non configurée côté serveur." }, 503);
  }

  const url = new URL(request.url);
  // Liste blanche (voir tmdb-proxy-policy.ts) : chemin autorisé, paramètres
  // filtrés, validés et triés, qui forment aussi la clé de cache.
  const parsed = parseTmdbProxyRequest(url.pathname, url.searchParams);
  if (!parsed.ok) {
    return json({ error: parsed.error }, parsed.status);
  }
  const { tmdbPath, params } = parsed;

  // Cache d'edge Cloudflare : l'en-tête cache-control posé plus bas ne
  // suffit PAS à lui seul à faire mettre une réponse de Worker en cache —
  // sans un appel explicite à caches.default, chaque requête (même
  // identique, même émise à quelques secondes d'écart par deux visiteurs
  // différents) repart taper l'API TMDB. Sous charge, ça épuise le quota de
  // la clé API partagée côté serveur (429 TMDB observé en prod). La clé de
  // cache se base sur l'URL entrante (sans api_key, jamais transmise par le
  // client de toute façon) pour rester stable quel que soit le visiteur,
  // normalisée pour qu'un paramètre en plus ou dans un autre ordre ne la
  // contourne pas (audit H3).
  const cache = caches.default;
  const normalizedQuery = params.toString();
  const cacheKey = new Request(
    `${url.origin}/api/tmdb${tmdbPath}${normalizedQuery ? `?${normalizedQuery}` : ""}`
  );
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  // Plafonds vérifiés APRÈS le cache d'edge : une réponse servie depuis le
  // cache ne coûte aucun appel TMDB, et le Worker a de toute façon déjà été
  // invoqué — la refuser ne protège rien. Les compter faisait atteindre les
  // 120/min à un visiteur qui parcourt simplement quelques pages (badges par
  // carte, séries en cours...), d'où des « Erreur TMDB (429) » à l'accueil
  // (ticket « Un peu trop souvent d'erreur »).
  const ip = getClientIp(request);
  // En mémoire (pas D1, voir rate-limit.ts) : le proxy TMDB est de très loin
  // la route la plus sollicitée (par les humains comme par les bots), une
  // écriture D1 par requête y a fini par épuiser le quota d'écritures du
  // plan gratuit (ticket "Milliers de calls workers").
  if (!checkRateLimitInMemory(`tmdb:ip:${ip}`, { limit: 120, windowMs: 60_000 })) {
    return TMDB_RATE_LIMIT_RESPONSE();
  }
  // Un crawler distribué (voir ticket "Milliers de calls workers") reste
  // sous ce plafond par IP puisqu'il tourne sur un pool d'IP différentes :
  // cette seconde limite, partagée par famille de bot plutôt que par IP,
  // plafonne le volume agrégé sans jamais bloquer un visiteur humain qui
  // partagerait la même IP sortante (proxy, 4G...).
  const botLimit = { limit: 60, windowMs: 60_000 };
  if (crawler && !checkRateLimitInMemory(`tmdb:bot:${crawler}`, botLimit)) {
    return TMDB_RATE_LIMIT_RESPONSE();
  }

  const tmdbUrl = new URL(`https://api.themoviedb.org/3${tmdbPath}`);
  for (const [key, value] of params) {
    // Paramètres internes : jamais transmis à TMDB.
    if (!WORKER_ONLY_PARAMS.includes(key)) {
      tmdbUrl.searchParams.set(key, value);
    }
  }
  tmdbUrl.searchParams.set("api_key", env.TMDB_API_KEY);

  if (tmdbPath.startsWith("/search/")) {
    trackEvent(env, "search", [tmdbPath.replace(/^\/search\//, "")]);
  }

  const discoverMediaType = tmdbPath.match(/^\/discover\/(movie|tv)$/)?.[1] as
    "movie" | "tv" | undefined;
  // /search/movie ne renvoie que des films ; /search/multi mélange films,
  // séries et personnes (filtré par media_type dans
  // enrichDiscoverResultsWithRegionDate ci-dessus) — mêmes chemins de
  // recherche que ceux appelés par SearchPage/NavBar (searchMulti).
  const isRegionDateEligibleSearch = tmdbPath === "/search/movie" || tmdbPath === "/search/multi";
  // Le badge plateforme est un enrichissement purement visuel (voir
  // enrichDiscoverResultsWithProviders), pas nécessaire au rendu SEO d'une
  // grille (titre/synopsis/genres suffisent) : sauté pour les crawlers
  // connus, qui sinon multiplient les appels sortants TMDB par titre affiché
  // sans aucun bénéfice pour eux (voir ticket "Milliers de calls workers").
  const shouldEnrichProviders =
    discoverMediaType && params.get("include_watch_providers_badge") === "1" && !crawler;
  const shouldEnrichRegionDate =
    (discoverMediaType === "movie" || isRegionDateEligibleSearch) &&
    params.get("include_region_release_date") === "1";

  // Ces routes sont appelées une fois PAR CARTE (badge plateforme sur
  // Nouveautés, badge prochaine sortie/diffusion sur Prochainement) :
  // contrairement au reste du catalogue, chaque titre a un ID distinct,
  // donc la plupart des requêtes ratent le cache d'edge au premier
  // visiteur qui les déclenche. Le contenu de ces routes change rarement
  // d'une heure à l'autre : un TTL nettement plus long ici absorbe
  // beaucoup plus de trafic sur le même cache.
  const isPerTitleRoute = /\/(movie|tv)\/\d+(\/watch\/providers|\/release_dates)?$/.test(tmdbPath);
  // Les listes de genres TMDB (~20 entrées chacune) ne changent quasiment
  // jamais : un TTL d'une journée reste sûr et absorbe la quasi-totalité du
  // trafic sur ces deux routes, systématiquement rappelées à chaque page
  // par les navigateurs ET par les crawlers qui exécutent le JS du front.
  const isGenreListRoute = /^\/genre\/(movie|tv)\/list$/.test(tmdbPath);
  const maxAge = isPerTitleRoute ? 3600 : isGenreListRoute ? 86400 : 300;

  // Une grille enrichie coûte jusqu'à ~40 appels TMDB (un par carte et par
  // enrichissement) quand le cache est froid : budget à part, plus large que
  // les 120 requêtes/min ci-dessus pour ne pas gêner un visiteur qui fait
  // défiler quelques pages, mais qui borne ce qu'un seul client peut coûter
  // (audit H3). cost 0 : simple lecture du compteur.
  const enrichLimit = { limit: 400, windowMs: 60_000 };
  if (
    (shouldEnrichProviders || shouldEnrichRegionDate) &&
    !checkRateLimitInMemory(`tmdb-enrich:ip:${ip}`, { ...enrichLimit, cost: 0 })
  ) {
    return TMDB_RATE_LIMIT_RESPONSE();
  }

  const res = await fetch(tmdbUrl.toString());
  let body = await res.text();
  if (res.ok && (shouldEnrichProviders || shouldEnrichRegionDate)) {
    const data = JSON.parse(body);
    const usage: TmdbUsage = { calls: 0 };
    if (shouldEnrichProviders) {
      const region = params.get("watch_providers_badge_region") || "FR";
      await enrichDiscoverResultsWithProviders(
        data,
        discoverMediaType,
        region,
        url.origin,
        env,
        ctx,
        usage
      );
    }
    if (shouldEnrichRegionDate) {
      const region = params.get("region_release_date_region") || "FR";
      await enrichDiscoverResultsWithRegionDate(data, region, url.origin, env, ctx, usage);
    }
    // Imputés après coup (on ne connaît qu'ici le nombre d'appels hors cache) :
    // la requête en cours est servie, les suivantes seront refusées.
    if (usage.calls > 0) {
      checkRateLimitInMemory(`tmdb-enrich:ip:${ip}`, { ...enrichLimit, cost: usage.calls });
      if (crawler) {
        checkRateLimitInMemory(`tmdb:bot:${crawler}`, { ...botLimit, cost: usage.calls });
      }
    }
    body = JSON.stringify(data);
  }
  const response = new Response(body, {
    status: res.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
    },
  });
  // Réponse appauvrie pour un crawler (grille sans badges plateforme, voir
  // shouldEnrichProviders) : la clé de cache ne dépend que de l'URL, donc la
  // mettre en cache la servirait ensuite aux vrais visiteurs pendant 5 min
  // (audit H2). Les autres réponses aux crawlers, identiques à celles d'un
  // humain, restent mises en cache : elles épargnent le quota TMDB.
  const degradedForCrawler =
    crawler && discoverMediaType && params.get("include_watch_providers_badge") === "1";
  if (res.ok && !degradedForCrawler) {
    // waitUntil : n'ajoute pas la latence de l'écriture cache à la réponse.
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  } else if (res.status === 429) {
    // Sans ceci, un vrai dépassement de quota TMDB fait que CHAQUE requête
    // suivante (tous visiteurs, toutes pages confondues) repart taper TMDB
    // et se reprend un 429 individuellement. Un cache négatif très court
    // (10s, très inférieur aux 5 min du cache normal) absorbe cette rafale.
    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(body, {
          status: 429,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=10",
          },
        })
      )
    );
  }
  return response;
}

export default withSentry({
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (REDIRECTED_TO_PRODUCTION_HOSTNAMES.includes(url.hostname)) {
      return Response.redirect(`https://${PRODUCTION_HOSTNAME}${url.pathname}${url.search}`, 301);
    }
    // `run_worker_first` (wrangler.jsonc) route surtout /api/* ici : les
    // assets statiques (dont le service worker /sw.js) sont servis
    // nativement par Cloudflare sans passer par ce Worker — reconstruire
    // leur Response ici (même pour juste ajouter des en-têtes) casse
    // l'enregistrement du service worker. Leurs en-têtes de sécurité sont
    // donc posés nativement via public/_headers (généré depuis
    // worker/security-headers.ts) plutôt qu'ici.
    // Exceptions : robots.txt, sitemap.xml et les pages partageables (fiche,
    // profil, liste), qui passent par ici pour leurs balises de partage
    // (voir page-meta.ts). Réponses reconstruites, d'où withSecurityHeaders.
    if (!url.pathname.startsWith("/api/")) {
      // Ancienne URL de prod : liens partagés, robots et sitemap renvoient
      // définitivement vers seancy.com. Les autres pages sont des assets
      // servis sans passer par ici, redirigés côté client (src/main.tsx).
      // /api/* reste servi pour les onglets encore ouverts sur l'ancienne
      // URL, le temps qu'ils se rechargent.
      if (url.hostname === LEGACY_PRODUCTION_HOSTNAME) {
        return Response.redirect(`https://${PRODUCTION_HOSTNAME}${url.pathname}${url.search}`, 301);
      }
      if (url.pathname === "/robots.txt") {
        return withSecurityHeaders(serveRobots(url));
      }
      if (url.pathname === "/sitemap.xml") {
        return withSecurityHeaders(await serveSitemap(url, env));
      }
      if (
        PAGE_META_ROUTE.test(url.pathname) &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        return withSecurityHeaders(await servePageWithMeta(request, env, ctx));
      }
      return env.ASSETS.fetch(request);
    }
    // Filet de sécurité : sans lui, une exception non rattrapée donne une
    // page d'erreur Cloudflare en HTML (sans en-têtes de sécurité), que le
    // client ne sait pas lire.
    try {
      // Poignée de main WebSocket de la synchro temps réel : la réponse 101
      // ne doit pas passer par withSecurityHeaders (voir openSyncSocket).
      if (url.pathname === "/api/sync/socket" && request.method === "GET") {
        const user = await getUserFromRequest(env.DB, request);
        if (!user) {
          return withSecurityHeaders(json({ error: "Non connecté." }, 401));
        }
        return await openSyncSocket(request, user.id);
      }
      const response = await routeRequest(request, env, url, ctx);
      return withSecurityHeaders(response);
    } catch (err) {
      logError(`Erreur non gérée sur ${request.method} ${url.pathname} :`, err);
      return withSecurityHeaders(json({ error: "Erreur interne du serveur." }, 500));
    }
  },

  // Deux expressions cron (voir wrangler.jsonc), distinguées par event.cron :
  // la sync de l'index de recherche (search-index.ts) tourne dans sa propre
  // invocation plutôt que dans celle de runDailyCheck, pour ne pas partager
  // son budget de sous-requêtes TMDB avec les notifications quotidiennes.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === SEARCH_INDEX_SYNC_CRON) {
      ctx.waitUntil(syncPopularTitles(env));
      return;
    }
    ctx.waitUntil(runDailyCheck(env));
  },
});

async function routeRequest(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response> {
  if (url.pathname === "/api/vapid-public-key" && request.method === "GET") {
    if (!env.VAPID_PUBLIC_KEY) {
      return json({ error: "VAPID_PUBLIC_KEY non configurée." }, 503);
    }
    return cachedStaticJson(request, ctx, { publicKey: env.VAPID_PUBLIC_KEY });
  }

  // Clé "site" reCAPTCHA v3 : faite pour être publique (elle apparaît de
  // toute façon en clair dans le HTML/JS de n'importe quel site qui
  // l'utilise) — servie ici plutôt que codée en dur côté client pour ne pas
  // dépendre d'une variable d'environnement Vite à configurer séparément.
  // `null` si pas encore configurée : le client saute alors la vérification
  // anti-robot (le serveur, lui, saute aussi la vérification côté
  // verifyRecaptcha tant que RECAPTCHA_SECRET_KEY n'est pas configurée).
  if (url.pathname === "/api/recaptcha-site-key" && request.method === "GET") {
    return cachedStaticJson(request, ctx, { siteKey: env.RECAPTCHA_SITE_KEY || null });
  }

  // DSN Sentry pour l'init côté client (voir src/core/logger.ts) : servi
  // depuis le worker plutôt que codé en dur/passé en variable Vite au build,
  // même logique que /api/recaptcha-site-key ci-dessus — un DSN Sentry est
  // par nature fait pour être exposé publiquement.
  if (url.pathname === "/api/sentry-dsn" && request.method === "GET") {
    return cachedStaticJson(request, ctx, { dsn: env.SENTRY_DSN || null });
  }

  // Token du beacon Cloudflare Web Analytics (public par nature) : voir
  // CLOUDFLARE_ANALYTICS_TOKEN dans wrangler.jsonc/types.ts.
  if (url.pathname === "/api/web-analytics-token" && request.method === "GET") {
    return cachedStaticJson(request, ctx, { token: env.CLOUDFLARE_ANALYTICS_TOKEN || null });
  }

  // Healthcheck de disponibilité (voir .github/workflows/healthcheck.yml,
  // ping toutes les 5 min) : vérifie que le Worker répond ET que D1 est
  // accessible, pas juste que le process tourne.
  if (url.pathname === "/api/health" && request.method === "GET") {
    try {
      await env.DB.prepare("SELECT 1").first();
      return json({ status: "ok" });
    } catch (err) {
      logError("Healthcheck : D1 inaccessible.", err);
      return json({ status: "error" }, 503);
    }
  }

  if (url.pathname === "/api/subscribe" && request.method === "POST") {
    return handleSubscribe(request, env);
  }

  if (url.pathname === "/api/unsubscribe" && request.method === "POST") {
    return handleUnsubscribe(request, env);
  }

  if (url.pathname === "/api/subscribe/sync" && request.method === "POST") {
    return handleSubscribeSync(request, env);
  }

  if (url.pathname === "/api/subscribe/locale" && request.method === "POST") {
    return handleUpdateSubscriptionLocale(request, env);
  }

  if (url.pathname === "/api/subscribe/account" && request.method === "POST") {
    return handleLinkSubscriptionAccount(request, env);
  }

  if (url.pathname === "/api/notifications/test" && request.method === "POST") {
    return handleTestAccountNotification(request, env, ctx);
  }

  if (url.pathname === "/api/run-check" && request.method === "POST") {
    return handleManualRun(request, env, ctx);
  }

  if (url.pathname === "/api/search-index" && request.method === "GET") {
    return handleSearchIndex(request, env);
  }

  if (url.pathname === "/api/sync-search-index" && request.method === "POST") {
    return handleManualSyncSearchIndex(request, env);
  }

  if (url.pathname === "/api/test-error" && request.method === "POST") {
    return handleTestError(request, env);
  }

  if (url.pathname === "/api/test-notification" && request.method === "POST") {
    return handleTestNotification(request, env);
  }

  if (url.pathname === "/api/auth/request-link" && request.method === "POST") {
    return handleRequestLink(request, env);
  }

  if (url.pathname === "/api/auth/verify" && request.method === "POST") {
    return handleVerify(request, env);
  }

  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    return handleMe(request, env);
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    return handleLogout(request, env);
  }

  if (url.pathname === "/api/auth/logout-all" && request.method === "POST") {
    return handleLogoutAll(request, env);
  }

  if (url.pathname === "/api/account" && request.method === "DELETE") {
    return handleDeleteAccount(request, env);
  }

  if (url.pathname === "/api/account/export" && request.method === "GET") {
    return handleExportAccount(request, env);
  }

  if (url.pathname === "/api/account/display-name" && request.method === "PATCH") {
    return handleUpdateDisplayName(request, env);
  }

  if (url.pathname === "/api/account/email/request" && request.method === "POST") {
    return handleRequestEmailChange(request, env);
  }
  if (url.pathname === "/api/account/email/confirm" && request.method === "POST") {
    return handleConfirmEmailChange(request, env);
  }
  if (url.pathname === "/api/account/username" && request.method === "PUT") {
    return handleUpdateUsername(request, env);
  }
  if (url.pathname === "/api/account/username/availability" && request.method === "GET") {
    return handleUsernameAvailability(request, env);
  }
  if (url.pathname === "/api/account/avatar" && request.method === "GET") {
    return handleGetOwnAvatar(request, env);
  }
  if (url.pathname === "/api/account/avatar" && request.method === "PUT") {
    return handlePutAvatar(request, env);
  }
  if (url.pathname === "/api/account/avatar" && request.method === "DELETE") {
    return handleDeleteAvatar(request, env);
  }
  if (url.pathname === "/api/account/share" && request.method === "PUT") {
    return handleUpdateProfileShare(request, env);
  }
  const publicFollowList = url.pathname.match(
    /^\/api\/public-profile\/([^/]+)\/(followers|following)$/
  );
  if (publicFollowList && request.method === "GET") {
    return handleGetPublicFollowList(
      request,
      env,
      publicFollowList[1],
      publicFollowList[2] as "followers" | "following"
    );
  }
  if (url.pathname === "/api/reminders" && request.method === "GET") {
    return handleGetReminders(request, env);
  }
  if (url.pathname === "/api/reminders" && request.method === "PUT") {
    return handlePutReminder(request, env);
  }
  if (url.pathname === "/api/reminders" && request.method === "DELETE") {
    return handleDeleteReminder(request, env);
  }
  if (url.pathname === "/api/account/top-picks" && request.method === "GET") {
    return handleGetTopPicks(request, env);
  }
  if (url.pathname === "/api/account/top-picks" && request.method === "PUT") {
    return handlePutTopPicks(request, env);
  }
  const avatarMatch = url.pathname.match(/^\/api\/public-profile\/([^/]+)\/avatar$/);
  if (avatarMatch && request.method === "GET") {
    return handleGetPublicProfileAvatar(request, env, avatarMatch[1]);
  }
  if (url.pathname.startsWith("/api/public-profile/") && request.method === "GET") {
    return handleGetPublicProfile(request, env, url.pathname.slice("/api/public-profile/".length));
  }
  if (
    url.pathname.startsWith("/api/follows/") &&
    (request.method === "POST" || request.method === "DELETE")
  ) {
    return handleFollow(request, env, url.pathname.slice("/api/follows/".length), ctx);
  }
  if (
    (url.pathname === "/api/account/followers" || url.pathname === "/api/account/following") &&
    request.method === "GET"
  ) {
    return handleGetAccountFollowList(
      request,
      env,
      url.pathname.endsWith("followers") ? "followers" : "following"
    );
  }
  if (url.pathname === "/api/account/feed" && request.method === "GET") {
    return handleGetFeed(request, env);
  }
  if (url.pathname === "/api/account/title-activity" && request.method === "GET") {
    return handleGetTitleActivity(request, env, url);
  }
  if (url.pathname === "/api/profiles/search" && request.method === "GET") {
    return handleSearchProfiles(request, env, url);
  }
  if (url.pathname === "/api/library" && request.method === "GET") {
    return handleGetLibrary(request, env);
  }

  if (url.pathname === "/api/library" && request.method === "PUT") {
    return handlePutLibrary(request, env);
  }

  if (url.pathname === "/api/library/sync" && request.method === "POST") {
    return handleLibrarySync(request, env);
  }

  if (url.pathname === "/api/custom-lists" && request.method === "GET") {
    return handleGetCustomLists(request, env);
  }

  if (url.pathname === "/api/custom-lists" && request.method === "PUT") {
    return handlePutCustomLists(request, env);
  }

  if (url.pathname === "/api/list-shares" && request.method === "GET") {
    return handleGetListShares(request, env);
  }
  if (url.pathname === "/api/list-shares" && request.method === "PUT") {
    return handlePutListShare(request, env);
  }
  if (url.pathname.startsWith("/api/public-list/") && request.method === "GET") {
    return handleGetPublicList(request, env, url.pathname.slice("/api/public-list/".length));
  }
  if (url.pathname === "/api/excluded-genres" && request.method === "GET") {
    return handleGetExcludedGenres(request, env);
  }

  if (url.pathname === "/api/excluded-genres" && request.method === "PUT") {
    return handlePutExcludedGenres(request, env);
  }

  if (url.pathname === "/api/favorite-providers" && request.method === "GET") {
    return handleGetFavoriteProviders(request, env);
  }

  if (url.pathname === "/api/favorite-providers" && request.method === "PUT") {
    return handlePutFavoriteProviders(request, env);
  }

  if (url.pathname === "/api/favorite-languages" && request.method === "GET") {
    return handleGetFavoriteLanguages(request, env);
  }

  if (url.pathname === "/api/favorite-languages" && request.method === "PUT") {
    return handlePutFavoriteLanguages(request, env);
  }

  if (url.pathname === "/api/favorite-countries" && request.method === "GET") {
    return handleGetFavoriteCountries(request, env);
  }

  if (url.pathname === "/api/favorite-countries" && request.method === "PUT") {
    return handlePutFavoriteCountries(request, env);
  }

  if (url.pathname === "/api/locale" && request.method === "GET") {
    return handleGetLocale(request, env);
  }

  if (url.pathname === "/api/locale" && request.method === "PUT") {
    return handlePutLocale(request, env);
  }

  if (url.pathname === "/api/profile/region" && request.method === "GET") {
    return handleGetRegion(request, env);
  }

  if (url.pathname === "/api/profile/region" && request.method === "PUT") {
    return handlePutRegion(request, env);
  }

  if (url.pathname.startsWith("/api/tmdb/") && request.method === "GET") {
    return handleTmdbProxy(request, env, ctx);
  }

  if (url.pathname === "/api/theatrical-index" && request.method === "GET") {
    return handleTheatricalIndex(request, env, ctx);
  }

  // Pays du visiteur, déduit par Cloudflare au niveau du edge (aucun appel
  // à un service tiers, aucune permission navigateur à demander) — sert de
  // repli tant qu'aucune région n'est choisie manuellement (voir
  // RegionContext.tsx). `request.cf` n'est disponible que sur le vrai réseau
  // Cloudflare ; repli sur FR sinon.
  // `private` (pas `public`) : la réponse dépend de l'IP de CE visiteur
  // précis, donc mise en cache uniquement côté navigateur (jamais à l'edge
  // Cloudflare, qui la resservirait telle quelle à d'autres visiteurs). Une
  // demi-heure suffit à absorber les rappels répétés d'un même client (ex.
  // crawler qui explore plusieurs pages coup sur coup) sans retarder
  // longtemps la prise en compte d'un vrai changement de localisation.
  if (url.pathname === "/api/region" && request.method === "GET") {
    return json({ country: request.cf?.country || "FR" }, 200, {
      "cache-control": "private, max-age=1800",
    });
  }

  // `run_worker_first` (wrangler.jsonc) ne route ici que des /api/*, mais on
  // garde un filet : toute autre requête retombe sur les assets statiques.
  return env.ASSETS.fetch(request);
}
