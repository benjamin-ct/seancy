// Point d'entrée unique des notifications (option A "hybride" du ticket
// "Notifications via le hub temps réel") : notifyUser choisit le canal.
//
// - Destinataire rattaché à un compte (abonnement push activé sur un appareil
//   connecté, voir migration 0008) : notification in-app via le hub temps
//   réel du compte (worker/sync.ts) si au moins un appareil y est connecté,
//   sinon Web Push sur chacun de ses abonnements.
// - Visiteur anonyme : Web Push uniquement, comme avant.
//
// La notification in-app voyage sous forme structurée (`kind` + titre du
// média) et est mise en forme côté client dans la langue active de l'app
// (voir src/shared/components/InAppNotifications) ; le Web Push, lui, est
// rédigé ici dans la langue enregistrée sur chaque abonnement.
import { deleteSubscriptionById } from "./db.ts";
import { sendPush, ExpiredSubscriptionError } from "./push.ts";
import { deliverToUser } from "./sync.ts";
import { logError } from "./logger.ts";
import type { Env, SubscriptionRow } from "./types.ts";

// Doit rester aligné avec NotificationKind (src/core/sync/liveSync.ts).
// "test" : envoyée à la demande depuis les réglages (POST /api/notifications/test).
// "newFollower" : quelqu'un vient de suivre le profil — `mediaTitle` porte
// alors le nom affiché de l'abonné (vide s'il n'en a pas ou si son profil
// est privé).
// "reminderReleased" / "reminderAvailable" : rappels « Me prévenir » (voir
// worker/scheduled.ts, checkReminders).
// "addedToList" : le propriétaire d'une liste commune vous y ajoute —
// `mediaTitle` porte le nom de la liste.
export type NotificationKind =
  | "watchlistAvailable"
  | "favoriteGenreRelease"
  | "trendingRelease"
  | "test"
  | "newFollower"
  | "reminderReleased"
  | "reminderAvailable"
  | "addedToList";

export interface AppNotification {
  kind: NotificationKind;
  mediaTitle: string;
  url: string;
}

// Un compte (tous ses abonnements rattachés) ou un abonnement anonyme seul.
export interface NotificationRecipient {
  userId: number | null;
  subscriptions: SubscriptionRow[];
  // Hôte de la requête à l'origine de la notification (ex. un abonnement à
  // un profil) : permet de livrer in-app même à un compte qui n'a jamais
  // activé les notifications push sur un de ses appareils.
  syncHost?: string;
}

export type NotificationChannel = "in-app" | "push";

type PushLocale = "fr" | "en";

function pushLocaleOf(subscription: SubscriptionRow): PushLocale {
  return subscription.locale === "en" ? "en" : "fr";
}

const PUSH_CONTENT: Record<
  PushLocale,
  Record<NotificationKind, (title: string) => { title: string; body: string }>
> = {
  fr: {
    watchlistAvailable: (title) => ({
      title: "Seancy : nouvelle dispo 🎬",
      body: `« ${title} » est maintenant disponible en streaming.`,
    }),
    favoriteGenreRelease: (title) => ({
      title: "Seancy : nouveauté dans vos genres préférés 🍿",
      body: `« ${title} » vient de sortir.`,
    }),
    trendingRelease: (title) => ({
      title: "Seancy : ça sort en ce moment 🔥",
      body: `« ${title} » fait parler de lui.`,
    }),
    test: () => ({
      title: "Seancy : notification de test 🔔",
      body: "Reçue en Web Push : aucun appareil de votre compte n'avait l'app ouverte.",
    }),
    newFollower: (name) => ({
      title: "Seancy : nouvel abonné 👋",
      body: `${name || "Quelqu'un"} a commencé à vous suivre.`,
    }),
    reminderReleased: (title) => ({
      title: "Seancy : c'est le jour J 🎟️",
      body: `« ${title} » sort aujourd'hui.`,
    }),
    reminderAvailable: (title) => ({
      title: "Seancy : disponible en streaming 🎬",
      body: `« ${title} » vient d'arriver sur une plateforme.`,
    }),
    addedToList: (listName) => ({
      title: "Seancy : liste commune 📋",
      body: `Vous avez été ajouté à la liste « ${listName} ».`,
    }),
  },
  en: {
    watchlistAvailable: (title) => ({
      title: "Seancy: new availability 🎬",
      body: `"${title}" is now available to stream.`,
    }),
    favoriteGenreRelease: (title) => ({
      title: "Seancy: new in your favorite genres 🍿",
      body: `"${title}" was just released.`,
    }),
    trendingRelease: (title) => ({
      title: "Seancy: trending right now 🔥",
      body: `"${title}" is getting a lot of buzz.`,
    }),
    test: () => ({
      title: "Seancy: test notification 🔔",
      body: "Received via Web Push: no device on your account had the app open.",
    }),
    newFollower: (name) => ({
      title: "Seancy: new follower 👋",
      body: `${name || "Someone"} started following you.`,
    }),
    reminderReleased: (title) => ({
      title: "Seancy: release day 🎟️",
      body: `"${title}" is out today.`,
    }),
    reminderAvailable: (title) => ({
      title: "Seancy: now streaming 🎬",
      body: `"${title}" just arrived on a streaming service.`,
    }),
    addedToList: (listName) => ({
      title: "Seancy: shared list 📋",
      body: `You were added to the list "${listName}".`,
    }),
  },
};

async function deliverInApp(
  userId: number,
  subscriptions: SubscriptionRow[],
  notification: AppNotification,
  syncHost: string | undefined
): Promise<boolean> {
  // Un hub par (hôte, compte) : on vise chaque hôte depuis lequel un
  // appareil du compte s'est abonné (en pratique, un seul).
  const hosts = new Set(
    [...subscriptions.map((s) => s.sync_host), syncHost].filter((host): host is string =>
      Boolean(host)
    )
  );
  let delivered = 0;
  for (const host of hosts) {
    delivered += await deliverToUser(host, userId, {
      type: "notification",
      payload: notification,
    });
  }
  return delivered > 0;
}

async function deliverPush(
  env: Env,
  subscription: SubscriptionRow,
  notification: AppNotification
): Promise<void> {
  try {
    await sendPush(
      subscription,
      {
        ...PUSH_CONTENT[pushLocaleOf(subscription)][notification.kind](notification.mediaTitle),
        url: notification.url,
      },
      env
    );
  } catch (err) {
    if (err instanceof ExpiredSubscriptionError) {
      await deleteSubscriptionById(env.DB, subscription.id);
    } else {
      logError(`Push échoué pour l'abonnement ${subscription.id} :`, err);
    }
  }
}

export async function notifyUser(
  env: Env,
  recipient: NotificationRecipient,
  notification: AppNotification
): Promise<NotificationChannel> {
  if (
    recipient.userId !== null &&
    (await deliverInApp(
      recipient.userId,
      recipient.subscriptions,
      notification,
      recipient.syncHost
    ))
  ) {
    return "in-app";
  }
  for (const subscription of recipient.subscriptions) {
    await deliverPush(env, subscription, notification);
  }
  return "push";
}
