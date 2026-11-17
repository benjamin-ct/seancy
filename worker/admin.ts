// Espace admin (admin.seancy.com, derrière Cloudflare Access) : tableau de
// bord, tickets envoyés à Claude (worker/tickets.ts) et outils de maintenance.
//
// Deux portes, l'une après l'autre :
// 1. Cloudflare Access devant tout le domaine admin (application Access,
//    jeton vérifié ici sur chaque appel /api du domaine : worker/access.ts) ;
// 2. un compte Seancy connecté dont l'adresse figure dans le secret
//    ADMIN_EMAILS (adresses séparées par des virgules).
// Sur seancy.com (le site public), aucune session n'ouvre l'espace admin : il
// ne répond que sur son domaine (et sur les previews et le dev local, sous
// /admin, pour l'essayer).
import { getUserFromRequest, type AuthUser } from "./auth.ts";
import { verifyAccessJwt } from "./access.ts";
import { cloudflareUsage } from "./cloudflare-usage.ts";
import * as Sentry from "@sentry/cloudflare";
import { logError } from "./logger.ts";
import { ExpiredSubscriptionError, sendPush } from "./push.ts";
import { vapidProblem } from "./vapid.ts";
import { runDailyCheck } from "./scheduled.ts";
import { syncPopularTitles } from "./search-index.ts";
import {
  ADMIN_HOSTNAME,
  PREPROD_HOSTNAME,
  PRODUCTION_HOSTNAME,
  REDIRECTED_TO_PRODUCTION_HOSTNAMES,
  isProductionHostname,
} from "./sentry.ts";
import type { Env } from "./types.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export const isAdminHostname = (hostname: string) =>
  hostname === ADMIN_HOSTNAME || hostname === "admin.localhost";

export const adminEmails = (env: Env) =>
  (env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export const accessConfigured = (env: Env) => !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

/**
 * Porte Cloudflare Access d'une requête du domaine admin : jeton valide, ou
 * Access pas encore réglé (secrets absents : signalé sur le tableau de bord).
 */
export async function accessGate(request: Request, env: Env): Promise<boolean> {
  if (!accessConfigured(env)) {
    return true;
  }
  const token = request.headers.get("cf-access-jwt-assertion") || "";
  return (await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN!, env.ACCESS_AUD!)) !== null;
}

/** Administrateur connecté (compte Seancy dans ADMIN_EMAILS), jamais sur le site public. */
// Previews de PR (derrière le Cloudflare Access des previews, connexion par
// code affiché à l'écran) : les comptes de démo du seed
// (scripts/fixtures/develop-seed.sql, adresses @exemple.test) sont aussi
// administrateurs, pour essayer l'espace admin sous /admin. Jamais en
// production, sur le domaine admin, ni sur l'environnement develop.
const isPreviewHost = (host: string) =>
  !isProductionHostname(host) &&
  host !== PREPROD_HOSTNAME &&
  !isAdminHostname(host) &&
  !REDIRECTED_TO_PRODUCTION_HOSTNAMES.includes(host);
const isDemoAdmin = (email: string, host: string) =>
  isPreviewHost(host) && email.toLowerCase().endsWith("@exemple.test");

/** Administrateur connecté (compte Seancy dans ADMIN_EMAILS), jamais sur le site public. */
export async function adminOf(request: Request, env: Env): Promise<AuthUser | null> {
  const host = new URL(request.url).hostname;
  const admins = adminEmails(env);
  if (
    host === PRODUCTION_HOSTNAME ||
    // Adresses workers.dev et www : seule la clé des sessions Claude y ouvre l'API des tickets
    REDIRECTED_TO_PRODUCTION_HOSTNAMES.includes(host) ||
    (!admins.length && !isPreviewHost(host)) ||
    !request.headers.get("cookie")
  ) {
    return null;
  }
  const user = await getUserFromRequest(env.DB, request);
  return user && (admins.includes(user.email.toLowerCase()) || isDemoAdmin(user.email, host))
    ? user
    : null;
}
export const adminName = (u: AuthUser) => u.displayName || u.username || u.email.split("@")[0];

async function count(env: Env, sql: string, ...args: unknown[]): Promise<number> {
  try {
    const row = await env.DB.prepare(sql)
      .bind(...args)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

async function overview(env: Env, request: Request) {
  const day = 24 * 3600 * 1000;
  const now = Date.now();
  const { results: byStatus } = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM tickets GROUP BY status"
  ).all<{ status: string; n: number }>();
  const has = (v: unknown) => !!v;
  return {
    stats: {
      users: await count(env, "SELECT COUNT(*) AS n FROM users"),
      usersWeek: await count(
        env,
        "SELECT COUNT(*) AS n FROM users WHERE created_at >= ?",
        now - 7 * day
      ),
      activeMonth: await count(
        env,
        "SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE created_at >= ?",
        now - 30 * day
      ),
      subscriptions: await count(env, "SELECT COUNT(*) AS n FROM subscriptions"),
      libraryItems: await count(env, "SELECT COUNT(*) AS n FROM library_items"),
      customLists: await count(env, "SELECT COUNT(*) AS n FROM custom_lists"),
    },
    tickets: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    // Réglages : seulement « présent ou non », jamais une valeur
    config: [
      {
        group: "Espace admin",
        items: [
          {
            name: "Cloudflare Access",
            ok: accessConfigured(env),
            help: "secrets ACCESS_TEAM_DOMAIN et ACCESS_AUD",
          },
          // Seulement une fois Access réglé (sinon, le réglage manquant est déjà compté juste au-dessus)
          ...(accessConfigured(env)
            ? [
                {
                  name: "Jeton Access vérifié sur cette page",
                  ok: await accessGate(request, env),
                  help: "jeton Cf-Access-Jwt-Assertion valide",
                },
              ]
            : []),
          {
            name: "Administrateurs",
            ok: adminEmails(env).length > 0,
            help: `secret ADMIN_EMAILS (${adminEmails(env).length})`,
          },
          {
            name: "Quotas Cloudflare",
            ok: has(env.CF_ANALYTICS_TOKEN),
            help: "secret CF_ANALYTICS_TOKEN (jeton « Account Analytics : Read »)",
          },
        ],
      },
      {
        group: "Tickets",
        items: [
          {
            name: "Envoi à Claude",
            ok: has(env.GITHUB_TICKETS_TOKEN),
            help: "secret GITHUB_TICKETS_TOKEN",
          },
          {
            name: "Notifications Discord",
            ok: has(env.DISCORD_TICKETS_WEBHOOK_URL),
            help: "secret DISCORD_TICKETS_WEBHOOK_URL (facultatif)",
          },
        ],
      },
      {
        group: "Site",
        items: [
          { name: "TMDB", ok: has(env.TMDB_API_KEY), help: "secret TMDB_API_KEY" },
          {
            name: "Notifications push",
            ok: !vapidProblem(env),
            help: vapidProblem(env) ?? "clés VAPID au bon format",
          },
          { name: "E-mails (Resend)", ok: has(env.RESEND_API_KEY), help: "secret RESEND_API_KEY" },
          { name: "Sentry", ok: has(env.SENTRY_DSN), help: "secret SENTRY_DSN" },
          {
            name: "reCAPTCHA",
            ok: has(env.RECAPTCHA_SECRET_KEY),
            help: "secret RECAPTCHA_SECRET_KEY",
          },
          {
            name: "Connexion Google",
            ok: has(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
            help: "secrets GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET",
          },
          {
            name: "Connexion Apple",
            ok: has(
              env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY
            ),
            help: "secrets APPLE_*",
          },
          { name: "Suggestions IA", ok: has(env.AI), help: "binding Workers AI" },
        ],
      },
    ],
  };
}

/** Notification de test envoyée aux appareils du compte administrateur (jamais aux autres abonnés). */
async function testNotification(env: Env, user: AuthUser) {
  const { results } = await env.DB.prepare(
    "SELECT id, endpoint, p256dh, auth FROM subscriptions WHERE user_id = ?"
  )
    .bind(user.id)
    .all<{ id: number; endpoint: string; p256dh: string; auth: string }>();
  if (!results.length) {
    return json(
      {
        error:
          "Aucun appareil abonné aux notifications pour ce compte : active-les d'abord dans Seancy.",
      },
      404
    );
  }
  let sent = 0;
  let expired = 0;
  const reasons = new Set<string>();
  for (const s of results) {
    try {
      await sendPush(
        s,
        {
          title: "Seancy 🎬",
          body: "Notification de test envoyée depuis l'espace admin.",
          url: "/",
        },
        env
      );
      sent++;
    } catch (err) {
      if (err instanceof ExpiredSubscriptionError) {
        expired++;
        await env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(s.id).run();
      } else {
        reasons.add(err instanceof Error ? err.message : String(err));
      }
    }
  }
  // Raison des échecs dite sur la page (avant : « 0 appareil sur 8 » sans explication)
  const message = [
    `Notification envoyée à ${sent} appareil${sent > 1 ? "s" : ""} sur ${results.length}`,
    expired
      ? `${expired} abonnement${expired > 1 ? "s" : ""} expiré${expired > 1 ? "s" : ""}, retiré${expired > 1 ? "s" : ""}`
      : "",
    reasons.size ? `échec : ${[...reasons].slice(0, 2).join(" ; ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return sent || !reasons.size ? json({ ok: true, message }) : json({ error: message }, 502);
}

export async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response> {
  const sub = url.pathname.replace(/^\/api\/admin\/?/, "");
  const user = await adminOf(request, env);
  // Pour la page : qui est connecté et s'il est administrateur (rien d'autre)
  if (sub === "me" && request.method === "GET") {
    const signedIn = !!(await getUserFromRequest(env.DB, request).catch(() => null));
    return json({
      admin: !!user,
      signedIn,
      name: user ? adminName(user) : "",
      email: user?.email ?? "",
    });
  }
  if (!user) {
    return json({ error: "Réservé aux administrateurs de Seancy" }, 403);
  }
  if (sub === "overview" && request.method === "GET") {
    return json(await overview(env, request));
  }
  // Quotas Cloudflare du compte (à part : le tableau de bord s'affiche même si Cloudflare tarde)
  if (sub === "usage" && request.method === "GET") {
    const r = await cloudflareUsage(env);
    return json(r, "usage" in r || r.missing ? 200 : 502);
  }
  if (request.method === "POST" && sub.startsWith("tools/")) {
    // Échec d'un outil (secret manquant, TMDB injoignable…) : sa raison affichée sur la page
    try {
      switch (sub.slice("tools/".length)) {
        case "run-check":
          ctx.waitUntil(runDailyCheck(env));
          return json({
            ok: true,
            message: "Vérification des nouveautés lancée (notifications envoyées si besoin)",
          });
        case "sync-search-index":
          await syncPopularTitles(env);
          return json({ ok: true, message: "Index de recherche resynchronisé" });
        case "test-error":
          logError(
            "Erreur de test",
            new Error(`Erreur de test — déclenchée depuis l'espace admin par ${adminName(user)}`)
          );
          return json({ ok: true, message: "Erreur de test envoyée à Sentry" });
        case "test-notification":
          return testNotification(env, user);
        // Toute la chaîne jusqu'à la page Tickets : erreur nouvelle à chaque essai (empreinte unique,
        // donc nouvelle issue et nouvelle alerte), reconnue par sentry-triage, qui en fait un ticket
        case "test-sentry-ticket": {
          const essai = new Date().toISOString().slice(0, 16).replace("T", " ");
          const err = new Error(`Test ticket Sentry — essai du ${essai} UTC (${adminName(user)})`);
          console.error(err.message);
          Sentry.captureException(err, {
            fingerprint: ["test-ticket-sentry", crypto.randomUUID()],
            tags: { test: "ticket" },
          });
          return json({
            ok: true,
            message:
              "Erreur « Test ticket Sentry » envoyée : alerte sur Discord, puis ticket « À faire » créé par sentry-triage (quelques minutes)",
          });
        }
      }
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }
  return json({ error: "Introuvable" }, 404);
}
