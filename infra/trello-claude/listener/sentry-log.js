// Logs infra (webhook listener, statut du pipeline Claude) poussés vers
// Sentry, tagués `source: "infra"` — même projet Sentry que l'app
// (`source: "app"`, voir worker/sentry.ts et src/core/logger.ts), filtrable
// par tag plutôt que séparé en deux projets (décidé sur le ticket Trello
// "Avenir du développement", suite à la demande de ne pas multiplier les
// outils de logs à maintenir).
//
// Pas de dépendance au SDK Cloudflare/React du reste du repo : @sentry/node,
// seule dépendance npm de ce service (jusqu'ici volontairement sans aucune,
// voir Dockerfile). `SENTRY_DSN` réutilise la même valeur que le secret déjà
// posé côté dashboard Cloudflare pour le Worker (Settings → Variables and
// Secrets) — à copier dans le `.env` du NAS, voir .env.example. Reste un
// no-op silencieux tant qu'il n'est pas défini, comme worker/sentry.ts et
// src/core/logger.ts.
const Sentry = require("@sentry/node");

const SENTRY_DSN = process.env.SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 0,
    initialScope: { tags: { source: "infra" } },
  });
}

function logInfo(message, extra) {
  console.log(`[sentry-log] ${message}`);
  if (SENTRY_DSN) {
    Sentry.captureMessage(message, { level: "info", extra });
  }
}

function logWarn(message, extra) {
  console.warn(`[sentry-log] ${message}`);
  if (SENTRY_DSN) {
    Sentry.captureMessage(message, { level: "warning", extra });
  }
}

function logError(message, extra) {
  console.error(`[sentry-log] ${message}`);
  if (SENTRY_DSN) {
    Sentry.captureMessage(message, { level: "error", extra });
  }
}

module.exports = { logInfo, logWarn, logError };
