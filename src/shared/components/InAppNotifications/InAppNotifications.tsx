import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useLiveSyncEvent, type InAppNotification } from "../../../core/sync/liveSync.ts";
import styles from "./InAppNotifications.module.css";

const AUTO_DISMISS_MS = 10_000;
const MAX_VISIBLE = 3;
const KINDS = [
  "watchlistAvailable",
  "favoriteGenreRelease",
  "trendingRelease",
  "test",
  "newFollower",
  "reminderReleased",
  "reminderAvailable",
  "addedToList",
];

interface Toast extends InAppNotification {
  id: number;
}

function isInAppNotification(value: unknown): value is InAppNotification {
  const n = value as InAppNotification | null;
  return (
    typeof n === "object" &&
    n !== null &&
    KINDS.includes(n.kind) &&
    typeof n.mediaTitle === "string" &&
    typeof n.url === "string" &&
    // Liens internes uniquement : jamais de redirection vers un autre site.
    n.url.startsWith("/") &&
    !n.url.startsWith("//")
  );
}

// Notifications in-app livrées par le hub temps réel du compte (voir
// worker/notify.ts) quand un appareil a l'app au premier plan — à la place
// du Web Push. Si l'onglet est passé en arrière-plan juste avant la
// réception (le hub n'a pas encore reçu le signal "background"), on affiche
// en plus une notification système via le service worker (si la permission
// a été accordée), pour ne pas la rater.
export default function InAppNotifications() {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  // "newFollower" : `mediaTitle` = nom de l'abonné, vide s'il n'en a pas ou
  // si son profil est privé (voir notifyNewFollower côté Worker).
  const fallbackTitle = (kind: InAppNotification["kind"]) =>
    kind === "newFollower" ? t("inAppNotifications.newFollowerFallback") : "";

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  useLiveSyncEvent("notification", (event) => {
    // `null` = resynchronisation après coupure : rien à recharger ici, une
    // notification manquée pendant la coupure est partie en Web Push.
    if (!event || !isInAppNotification(event.payload)) {
      return;
    }
    const notification = event.payload;
    const id = nextId.current++;
    setToasts((current) => [...current, { ...notification, id }].slice(-MAX_VISIBLE));
    timers.current.set(
      id,
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
    );

    if (
      document.visibilityState === "hidden" &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      navigator.serviceWorker?.ready
        .then((registration) =>
          registration.showNotification(t(`inAppNotifications.${notification.kind}.title`), {
            body: t(`inAppNotifications.${notification.kind}.body`, {
              title: notification.mediaTitle || fallbackTitle(notification.kind),
            }),
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            data: { url: notification.url },
          })
        )
        .catch(() => {
          // Pas de service worker actif : le toast reste affiché au retour.
        });
    }
  });

  // Région live toujours montée, même vide : une région insérée en même
  // temps que son contenu n'est pas annoncée par les lecteurs d'écran.
  return (
    <div className={styles.stack} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={styles.toast}>
          <Link to={toast.url} className={styles.link} onClick={() => dismiss(toast.id)}>
            <strong className={styles.title}>{t(`inAppNotifications.${toast.kind}.title`)}</strong>
            <span className={styles.body}>
              {t(`inAppNotifications.${toast.kind}.body`, {
                title: toast.mediaTitle || fallbackTitle(toast.kind),
              })}
            </span>
          </Link>
          <button
            type="button"
            className={styles.close}
            onClick={() => dismiss(toast.id)}
            aria-label={t("inAppNotifications.dismiss")}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
