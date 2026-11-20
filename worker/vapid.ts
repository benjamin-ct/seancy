// Clés VAPID des notifications push (worker/push.ts) : remises au format que
// la bibliothèque web-push exige (base64 « URL » sans « = » : 43 caractères pour
// la clé privée, 87 pour la publique). Un secret collé avec un retour à la
// ligne, des guillemets, un « = » final ou en base64 classique (« + », « / »)
// était refusé à chaque envoi (validatePrivateKey) : plus aucune notification
// ne partait (vu en production du 11 au 17 novembre 2026).

/** Clé nettoyée : sans espaces ni guillemets autour, « + / » en « - _ », sans « = » final. */
export const cleanVapidKey = (key = "") =>
  key
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim()
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

/** Ce qui empêche l'envoi des notifications, ou null si les clés sont utilisables. Ne montre jamais la clé. */
export function vapidProblem(env: {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}): string | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    return "clés VAPID manquantes (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT)";
  }
  const priv = cleanVapidKey(env.VAPID_PRIVATE_KEY);
  if (!/^[A-Za-z0-9_-]{43}$/.test(priv)) {
    return `secret VAPID_PRIVATE_KEY illisible : ${priv.length} caractères${/[^A-Za-z0-9_-]/.test(priv) ? " dont des caractères interdits" : ""}, une clé privée VAPID en fait 43 (base64 URL)`;
  }
  if (!/^[A-Za-z0-9_-]{87}$/.test(cleanVapidKey(env.VAPID_PUBLIC_KEY))) {
    return "VAPID_PUBLIC_KEY illisible : une clé publique VAPID fait 87 caractères (base64 URL)";
  }
  if (!/^(mailto:|https:\/\/)/.test(env.VAPID_SUBJECT.trim())) {
    return "VAPID_SUBJECT doit commencer par « mailto: » ou « https:// »";
  }
  return null;
}
