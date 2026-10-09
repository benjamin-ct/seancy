// Seules fonctions du SDK Sentry utilisées par le client (voir logger.ts).
// Chargé à la demande via `import()` de CE module plutôt que de
// "@sentry/react" directement : un `import()` du paquet entier, dont le
// module est ensuite gardé dans une variable, empêche le tree-shaking et
// embarquait tout le SDK (replay, feedback, tracing…) — 474 Ko au lieu
// d'environ 85 Ko (156 Ko contre 29 Ko gzip).
export { init, captureException, captureMessage, logger } from "@sentry/react";
