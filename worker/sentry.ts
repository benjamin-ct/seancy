// Câblage Sentry pour le Worker (erreurs non interceptées + captures
// explicites via logger.ts). `withSentry` no-op proprement tant que
// env.SENTRY_DSN n'est pas configuré (dev local, ou avant que le secret ne
// soit posé côté dashboard Cloudflare) — même logique défensive que
// RECAPTCHA_SITE_KEY/CLOUDFLARE_ANALYTICS_TOKEN.
import * as Sentry from "@sentry/cloudflare";
import type { Env } from "./types.ts";

// Domaine de prod : les previews PR répondent sur `<slug>.dev.seancy.com`
// (domaine de preview réglé sur le Worker, voir .github/workflows/ci.yml, job
// deploy-preview) — tout le reste (dev local compris) est traité comme
// non-prod.
export {
  ADMIN_HOSTNAME,
  PREPROD_HOSTNAME,
  PRODUCTION_HOSTNAME,
  REDIRECTED_TO_PRODUCTION_HOSTNAMES,
  isProductionHostname,
} from "./hostnames.ts";
import { PREPROD_HOSTNAME, isProductionHostname } from "./hostnames.ts";

// Sans environment explicite, le SDK Sentry retombe sur "production" par
// défaut — les erreurs des previews de PR et de `develop` remontaient donc
// jusqu'ici marquées production (voir ticket Trello "Dashboard de suivis de
// Claude"). Reste "preview" pour tout ce qui n'est ni la vraie prod ni
// `develop` (previews de PR, `wrangler dev` local).
export function getEnvironmentName(hostname: string): "production" | "preprod" | "preview" {
  if (isProductionHostname(hostname)) {
    return "production";
  }
  if (hostname === PREPROD_HOSTNAME) {
    return "preprod";
  }
  return "preview";
}

// `wrangler versions upload --preview-alias` ne supprime jamais l'alias de
// preview à la fermeture d'une PR (aucun endpoint Cloudflare pour ça — voir
// carte Trello "Infra : nettoyer les Worker preview aliases"), alors que
// `cleanup-preview-d1` supprime bien la base D1 dédiée. Une preview morte
// reste donc joignable indéfiniment et toute requête qui l'atteint (bot,
// crawler, onglet resté ouvert...) plante sur ce binding D1 disparu — bruit
// Sentry récurrent et trompeur (l'issue remonte marquée "production" faute
// d'environnement explicite). On l'écarte hors du vrai domaine de prod, sans
// toucher aux autres erreurs D1 qui, elles, comptent aussi sur les previews.
const DEAD_PREVIEW_D1_ERROR = /D1_ERROR: D1 database [\w-]+ has been deleted/;

function isDeadPreviewD1Error(event: Sentry.ErrorEvent): boolean {
  const message = event.exception?.values?.map((v) => v.value).join("\n") ?? event.message ?? "";
  return DEAD_PREVIEW_D1_ERROR.test(message);
}

export function withSentry<Handler extends ExportedHandler<Env>>(handler: Handler): Handler {
  return Sentry.withSentry<Env>(
    (env) => ({
      dsn: env.SENTRY_DSN,
      tracesSampleRate: 0,
      // Tag partagé avec le client (src/core/logger.ts) et le script de
      // logs infra du NAS (infra/trello-claude/listener/sentry-log.js) :
      // permet de filtrer un seul projet Sentry ("applicatif" vs "infra"
      // plutôt que deux projets séparés — décidé sur le ticket Trello
      // "Avenir du développement").
      initialScope: { tags: { source: "app" } },
      beforeSend(event) {
        const hostname = event.request?.url ? new URL(event.request.url).hostname : null;
        if (hostname) {
          event.environment = getEnvironmentName(hostname);
        }
        if (hostname && !isProductionHostname(hostname) && isDeadPreviewD1Error(event)) {
          return null;
        }
        return event;
      },
    }),
    handler
  ) as Handler;
}
