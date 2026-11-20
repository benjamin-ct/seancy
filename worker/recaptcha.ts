// Vérification reCAPTCHA v3 côté serveur — filtre les bots/scripts qui
// tapent directement sur l'API sans jamais passer par un vrai navigateur
// (curl, requêtes automatisées) : ceux-ci ne peuvent tout simplement pas
// produire de jeton valide (grecaptcha.execute() tourne en JS côté client,
// dans le contexte d'une vraie page). reCAPTCHA v3 est invisible (pas de
// case à cocher) : il renvoie un score de 0 à 1, pas un simple pass/fail.
//
// Sans RECAPTCHA_SECRET_KEY configurée (dev local, ou avant que le
// propriétaire de l'app ait créé ses clés sur google.com/recaptcha/admin),
// la vérification est intégralement sautée — même repli que pour Resend
// (voir auth.ts) : ne bloque jamais le développement local, et ne se
// produit jamais en production une fois la clé configurée.
import type { Env } from "./types.ts";

const MIN_SCORE = 0.5;

export interface RecaptchaResult {
  ok: boolean;
  skipped?: boolean;
  score?: number;
  reason?: string;
  errors?: unknown;
}

interface SiteVerifyResponse {
  success: boolean;
  score?: number;
  action?: string;
  "error-codes"?: string[];
  hostname?: string;
}

/** Refus gardé dans les journaux du Worker (raison, codes de Google, score, adresse) : le client ne voit qu'un message générique. */
function refuse(result: RecaptchaResult, hostname?: string): RecaptchaResult {
  console.warn("reCAPTCHA refusé", JSON.stringify({ ...result, hostname }));
  return result;
}

export async function verifyRecaptcha(
  env: Env,
  token: string | undefined | null,
  expectedAction?: string
): Promise<RecaptchaResult> {
  if (!env.RECAPTCHA_SECRET_KEY) {
    return { ok: true, skipped: true };
  }
  if (!token) {
    return refuse({ ok: false, reason: "missing_token" });
  }

  const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: env.RECAPTCHA_SECRET_KEY, response: token }),
  });
  if (!res.ok) {
    return refuse({ ok: false, reason: "verify_request_failed" });
  }

  const data = (await res.json()) as SiteVerifyResponse;
  if (!data.success) {
    return refuse({ ok: false, reason: "rejected", errors: data["error-codes"] }, data.hostname);
  }
  if (expectedAction && data.action !== expectedAction) {
    return refuse({ ok: false, reason: "action_mismatch" }, data.hostname);
  }
  if (typeof data.score === "number" && data.score < MIN_SCORE) {
    return refuse({ ok: false, reason: "low_score", score: data.score }, data.hostname);
  }

  return { ok: true, skipped: false, score: data.score };
}
