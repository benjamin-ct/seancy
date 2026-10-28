// Wrapper de log unique pour le Worker : uniformise les `console.error`
// dispersés précédemment et les fait remonter dans Sentry (voir sentry.ts).
// `Sentry.captureException` no-op tant qu'aucun DSN n'est configuré, donc ce
// module reste sûr à utiliser inconditionnellement (dev local y compris).
import * as Sentry from "@sentry/cloudflare";

export function logError(message: string, err: unknown): void {
  console.error(message, err);
  if (err instanceof Error) {
    // `message` porte le contexte spécifique à l'appel (ex. posterPath,
    // tmdbId, userId...) — sans l'attacher ici, Sentry ne groupe que par
    // type d'erreur/stacktrace et perd toute indication de la ressource en
    // cause (vécu sur SEANCY-LOGS-3N : impossible de savoir quelle affiche
    // déclenchait le crash wasm de @jsquash/resize sans ça).
    Sentry.captureException(err, { extra: { message } });
    return;
  }
  // `String(err)` tombe sur "[object Object]" pour un rejet non-Error (ex.
  // objet d'erreur WASM sans toString custom) et masque la vraie cause en
  // Sentry — JSON.stringify garde au moins les clés/valeurs utiles.
  const detail = (() => {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  })();
  Sentry.captureException(new Error(`${message}: ${detail}`));
}
