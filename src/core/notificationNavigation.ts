// Clic sur une notification alors que l'app est déjà ouverte : le service worker (src/sw.ts,
// notificationclick) la ramène au premier plan et lui envoie la page à ouvrir (ex. la fiche d'un
// ticket, /tickets/<id>). Navigation dans l'app, sans rechargement : même entrée d'historique
// que React Router (BrowserRouter), qui suit l'événement popstate.

export const OPEN_URL_MESSAGE = "open-url";

/** Chemin à ouvrir pour un message du service worker ; null si ce n'en est pas un ou s'il vient d'ailleurs. */
export function pathToOpen(data: unknown, current: string): string | null {
  const d = data as { type?: unknown; url?: unknown } | null;
  if (!d || d.type !== OPEN_URL_MESSAGE || typeof d.url !== "string") {
    return null;
  }
  let url: URL;
  let here: URL;
  try {
    here = new URL(current);
    url = new URL(d.url, here);
  } catch {
    return null;
  }
  if (url.origin !== here.origin) {
    return null;
  }
  const path = `${url.pathname}${url.search}${url.hash}`;
  return path === `${here.pathname}${here.search}${here.hash}` ? null : path;
}

export function setupNotificationNavigation(): void {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const path = pathToOpen(event.data, window.location.href);
    if (!path) {
      return;
    }
    // État d'une entrée React Router (usr, key, idx) : retour arrière normal ensuite
    const prev = window.history.state as { idx?: number } | null;
    const state = {
      usr: null,
      key: Math.random().toString(36).slice(2, 10),
      idx: (typeof prev?.idx === "number" ? prev.idx : 0) + 1,
    };
    window.history.pushState(state, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
}
