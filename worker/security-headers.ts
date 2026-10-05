// En-têtes de durcissement HTTP — source UNIQUE, partagée par :
// - le Worker (worker/index.ts, withSecurityHeaders) pour les réponses /api/* ;
// - public/_headers, que Cloudflare applique nativement aux assets statiques
//   (dont `/`), qui ne passent pas par le Worker. Ce fichier est GÉNÉRÉ à
//   partir d'ici : `npm run headers:generate` le réécrit, et la CI
//   (`npm run verify:security-headers`) échoue s'il n'est plus à jour. Les
//   deux copies avaient divergé quand elles étaient maintenues à la main
//   (www.gravatar.com présent dans _headers mais pas dans le Worker).
//
// Pas d'import ici : le module est aussi chargé par node dans
// scripts/security-headers.ts.
//
// `frame-src` autorise les bandes-annonces YouTube embarquées (TrailerButton)
// et l'iframe invisible de reCAPTCHA v3 ; `script-src`/`connect-src`
// autorisent le script reCAPTCHA et ses appels réseau ; `style-src
// 'unsafe-inline'` est nécessaire pour les styles inline posés par React
// (style={{...}}), largement utilisés dans l'app. Les polices sont
// auto-hébergées (paquets @fontsource importés dans src/main.tsx) : aucun
// domaine tiers en style-src/font-src, `default-src 'self'` suffit.
// `img-src` : affiches TMDB, miniatures YouTube, avatars Gravatar
// (AccountSettings). `connect-src` inclut aussi https://image.tmdb.org : le
// service worker (src/sw.ts) met les affiches en cache via un fetch() interne
// (Workbox CacheFirst), classifié sous connect-src (pas img-src, qui ne couvre
// que les <img> natifs) — sans ça, les affiches se chargent au premier accès
// mais disparaissent partout dès qu'on recharge la page (SW actif, requêtes
// interceptées et bloquées). `static.cloudflareinsights.com` sert le script
// du beacon Web Analytics (src/core/webAnalytics.ts) ; le beacon envoie
// ensuite ses données RUM en XHR vers `cloudflareinsights.com` (sans le
// sous-domaine `static.`), d'où les deux domaines en connect-src.
// `*.ingest.de.sentry.io` reçoit les rapports d'erreur du SDK Sentry client
// (src/core/logger.ts, région EU).

// Origines WebSocket de la synchro : seancy.com (prod), ses sous-domaines
// (previews `<slug>.dev.seancy.com`) et l'ancienne URL workers.dev, dont les
// onglets encore ouverts se reconnectent le temps d'être redirigés.
const SYNC_SOCKET_SOURCES =
  "wss://seancy.com wss://*.seancy.com wss://*.creusatbenjamin.workers.dev";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://www.google.com https://www.gstatic.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https://image.tmdb.org https://i.ytimg.com https://www.gravatar.com data:",
  // `wss://…` : WebSocket de synchro temps réel (worker/sync.ts) —
  // explicite car Safari ne couvre pas wss: par 'self'.
  `connect-src 'self' https://www.google.com https://image.tmdb.org https://static.cloudflareinsights.com https://cloudflareinsights.com https://*.ingest.de.sentry.io ${SYNC_SOCKET_SOURCES}`,
  "frame-src https://www.youtube.com https://www.google.com",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

// Fichiers du build Vite (JS, CSS, polices) : leur nom contient un hash du
// contenu, une nouvelle version porte donc un nouveau nom. Sans cet en-tête,
// Cloudflare les sert en `max-age=0, must-revalidate` : chaque visite
// revalidait chaque fichier (un aller-retour par fichier, coûteux sur une
// connexion lente) au lieu de les lire directement dans le cache du
// navigateur. index.html, sw.js et les fichiers de public/ (noms fixes)
// restent revalidés.
const HASHED_ASSETS_HEADERS: Record<string, string> = {
  "cache-control": "public, max-age=31536000, immutable",
};

function renderHeaderBlock(pattern: string, headers: Record<string, string>): string[] {
  const lines = [pattern];
  for (const [key, value] of Object.entries(headers)) {
    const name = key.replace(
      /(^|-)([a-z])/g,
      (_, dash: string, c: string) => dash + c.toUpperCase()
    );
    lines.push(`  ${name}: ${value}`);
  }
  return lines;
}

// Contenu attendu de public/_headers (format Cloudflare : un motif de
// chemin, puis les en-têtes indentés ; les blocs dont le motif correspond
// s'additionnent).
export function renderHeadersFile(): string {
  const lines = [
    ...renderHeaderBlock("/*", SECURITY_HEADERS),
    ...renderHeaderBlock("/assets/*", HASHED_ASSETS_HEADERS),
  ];
  return lines.join("\n") + "\n";
}
