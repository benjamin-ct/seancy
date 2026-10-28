// Balises de partage et d'indexation par page (audit H12). Le HTML de l'appli
// est un index.html unique : sans ce module, un lien partagé vers une fiche,
// un profil ou une liste s'affiche partout (WhatsApp, iMessage, Discord,
// moteurs de recherche) avec le titre générique et sans image.
//
// Seules les routes partageables passent par le Worker (`run_worker_first`
// dans wrangler.jsonc) : /media/<type>/<id>, /u/<pseudo>, /liste/<slug>,
// et seules les requêtes de robots y sont enrichies (voir servePageWithMeta).
// Le Worker récupère index.html via ASSETS, puis un HTMLRewriter y remplace
// titre, description, Open Graph, Twitter, canonical et ajoute le JSON-LD.
// En cas d'échec (TMDB lent ou indisponible, base injoignable), la page est
// servie telle quelle : le partage perd son aperçu, l'appli reste intacte.
import { SHARE_SLUG_PATTERN, USERNAME_PATTERN } from "./share-slug.ts";
import { detectKnownCrawler } from "./bots.ts";
import { checkRateLimitInMemory } from "./rate-limit-memory.ts";
import { logError } from "./logger.ts";
import { isProductionHostname } from "./sentry.ts";
import type { Env } from "./types.ts";

const SITE_NAME = "Seancy";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/";
// Métadonnées d'un titre : quasi statiques, gardées un jour en cache d'edge.
const MEDIA_META_TTL_S = 24 * 60 * 60;
// Au-delà, on sert la page sans aperçu plutôt que de retarder l'affichage.
const TMDB_TIMEOUT_MS = 2500;
const DESCRIPTION_MAX_LENGTH = 200;

export const PAGE_META_ROUTE = /^\/(?:media\/(movie|tv)\/(\d+)|u\/([^/]+)|liste\/([^/]+))\/?$/;

interface PageMeta {
  title: string;
  description: string;
  image: string | null;
  type: "video.movie" | "video.tv_show" | "profile" | "website";
  jsonLd?: Record<string, unknown>;
}

type Lang = "fr" | "en";

interface MediaFields {
  title: string;
  overview: string;
  posterPath: string | null;
  date: string | null;
  voteAverage: number;
  voteCount: number;
}

const TEXTS: Record<
  Lang,
  {
    defaultDescription: string;
    mediaFallback: (t: string) => string;
    profile: (n: string) => string;
    list: (l: string, o: string | null) => string;
  }
> = {
  fr: {
    defaultDescription:
      "Découvrez où regarder vos films et séries en streaming, tirez un titre au hasard, et suivez ce que vous avez déjà vu.",
    mediaFallback: (title) => `Où regarder ${title} en streaming, et tout sur le titre.`,
    profile: (name) => `Les films et séries de ${name} sur ${SITE_NAME}.`,
    list: (list, owner) =>
      owner
        ? `La liste « ${list} » de ${owner} sur ${SITE_NAME}.`
        : `La liste « ${list} » sur ${SITE_NAME}.`,
  },
  en: {
    defaultDescription:
      "Find where to stream your movies and shows, pick a title at random, and keep track of what you have watched.",
    mediaFallback: (title) => `Where to stream ${title}, and everything about it.`,
    profile: (name) => `${name}'s movies and shows on ${SITE_NAME}.`,
    list: (list, owner) =>
      owner
        ? `“${list}”, a list by ${owner} on ${SITE_NAME}.`
        : `“${list}”, a list on ${SITE_NAME}.`,
  },
};

// Robots d’aperçu de liens (messageries, réseaux sociaux), absents de la
// liste de bots.ts qui vise les moteurs et les IA. iMessage se présente comme
// facebookexternalhit + Twitterbot, déjà couverts.
const LINK_PREVIEW_UA_PATTERNS = [
  "twitterbot",
  "discordbot",
  "slackbot",
  "whatsapp",
  "telegrambot",
  "linkedinbot",
  "skypeuripreview",
  "pinterest",
  "redditbot",
  "mastodon",
  "embedly",
];

function detectLinkPreviewBot(request: Request): string | null {
  const ua = request.headers.get("user-agent")?.toLowerCase() ?? "";
  return LINK_PREVIEW_UA_PATTERNS.find((pattern) => ua.includes(pattern)) ?? null;
}

// Même règle que l'appli (détection de la langue du navigateur) : anglais
// si le navigateur le préfère, français sinon (dont les robots sans en-tête).
function langFromRequest(request: Request): Lang {
  const header = request.headers.get("accept-language") || "";
  return header.trim().toLowerCase().startsWith("en") ? "en" : "fr";
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchMediaFields(
  origin: string,
  mediaType: "movie" | "tv",
  id: string,
  lang: Lang,
  env: Env,
  ctx: ExecutionContext
): Promise<MediaFields | "not-found" | null> {
  const cache = caches.default;
  const cacheKey = new Request(`${origin}/api/page-meta/${mediaType}/${id}?lang=${lang}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data: MediaFields | { notFound: true } = await cached.json();
    return "notFound" in data ? "not-found" : data;
  }
  if (!env.TMDB_API_KEY) {
    return null;
  }
  const tmdbUrl = new URL(`https://api.themoviedb.org/3/${mediaType}/${id}`);
  tmdbUrl.searchParams.set("language", lang === "en" ? "en-US" : "fr-FR");
  tmdbUrl.searchParams.set("api_key", env.TMDB_API_KEY);
  const res = await fetch(tmdbUrl, { signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) });
  if (res.status === 404) {
    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(JSON.stringify({ notFound: true }), {
          headers: { "cache-control": "public, max-age=3600" },
        })
      )
    );
    return "not-found";
  }
  if (!res.ok) {
    return null;
  }
  const raw: {
    title?: string;
    name?: string;
    overview?: string;
    poster_path?: string | null;
    release_date?: string;
    first_air_date?: string;
    vote_average?: number;
    vote_count?: number;
  } = await res.json();
  const fields: MediaFields = {
    title: raw.title || raw.name || "",
    overview: raw.overview || "",
    posterPath: raw.poster_path ?? null,
    date: raw.release_date || raw.first_air_date || null,
    voteAverage: raw.vote_average ?? 0,
    voteCount: raw.vote_count ?? 0,
  };
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(fields), {
        headers: { "cache-control": `public, max-age=${MEDIA_META_TTL_S}` },
      })
    )
  );
  return fields;
}

function mediaMeta(
  mediaType: "movie" | "tv",
  fields: MediaFields,
  lang: Lang,
  canonical: string
): PageMeta {
  const year = fields.date?.slice(0, 4);
  const image = fields.posterPath ? `${TMDB_IMAGE_BASE}w500${fields.posterPath}` : null;
  const description = truncate(
    fields.overview || TEXTS[lang].mediaFallback(fields.title),
    DESCRIPTION_MAX_LENGTH
  );
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": mediaType === "movie" ? "Movie" : "TVSeries",
    name: fields.title,
    url: canonical,
    description,
    ...(image ? { image } : {}),
    ...(fields.date
      ? { [mediaType === "movie" ? "datePublished" : "startDate"]: fields.date }
      : {}),
    ...(fields.voteCount > 0
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: Math.round(fields.voteAverage * 10) / 10,
            bestRating: 10,
            ratingCount: fields.voteCount,
          },
        }
      : {}),
  };
  return {
    title: `${year ? `${fields.title} (${year})` : fields.title} — ${SITE_NAME}`,
    description,
    image,
    type: mediaType === "movie" ? "video.movie" : "video.tv_show",
    jsonLd,
  };
}

// Requêtes légères (nom seulement) : les fonctions de db.ts chargent tout le
// profil ou toute la liste, inutile pour une balise.
async function profileMeta(db: D1Database, handle: string, lang: Lang): Promise<PageMeta | null> {
  const query = SHARE_SLUG_PATTERN.test(handle)
    ? "SELECT display_name, username FROM users WHERE share_slug = ?"
    : USERNAME_PATTERN.test(handle)
      ? "SELECT display_name, username FROM users WHERE username = ? AND share_slug IS NOT NULL"
      : null;
  const row = query
    ? await db
        .prepare(query)
        .bind(handle)
        .first<{ display_name: string | null; username: string | null }>()
    : null;
  if (!row) {
    return null;
  }
  const name = row.display_name || (row.username ? `@${row.username}` : SITE_NAME);
  return {
    title: `${name} — ${SITE_NAME}`,
    description: TEXTS[lang].profile(name),
    image: null,
    type: "profile",
  };
}

async function listMeta(db: D1Database, slug: string, lang: Lang): Promise<PageMeta | null> {
  const row = await db
    .prepare(
      `SELECT custom_lists.name, users.display_name, users.username
       FROM list_shares
       JOIN custom_lists ON custom_lists.user_id = list_shares.user_id AND custom_lists.id = list_shares.list_id
       JOIN users ON users.id = list_shares.user_id
       WHERE list_shares.slug = ?`
    )
    .bind(slug)
    .first<{ name: string; display_name: string | null; username: string | null }>();
  if (!row) {
    return null;
  }
  const owner = row.display_name || (row.username ? `@${row.username}` : null);
  return {
    title: `${row.name} — ${SITE_NAME}`,
    description: TEXTS[lang].list(row.name, owner),
    image: null,
    type: "website",
  };
}

function metaTags(meta: PageMeta, canonical: string, origin: string, noindex: boolean): string {
  const image = meta.image ?? `${origin}/icon-512.png`;
  const tags = [
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:type" content="${meta.type}" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta name="twitter:card" content="${meta.image ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ];
  if (noindex) {
    tags.push(`<meta name="robots" content="noindex" />`);
  }
  if (meta.jsonLd) {
    // `<` échappé : un titre contenant « </script> » ne peut pas fermer le bloc.
    const json = JSON.stringify(meta.jsonLd).replace(/</g, "\\u003c");
    tags.push(`<script type="application/ld+json">${json}</script>`);
  }
  return tags.join("\n    ");
}

// Réécrit index.html : titre, description, et remplacement des balises
// Open Graph/Twitter statiques par celles de la page.
function rewrite(html: Response, meta: PageMeta, tags: string, status: number): Response {
  const rewritten = new HTMLRewriter()
    .on("title", {
      element(el) {
        el.setInnerContent(meta.title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute("content", meta.description);
      },
    })
    .on('meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"]', {
      element(el) {
        el.remove();
      },
    })
    .on("head", {
      element(el) {
        el.append(tags, { html: true });
      },
    })
    .transform(html);
  const headers = new Headers(rewritten.headers);
  // Contenu différent du fichier servi par ASSETS : son ETag ne vaut plus.
  headers.delete("etag");
  headers.append("vary", "accept-language");
  return new Response(rewritten.body, { status, headers });
}

export async function servePageWithMeta(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const html = await env.ASSETS.fetch(request);
  const url = new URL(request.url);
  const match = url.pathname.match(PAGE_META_ROUTE);
  if (!match || !html.ok || !html.headers.get("content-type")?.includes("text/html")) {
    return html;
  }
  // Balises réservées aux robots (moteurs, aperçus de liens) : un visiteur
  // n’en a pas besoin (l’appli pose son titre elle-même) et ne doit pas
  // attendre TMDB avant de recevoir la page (pas de Cache API sur
  // workers.dev). Un robot qui parcourt les fiches en rafale reçoit la page
  // sans aperçu plutôt que de multiplier les appels TMDB.
  const crawler = detectKnownCrawler(request) ?? detectLinkPreviewBot(request);
  if (
    !crawler ||
    !checkRateLimitInMemory(`page-meta:bot:${crawler}`, { limit: 60, windowMs: 60_000 })
  ) {
    return html;
  }
  const lang = langFromRequest(request);
  const canonical = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  // Les previews ne doivent jamais être indexées.
  const noindex = !isProductionHostname(url.hostname);
  const [, mediaType, mediaId, profileHandle, listSlug] = match;
  try {
    let meta: PageMeta | null = null;
    let notFound = false;
    if (mediaType && mediaId) {
      const fields = await fetchMediaFields(
        url.origin,
        mediaType as "movie" | "tv",
        mediaId,
        lang,
        env,
        ctx
      );
      if (fields === "not-found") {
        notFound = true;
      } else if (fields) {
        meta = mediaMeta(mediaType as "movie" | "tv", fields, lang, canonical);
      } else {
        return html;
      }
    } else if (profileHandle) {
      meta = await profileMeta(env.DB, decodeURIComponent(profileHandle), lang);
      notFound = meta === null;
    } else if (listSlug) {
      meta = await listMeta(env.DB, decodeURIComponent(listSlug), lang);
      notFound = meta === null;
    }
    if (notFound || !meta) {
      // Vrai 404 (l'appli affiche sa page « introuvable ») et pas d'index.
      const fallback: PageMeta = {
        title: SITE_NAME,
        description: TEXTS[lang].defaultDescription,
        image: null,
        type: "website",
      };
      return rewrite(html, fallback, metaTags(fallback, canonical, url.origin, true), 404);
    }
    return rewrite(html, meta, metaTags(meta, canonical, url.origin, noindex), 200);
  } catch (err) {
    logError(`Balises de partage indisponibles pour ${url.pathname} :`, err);
    return html;
  }
}

// robots.txt : previews entièrement exclues ; en prod, pages privées ou
// sans intérêt pour un moteur exclues. /api/ reste autorisé : Google en a
// besoin pour afficher le contenu des pages qu'il indexe.
export function serveRobots(url: URL): Response {
  const body = isProductionHostname(url.hostname)
    ? [
        "User-agent: *",
        "Disallow: /profil",
        "Disallow: /connexion",
        "Disallow: /auth/",
        "Disallow: /recherche",
        "",
        `Sitemap: ${url.origin}/sitemap.xml`,
        "",
      ].join("\n")
    : "User-agent: *\nDisallow: /\n";
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

// Pages fixes. Le catalogue complet (des centaines de milliers de titres
// TMDB) reste découvert par les liens internes plutôt que listé ici : seuls
// les titres populaires, déjà indexés localement pour la recherche (voir
// popular_titles dans search-index.ts), sont ajoutés ci-dessous.
const SITEMAP_PATHS = [
  "/",
  "/nouveautes",
  "/prochainement",
  "/aleatoire",
  "/conditions-utilisation",
  "/confidentialite",
];

export async function serveSitemap(url: URL, env: Env): Promise<Response> {
  const entries = SITEMAP_PATHS.map((path) => `  <url><loc>${url.origin}${path}</loc></url>`);
  try {
    const { results } = await env.DB.prepare(
      "SELECT tmdb_id, media_type FROM popular_titles ORDER BY popularity DESC"
    ).all<{ tmdb_id: number; media_type: string }>();
    for (const { tmdb_id, media_type } of results) {
      entries.push(`  <url><loc>${url.origin}/media/${media_type}/${tmdb_id}</loc></url>`);
    }
  } catch (err) {
    logError("Titres populaires indisponibles pour le sitemap :", err);
  }
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</urlset>",
    "",
  ].join("\n");
  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
