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
    // Sans environment explicite, le SDK retombe sur "production" par
    // défaut : le NAS n'a qu'une seule instance (pas de distinction
    // prod/preprod/feature comme pour l'app, voir worker/sentry.ts), mais
    // "infra" évite qu'il se mélange aux vraies erreurs prod de l'app dans
    // les vues filtrées par environment.
    environment: "infra",
    initialScope: { tags: { source: "infra" } },
  });
}

// Sentry.logger (feature Logs), pas captureMessage (feature Issues) : ce
// sont des événements opérationnels (déclenchement, succès, limite
// d'usage), pas des erreurs à trier dans le flux d'Issues — captureMessage
// y créait une Issue, qui redéclenchait le webhook Sentry → Claude (voir
// #290/#291).
function logInfo(message, extra) {
  console.log(`[sentry-log] ${message}`);
  if (SENTRY_DSN) {
    Sentry.logger.info(message, extra);
  }
}

function logWarn(message, extra) {
  console.warn(`[sentry-log] ${message}`);
  if (SENTRY_DSN) {
    Sentry.logger.warn(message, extra);
  }
}

function logError(message, extra) {
  console.error(`[sentry-log] ${message}`);
  if (SENTRY_DSN) {
    Sentry.logger.error(message, extra);
  }
}

module.exports = { logInfo, logWarn, logError };
