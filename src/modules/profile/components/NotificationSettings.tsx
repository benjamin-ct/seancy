import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../../core/i18n/i18n.ts";
import { useAuth } from "../../../core/context/AuthContext.tsx";
import { useLibrary } from "../../../core/context/LibraryContext.tsx";
import { useLocale } from "../../../core/context/LocaleContext.tsx";
import { logWarn } from "../../../core/logger.ts";
import { PUSH_ENDPOINT_STORAGE_KEY as ENDPOINT_STORAGE_KEY } from "../../../core/sync/pushAccountLink.ts";
import type { LibraryItem } from "../../../core/types/library.ts";
import type { MediaType } from "../../../core/types/tmdb.ts";
import { storageGet, storageRemove, storageSet } from "../../../shared/lib/storage.ts";
import styles from "./SettingsPanel.module.css";

const TOP_GENRES_FOR_NOTIFICATIONS = 8;

interface FavoriteGenre {
  mediaType: MediaType;
  genreId: number;
}

interface WatchlistPayloadItem {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  posterPath: string | null;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function computeFavoriteGenres(watched: LibraryItem[]): FavoriteGenre[] {
  const counts = new Map<string, number>();
  for (const item of watched) {
    for (const genreId of item.genreIds || []) {
      const key = `${item.mediaType}:${genreId}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_GENRES_FOR_NOTIFICATIONS)
    .map(([key]) => {
      const [mediaType, genreId] = key.split(":");
      return { mediaType: mediaType as MediaType, genreId: Number(genreId) };
    });
}

function toWatchlistPayload(item: LibraryItem): WatchlistPayloadItem {
  return {
    mediaType: item.mediaType,
    tmdbId: item.id,
    title: item.title,
    posterPath: item.posterPath,
  };
}

async function fullSyncSubscription(
  endpoint: string,
  keys: PushSubscriptionJSON["keys"],
  watchlist: LibraryItem[],
  watched: LibraryItem[],
  locale: string
): Promise<void> {
  const res = await fetch("/api/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint,
      keys,
      watchlist: watchlist.map(toWatchlistPayload),
      favoriteGenres: computeFavoriteGenres(watched),
      locale,
    }),
  });
  if (!res.ok) {
    throw new Error(i18n.t("notificationSettings.syncFailed", { status: res.status }));
  }
}

// Langue à utiliser par le scheduler pour les notifications envoyées à cet
// abonnement (voir worker/scheduled.ts) : resynchronisée à chaque
// changement de langue tant que les notifications sont actives, en plus de
// l'envoi initial fait par fullSyncSubscription.
async function syncSubscriptionLocale(endpoint: string, locale: string): Promise<void> {
  await fetch("/api/subscribe/locale", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint, locale }),
  }).catch((err) => logWarn("Seancy : resynchronisation de la langue des notifs échouée.", err));
}

// Clé publique VAPID actuelle du serveur. Elle peut changer (rotation des
// clés) : les abonnements créés avec l'ancienne deviennent alors inutilisables.
async function fetchVapidPublicKey(): Promise<Uint8Array> {
  const keyRes = await fetch("/api/vapid-public-key");
  if (!keyRes.ok) {
    throw new Error(i18n.t("notificationSettings.keyFetchError"));
  }
  const { publicKey } = (await keyRes.json()) as { publicKey: string };
  return urlBase64ToUint8Array(publicKey);
}

async function subscribeWithKey(
  registration: ServiceWorkerRegistration,
  publicKey: Uint8Array
): Promise<PushSubscription> {
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    // Cast nécessaire : le typage DOM de `applicationServerKey` attend un
    // `Uint8Array<ArrayBuffer>` précisément, alors que `Uint8Array.from()`
    // infère `Uint8Array<ArrayBufferLike>` (générique élargi depuis
    // TypeScript 5.7) — la valeur réelle est bien un ArrayBuffer classique.
    applicationServerKey: publicKey as BufferSource,
  });
}

function sameKey(current: ArrayBuffer, expected: Uint8Array): boolean {
  const bytes = new Uint8Array(current);
  return bytes.length === expected.length && bytes.every((b, i) => b === expected[i]);
}

async function unregisterEndpoint(endpoint: string): Promise<void> {
  await fetch("/api/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
}

// Si l'abonnement du navigateur a été créé avec une ancienne clé VAPID, le
// service push refuse tous les envois (403). On le remplace sans rien
// demander à l'utilisateur (la permission reste accordée) et on
// ré-enregistre le nouvel abonnement côté serveur. Renvoie le nouvel
// endpoint, ou null si rien n'a changé.
async function resyncIfVapidKeyRotated(
  watchlist: LibraryItem[],
  watched: LibraryItem[],
  locale: string
): Promise<string | null> {
  const registration = await navigator.serviceWorker.ready;
  const current = await registration.pushManager.getSubscription();
  const currentKey = current?.options.applicationServerKey;
  if (!current || !currentKey) {
    return null;
  }
  const publicKey = await fetchVapidPublicKey();
  if (sameKey(currentKey, publicKey)) {
    return null;
  }

  await unregisterEndpoint(current.endpoint);
  await current.unsubscribe();
  const subscription = await subscribeWithKey(registration, publicKey);
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys) {
    throw new Error(i18n.t("notificationSettings.incompleteSubscription"));
  }
  await fullSyncSubscription(endpoint, keys, watchlist, watched, locale);
  return endpoint;
}

interface SyncedState {
  watchlistKeys: Set<string>;
  genreKeys: Set<string>;
}

function keysOf(watchlist: LibraryItem[], watched: LibraryItem[]): SyncedState {
  return {
    watchlistKeys: new Set(watchlist.map((item) => `${item.mediaType}:${item.id}`)),
    genreKeys: new Set(computeFavoriteGenres(watched).map((g) => `${g.mediaType}:${g.genreId}`)),
  };
}

async function syncSubscriptionDelta(
  endpoint: string,
  watchlist: LibraryItem[],
  watched: LibraryItem[],
  lastSyncedRef: { current: SyncedState }
): Promise<void> {
  const desiredWatchlist = watchlist.map(toWatchlistPayload);
  const desiredGenres = computeFavoriteGenres(watched);
  const { watchlistKeys: desiredWatchlistKeys, genreKeys: desiredGenreKeys } = keysOf(
    watchlist,
    watched
  );

  const watchlistToAdd = desiredWatchlist.filter(
    (item) => !lastSyncedRef.current.watchlistKeys.has(`${item.mediaType}:${item.tmdbId}`)
  );
  const watchlistToRemove = [...lastSyncedRef.current.watchlistKeys].filter(
    (key) => !desiredWatchlistKeys.has(key)
  );
  const genresToAdd = desiredGenres.filter(
    (g) => !lastSyncedRef.current.genreKeys.has(`${g.mediaType}:${g.genreId}`)
  );
  const genresToRemove = [...lastSyncedRef.current.genreKeys].filter(
    (key) => !desiredGenreKeys.has(key)
  );

  if (
    !watchlistToAdd.length &&
    !watchlistToRemove.length &&
    !genresToAdd.length &&
    !genresToRemove.length
  ) {
    return;
  }

  const res = await fetch("/api/subscribe/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint,
      watchlistToAdd,
      watchlistToRemove,
      genresToAdd,
      genresToRemove,
    }),
  });
  if (!res.ok) {
    throw new Error(i18n.t("notificationSettings.syncFailed", { status: res.status }));
  }

  lastSyncedRef.current = { watchlistKeys: desiredWatchlistKeys, genreKeys: desiredGenreKeys };
}

const TEST_NOTIFICATION_DELAY_S = 15;

// Les boutons de test ne servent qu'à valider le choix de canal sur les
// previews PR (`<slug>.dev.seancy.com`, voir
// worker/sentry.ts) et en dev local, et n'ont rien à faire sous les yeux des
// utilisateurs (l'endpoint est aussi refusé côté Worker en prod). Liste
// blanche plutôt que comparaison au domaine de prod : ce dernier avait
// divergé (renommage Seancy) et les boutons s'affichaient en prod.
const SHOW_TEST_NOTIFICATION =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname.endsWith(".dev.seancy.com");

// Envoie une notification de test au compte via notifyUser (voir
// worker/index.ts, /api/notifications/test), pour vérifier le choix de canal
// sans attendre une vraie sortie : in-app si un appareil a l'app ouverte,
// sinon Web Push (d'où l'envoi différé, le temps de fermer l'app).
function TestNotification() {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send(delaySeconds: number) {
    setSending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/notifications/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delaySeconds }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setMessage(data?.error || t("notificationSettings.testFailed", { status: res.status }));
        return;
      }
      const data = (await res.json()) as {
        channel?: "in-app" | "push";
        scheduledInSeconds?: number;
      };
      if (data.scheduledInSeconds) {
        setMessage(t("notificationSettings.testScheduled", { seconds: data.scheduledInSeconds }));
      } else {
        setMessage(
          t(
            data.channel === "in-app"
              ? "notificationSettings.testSentInApp"
              : "notificationSettings.testSentPush"
          )
        );
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("common.errorGeneric"));
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className={styles.testActions}>
        <button type="button" className={styles.btn} onClick={() => send(0)} disabled={sending}>
          {sending ? t("notificationSettings.testSending") : t("notificationSettings.testNow")}
        </button>
        <span className={styles.hint}>{t("notificationSettings.testNowHint")}</span>
      </div>
      <div className={styles.testActions}>
        <button
          type="button"
          className={styles.btn}
          onClick={() => send(TEST_NOTIFICATION_DELAY_S)}
          disabled={sending}
        >
          {t("notificationSettings.testDelayed")}
        </button>
        <span className={styles.hint}>{t("notificationSettings.testDelayedHint")}</span>
      </div>
      {message && (
        <p className={styles.hint} role="status">
          {message}
        </p>
      )}
    </>
  );
}

export default function NotificationSettings() {
  const { t } = useTranslation();
  const { watchlist, watched } = useLibrary();
  const { locale } = useLocale();
  const { status: authStatus } = useAuth();
  const [endpoint, setEndpoint] = useState<string | null>(() => storageGet(ENDPOINT_STORAGE_KEY));
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const isFirstSync = useRef(true);
  const lastSyncedRef = useRef<SyncedState>({ watchlistKeys: new Set(), genreKeys: new Set() });
  const isFirstLocaleSync = useRef(true);

  // Au chargement : remplace un abonnement devenu inutilisable après une
  // rotation des clés VAPID. Volontairement exécuté une seule fois, avec la
  // bibliothèque connue à cet instant ; les changements ultérieurs passent
  // par la resynchro delta ci-dessous.
  useEffect(() => {
    if (!endpoint || !isSupported() || Notification.permission !== "granted") {
      return;
    }
    resyncIfVapidKeyRotated(watchlist, watched, locale)
      .then((newEndpoint) => {
        if (!newEndpoint) {
          return;
        }
        lastSyncedRef.current = keysOf(watchlist, watched);
        storageSet(ENDPOINT_STORAGE_KEY, newEndpoint);
        setEndpoint(newEndpoint);
      })
      .catch((err) => logWarn("Seancy : resynchro de l'abonnement push échouée.", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resynchronise la watchlist / les genres favoris côté serveur à chaque
  // changement, tant que les notifications sont actives.
  useEffect(() => {
    if (!endpoint) {
      return;
    }
    if (isFirstSync.current) {
      isFirstSync.current = false;
      return;
    }
    navigator.serviceWorker?.ready.then((registration) =>
      registration.pushManager.getSubscription().then((sub) => {
        if (!sub) {
          return;
        }
        syncSubscriptionDelta(endpoint, watchlist, watched, lastSyncedRef).catch((err) =>
          logWarn("Seancy : resync notifications échouée.", err)
        );
      })
    );
  }, [endpoint, watchlist, watched]);

  // Resynchronise la langue des notifications quand l'utilisateur la change
  // en cours de route (le premier envoi a lieu via fullSyncSubscription, à
  // l'activation).
  useEffect(() => {
    if (!endpoint) {
      return;
    }
    if (isFirstLocaleSync.current) {
      isFirstLocaleSync.current = false;
      return;
    }
    syncSubscriptionLocale(endpoint, locale);
  }, [endpoint, locale]);

  if (!isSupported()) {
    return (
      <div className={styles.pushSettings}>
        <p className={styles.hint}>{t("notificationSettings.unsupported")}</p>
      </div>
    );
  }

  async function enable() {
    setStatus("working");
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error(t("notificationSettings.permissionDenied"));
      }

      const registration = await navigator.serviceWorker.ready;

      const publicKey = await fetchVapidPublicKey();
      const subscription = await subscribeWithKey(registration, publicKey);

      const { endpoint: subEndpoint, keys } = subscription.toJSON();
      if (!subEndpoint || !keys) {
        throw new Error(t("notificationSettings.incompleteSubscription"));
      }
      await fullSyncSubscription(subEndpoint, keys, watchlist, watched, locale);
      lastSyncedRef.current = keysOf(watchlist, watched);

      storageSet(ENDPOINT_STORAGE_KEY, subEndpoint);
      setEndpoint(subEndpoint);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.errorGeneric"));
      setStatus("error");
    }
  }

  async function disable() {
    setStatus("working");
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await unregisterEndpoint(subscription.endpoint);
        await subscription.unsubscribe();
      }
      storageRemove(ENDPOINT_STORAGE_KEY);
      setEndpoint(null);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.errorGeneric"));
      setStatus("error");
    }
  }

  const enabled = endpoint !== null;

  return (
    <div className={styles.pushSettings}>
      <div className={styles.switchRow}>
        <div>
          <span id="push-switch-label">{t("notificationSettings.pushLabel")}</span>
          <p id="push-switch-hint" className={styles.pushHint}>
            {t("profile.notificationsHint")}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="push-switch-label"
          aria-describedby="push-switch-hint"
          className={`${styles.switch} ${enabled ? styles.switchOn : ""}`}
          onClick={enabled ? disable : enable}
          disabled={status === "working"}
        />
      </div>
      {status === "working" && !enabled && (
        <p className={styles.hint} role="status">
          {t("notificationSettings.enabling")}
        </p>
      )}
      {enabled && SHOW_TEST_NOTIFICATION && authStatus === "authenticated" && <TestNotification />}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
