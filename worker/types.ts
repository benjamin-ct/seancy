// Bindings et variables d'environnement du Worker (voir wrangler.jsonc) —
// une seule source de vérité pour le typage de `env` dans tout le worker.
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  // Binding natif Rate Limiting (audit F4, voir wrangler.jsonc) : slugs
  // publics (profil, abonnés, avatar partagé, liste) et upload d'avatar.
  PUBLIC_SLUG_RATE_LIMITER: RateLimit;
  AVATAR_RATE_LIMITER: RateLimit;
  // Événements d'usage (recherche, activation notifs, watchlist...) —
  // consommés côté Grafana Cloud via la datasource Cloudflare Analytics.
  // Voir worker/analytics.ts. Optionnel : le binding n'est déclaré dans
  // wrangler.jsonc qu'une fois Analytics Engine activé côté compte
  // Cloudflare (voir commentaire associé) — absent jusque-là.
  ANALYTICS?: AnalyticsEngineDataset;
  // Synchro temps réel (voir worker/sync.ts, hubFor) : binding déclaré
  // uniquement dans la config des previews PR (scripts/preview-d1.ts) ; en
  // prod, le hub est atteint via `exports` (cloudflare:workers).
  USER_SYNC_HUB?: DurableObjectNamespace<import("./sync.ts").UserSyncHub>;

  // Secrets (dashboard Cloudflare, jamais commités).
  TMDB_API_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  DEBUG_TRIGGER_KEY?: string;
  RESEND_API_KEY?: string;
  RECAPTCHA_SECRET_KEY?: string;
  // DSN Sentry (projet "Cloudflare Workers"/JavaScript) — voir worker/sentry.ts
  // et logger.ts. Un DSN Sentry n'est pas un secret confidentiel par nature
  // (conçu pour être exposé côté client), mais il vit en Secret ici comme
  // TMDB_API_KEY par cohérence avec le reste des identifiants tiers.
  SENTRY_DSN?: string;
  // Connexion avec Google / Apple (voir worker/oauth.ts) : un fournisseur
  // n'est proposé que si tous ses identifiants sont définis. Tous en
  // Secret, même les identifiants publics (client ID, Team ID, Key ID) :
  // une variable ajoutée au dashboard hors wrangler.jsonc disparaîtrait au
  // déploiement suivant.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Services ID « Sign in with Apple » (ex. com.seancy.web). */
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  /** Clé privée .p8 (PEM PKCS#8 ; les « \n » littéraux sont acceptés). */
  APPLE_PRIVATE_KEY?: string;

  // Variables non sensibles (commitées dans wrangler.jsonc, voir vars).
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;
  RECAPTCHA_SITE_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  // Token du beacon Cloudflare Web Analytics (public par nature, comme
  // RECAPTCHA_SITE_KEY ci-dessus) — vide par défaut : tant qu'il n'est pas
  // renseigné, le client saute l'injection du beacon sans rien casser.
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
}

// Lignes D1 (voir migrations/) — reflètent exactement les colonnes
// stockées ; le typage applicatif plus riche (LibraryItem...) vit dans
// src/core/types, réutilisé ici où c'est le même format JSON.
export interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
  locale: string;
  // Compte rattaché (migration 0008) — null pour un visiteur anonyme.
  user_id: number | null;
  sync_host: string | null;
}

export interface WatchlistItemRow {
  subscription_id: number;
  media_type: string;
  tmdb_id: number;
  title: string;
  poster_path: string | null;
  known_providers: string | null;
}

export interface GenrePreferenceRow {
  subscription_id: number;
  media_type: string;
  genre_id: number;
}

export interface LibraryItemRow {
  media_type: string;
  tmdb_id: number;
  status: "watched" | "watchlist";
  data: string;
  updated_at: number;
}

export interface UserRow {
  id: number;
  email: string;
  display_name: string | null;
  share_slug: string | null;
  username: string | null;
  created_at: number;
}

// Typage de `exports` (module cloudflare:workers) / `ctx.exports` : déclare
// quels exports du module principal sont des Durable Objects (voir "exports"
// dans wrangler.jsonc et worker/sync.ts, UserSyncHub).
declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index.ts");
      durableNamespaces: "UserSyncHub";
    }
  }
}
