// Wrapper de log unique pour le client React : uniformise les
// `console.error`/`console.warn` dispersés précédemment et les fait remonter
// dans Sentry. `ensureSentryInit` récupère le DSN depuis le worker (voir
// /api/sentry-dsn, worker/index.ts) plutôt que de le coder en dur au build —
// même logique que la clé "site" reCAPTCHA (RegionContext). Tant qu'aucun
// DSN n'est renvoyé (dev local, ou avant que le secret Cloudflare ne soit
// posé), Sentry reste non initialisé et capture*() est un no-op silencieux.
//
// Le SDK est chargé à la demande (`import()`), une fois le DSN connu : il
// n'alourdit plus le bundle initial, et n'est jamais téléchargé sans DSN
// (audit H6).
type SentryModule = typeof import("@sentry/react");

let sentryInitPromise: Promise<void> | null = null;
let sentry: SentryModule | null = null;

export function ensureSentryInit(): Promise<void> {
  if (!sentryInitPromise) {
    sentryInitPromise = fetch("/api/sentry-dsn")
      .then((res) => res.json())
      .then(async ({ dsn }: { dsn?: string | null }) => {
        if (dsn) {
          const module = await import("@sentry/react");
          // Tag partagé avec le Worker (worker/sentry.ts) et le script de
          // logs infra du NAS : permet de filtrer un seul projet Sentry
          // plutôt que d'en séparer un par source (voir ticket Trello
          // "Avenir du développement").
          module.init({ dsn, tracesSampleRate: 0, initialScope: { tags: { source: "app" } } });
          sentry = module;
        }
      })
      .catch(() => {
        // Pas de réseau / API indisponible : on continue sans Sentry, les
        // console.error/warn restent le seul filet dans ce cas.
      });
  }
  return sentryInitPromise;
}

// Une erreur levée avant la fin de l'initialisation est envoyée dès que le
// SDK est prêt, plutôt que perdue. Sans `ensureSentryInit` préalable (client
// automatisé, voir main.tsx), rien n'est envoyé.
function withSentry(send: (module: SentryModule) => void): void {
  if (sentry) {
    send(sentry);
    return;
  }
  void sentryInitPromise?.then(() => {
    if (sentry) {
      send(sentry);
    }
  });
}

export function logError(message: string, err: unknown): void {
  console.error(message, err);
  const error = err instanceof Error ? err : new Error(`${message}: ${String(err)}`);
  withSentry((module) => module.captureException(error));
}

export function logWarn(message: string, err?: unknown): void {
  console.warn(message, err);
  const text = err ? `${message} ${String(err)}` : message;
  withSentry((module) => module.captureMessage(text, "warning"));
}
