// Envoi de notifications Web Push depuis un Cloudflare Worker.
//
// `web-push` fait tout le travail cryptographique (chiffrement du payload,
// signature du JWT VAPID) via node:crypto — disponible grâce au flag
// nodejs_compat. On n'utilise PAS `webpush.sendNotification()` : elle envoie
// la requête via le module `https` de Node, qui n'est pas garanti de bien
// fonctionner dans le runtime Workers. On récupère à la place les détails de
// requête déjà prêts (`generateRequestDetails`) et on les envoie nous-mêmes
// avec `fetch`, natif à Workers.
import webpush from "web-push";
import type { Env, SubscriptionRow } from "./types.ts";
import { cleanVapidKey, vapidProblem } from "./vapid.ts";

export class ExpiredSubscriptionError extends Error {}

// Réponse de FCM quand la clé VAPID de la requête n'est pas celle utilisée à
// la création de l'abonnement : « the VAPID credentials in the authorization
// header do not correspond to the credentials used to create the subscriptions ».
const VAPID_MISMATCH_PATTERN = /VAPID credentials.*do not correspond/i;

// Équivalent côté Apple (web.push.apple.com) : 400 {"reason":"VapidPkHashMismatch"}.
const APPLE_VAPID_MISMATCH_PATTERN = /"reason"\s*:\s*"VapidPkHashMismatch"/;

let vapidConfigured = false;

function ensureVapid(env: Env): void {
  if (vapidConfigured) {
    return;
  }
  const problem = vapidProblem(env);
  if (problem) {
    throw new Error(`Notifications impossibles : ${problem}`);
  }
  // Clés nettoyées (worker/vapid.ts) : un secret collé avec un retour à la ligne ou des guillemets passe
  webpush.setVapidDetails(
    env.VAPID_SUBJECT.trim(),
    cleanVapidKey(env.VAPID_PUBLIC_KEY),
    cleanVapidKey(env.VAPID_PRIVATE_KEY)
  );
  vapidConfigured = true;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

// `subscription` : { endpoint, p256dh, auth } (forme stockée en base).
// `payload` : objet JS sérialisable, reçu par le service worker côté client.
export async function sendPush(
  subscription: Pick<SubscriptionRow, "endpoint" | "p256dh" | "auth">,
  payload: PushPayload,
  env: Env
): Promise<void> {
  ensureVapid(env);

  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
  };

  const details = webpush.generateRequestDetails(pushSubscription, JSON.stringify(payload));

  const res = await fetch(details.endpoint, {
    method: details.method,
    headers: details.headers as HeadersInit,
    body: details.body,
  });

  if (res.status === 404 || res.status === 410) {
    // Abonnement expiré ou révoqué côté navigateur : à supprimer de la base.
    throw new ExpiredSubscriptionError(`Abonnement invalide (${res.status})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Abonnement créé avec une autre paire VAPID (rotation des clés) : il ne
    // pourra plus jamais être utilisé, on le traite comme expiré. On ne matche
    // que ce message précis — un 403 peut avoir d'autres causes (JWT expiré,
    // quota...) qui ne justifient pas de supprimer l'abonnement.
    if (
      (res.status === 403 && VAPID_MISMATCH_PATTERN.test(text)) ||
      (res.status === 400 && APPLE_VAPID_MISMATCH_PATTERN.test(text))
    ) {
      throw new ExpiredSubscriptionError(
        `Abonnement créé avec une ancienne clé VAPID (${res.status})`
      );
    }
    throw new Error(`Échec de l'envoi push (${res.status}) : ${text}`);
  }
}
