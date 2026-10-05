/// <reference lib="webworker" />
// Service worker custom (stratégie injectManifest de vite-plugin-pwa) :
// on garde le précaching Workbox généré automatiquement (pour le mode hors
// ligne / installation PWA), et on y ajoute la gestion des notifications
// push, impossible avec la stratégie generateSW par défaut.
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  type PrecacheEntry,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";
import type { WorkboxPlugin } from "workbox-core/types";
import { ExpirationPlugin } from "workbox-expiration";

declare const self: ServiceWorkerGlobalScope & {
  // Injecté au build par vite-plugin-pwa (stratégie injectManifest).
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

interface PushNotificationPayload {
  title?: string;
  body?: string;
  url?: string;
}

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
self.skipWaiting();
self.addEventListener("activate", () => self.clients.claim());

// Affiches TMDB : rarement modifiées, on privilégie le cache (audit H16).
// Une <img> sans crossorigin fait une requête « no-cors » : la réponse est
// opaque (statut 0, taille inconnue), et Chrome compte alors ~7 Mo de quota
// par entrée. image.tmdb.org autorise le CORS (Access-Control-Allow-Origin:
// *) : le service worker refait donc la requête en CORS, ce qui donne une
// vraie réponse 200 à mettre en cache, sans toucher aux <img>. Si le CORS
// venait à échouer, repli sur la requête d'origine (non mise en cache).
// L'en-tête Accept de l'<img> est recopié : image.tmdb.org choisit le format
// d'après lui, et la nouvelle requête (Accept: */* par défaut) recevait du
// JPEG au lieu du WebP, environ 30 % plus lourd.
const corsImages: WorkboxPlugin = {
  requestWillFetch: async ({ request }) =>
    new Request(request.url, {
      mode: "cors",
      credentials: "omit",
      headers: { Accept: request.headers.get("Accept") ?? "image/webp,image/*" },
    }),
  cacheWillUpdate: async ({ response }) => (response.status === 200 ? response : null),
  handlerDidError: async ({ request }) => fetch(request),
};

registerRoute(
  ({ url }) => url.origin === "https://image.tmdb.org",
  new CacheFirst({
    cacheName: "tmdb-images",
    plugins: [
      corsImages,
      new ExpirationPlugin({
        maxEntries: 300,
        maxAgeSeconds: 60 * 60 * 24 * 30,
        purgeOnQuotaError: true,
      }),
    ],
  })
);

// Catalogue TMDB : en prod via le proxy /api/tmdb du Worker (l'ancienne
// route ne visait que api.themoviedb.org, appelé seulement en dev). Réponse
// en cache servie tout de suite et rafraîchie en arrière-plan : les grilles
// et fiches déjà vues s'affichent sans attendre, y compris hors ligne.
// Seules les réponses 200 sont gardées (pas les 429 du proxy).
registerRoute(
  ({ url }) =>
    (url.origin === self.location.origin && url.pathname.startsWith("/api/tmdb/")) ||
    url.origin === "https://api.themoviedb.org",
  new StaleWhileRevalidate({
    cacheName: "tmdb-api",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: 60 * 60 * 24,
        purgeOnQuotaError: true,
      }),
    ],
  })
);

// Navigation : index.html précaché pour toute URL de l'appli (appli
// monopage), pour qu'un lien profond (fiche, liste…) s'ouvre aussi hors
// ligne. Les routes servies par le Worker restent sur le réseau.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//, /^\/cdn-cgi\//, /^\/robots\.txt$/, /^\/sitemap\.xml$/],
  })
);

self.addEventListener("push", (event: PushEvent) => {
  let data: PushNotificationPayload = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Seancy", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Seancy";
  const options: NotificationOptions = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const targetUrl: string = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
