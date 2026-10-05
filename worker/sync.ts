// Synchronisation temps réel multi-appareils (ticket Trello "Synchronisation
// et actualisation automatique") : chaque appareil connecté à un compte ouvre
// une WebSocket vers GET /api/sync/socket, reliée à UNE instance de
// UserSyncHub par compte (Durable Object). Toute écriture authentifiée
// (bibliothèque, listes perso, réglages...) publie ensuite un événement
// ciblé sur le hub du compte, qui le rediffuse à tous ses appareils
// connectés — le client applique le delta reçu, ou ne recharge QUE la
// ressource concernée (voir src/core/sync/liveSync.ts), jamais un
// rechargement complet.
//
// WebSocket en mode "hibernation" (ctx.acceptWebSocket) plutôt que SSE : une
// connexion SSE garde le Durable Object en mémoire tant qu'elle est ouverte,
// facturé à la durée (13 000 GB-s/jour sur le plan gratuit, soit à peine
// ~1 appareil connecté en continu). Un hub en hibernation n'est réveillé que
// pour diffuser un événement ; le ping applicatif du client ("ping" →
// "pong") est lui aussi servi sans réveil, via setWebSocketAutoResponse.
//
// Ce flux est volontairement générique (`type` libre, voir SyncEvent) : il
// porte aussi les notifications in-app (type "notification", voir
// worker/notify.ts, notifyUser), qui passent par ce hub quand un appareil du
// compte a l'app au premier plan et retombent sur le Web Push sinon.
import { DurableObject, env, exports as workerExports, waitUntil } from "cloudflare:workers";
import { logError } from "./logger.ts";
import type { Env } from "./types.ts";

// En-tête posé par le client sur ses propres écritures (voir
// src/core/sync/liveSync.ts, syncClientHeaders) : l'appareil à l'origine
// d'un changement ne reçoit pas son propre événement en écho.
// L'ancien nom (avant Seancy) reste accepté pour les onglets qui tournent
// encore sur un bundle d'avant le renommage.
export const SYNC_CLIENT_HEADER = "x-seancy-client";
const LEGACY_SYNC_CLIENT_HEADER = "x-bobine-client";

function syncClientIdOf(request: Request): string | null {
  const header =
    request.headers.get(SYNC_CLIENT_HEADER) ?? request.headers.get(LEGACY_SYNC_CLIENT_HEADER);
  return header && CLIENT_ID_PATTERN.test(header) ? header : null;
}

// Ressources synchronisées — chaque valeur correspond à un consommateur côté
// client (voir useLiveSyncEvent).
export type SyncResource =
  | "library"
  | "custom-lists"
  | "excluded-genres"
  | "favorite-providers"
  | "favorite-languages"
  | "favorite-countries"
  | "locale"
  | "region"
  | "display-name"
  // Notification in-app (sorties...) — voir worker/notify.ts.
  | "notification";

export interface SyncEvent {
  type: SyncResource;
  // Delta optionnel appliqué tel quel par le client quand il est fourni
  // (bibliothèque : upserts/deletes) ; sinon le client recharge uniquement
  // la ressource `type`.
  payload?: unknown;
}

const CLIENT_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

// Messages envoyés par le client à chaque changement de visibilité (voir
// src/core/sync/liveSync.ts). Une PWA mise en arrière-plan ou un téléphone
// verrouillé garde souvent sa WebSocket ouverte côté serveur alors que la
// page est gelée : sans cet état, une notification lui serait "livrée"
// in-app sans jamais s'afficher, et le Web Push ne partirait pas.
export const FOREGROUND_MESSAGE = "foreground";
export const BACKGROUND_MESSAGE = "background";

interface SocketAttachment {
  foreground: boolean;
}

function isForeground(ws: WebSocket): boolean {
  const attachment = ws.deserializeAttachment() as SocketAttachment | null;
  // Socket sans état connu (client antérieur à ce mécanisme) : considérée
  // au premier plan, comme avant.
  return attachment?.foreground !== false;
}
// Code de fermeture envoyé quand les sessions du compte sont révoquées
// (déconnexion, « tous les appareils », changement d'email) : le client
// vérifie alors sa session au lieu de se reconnecter (voir liveSync.ts).
export const SESSION_REVOKED_CLOSE_CODE = 4001;

// Bornes défensives : un compte n'a normalement qu'une poignée d'appareils.
const MAX_SOCKETS_PER_USER = 20;

export class UserSyncHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const clientId = new URL(request.url).searchParams.get("client") ?? "";
    const sockets = this.ctx.getWebSockets();
    // Au-delà de la borne, on ferme les connexions les plus anciennes (onglets
    // oubliés, appareils perdus) plutôt que de refuser la nouvelle.
    for (const stale of sockets.slice(0, Math.max(0, sockets.length - MAX_SOCKETS_PER_USER + 1))) {
      stale.close(4000, "too many connections");
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, CLIENT_ID_PATTERN.test(clientId) ? [clientId] : []);
    server.serializeAttachment({
      foreground: new URL(request.url).searchParams.get("visible") !== "0",
    } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Appelé en RPC par publishToUser / deliverToUser : diffuse à tous les
  // appareils du compte sauf celui à l'origine du changement, et renvoie le
  // nombre d'appareils effectivement atteints. `foregroundOnly` (notifications)
  // ignore les appareils dont l'app est en arrière-plan : 0 = aucun appareil
  // avec l'app ouverte, ce qui fait retomber notifyUser sur le Web Push.
  async publish(
    event: SyncEvent,
    sourceClientId: string | null,
    foregroundOnly = false
  ): Promise<number> {
    const message = JSON.stringify(event);
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (sourceClientId && this.ctx.getTags(ws).includes(sourceClientId)) {
        continue;
      }
      if (foregroundOnly && !isForeground(ws)) {
        continue;
      }
      try {
        ws.send(message);
        delivered += 1;
      } catch {
        // Socket déjà fermée côté client : le runtime la retire de lui-même.
      }
    }
    return delivered;
  }

  // Appelé en RPC par revokeUserSockets : ferme les WebSockets du compte,
  // seulement celle de `clientId` si fourni, sinon toutes sauf
  // `exceptClientId`.
  async revoke(clientId: string | null, exceptClientId: string | null): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (
        (clientId && !tags.includes(clientId)) ||
        (exceptClientId && tags.includes(exceptClientId))
      ) {
        continue;
      }
      try {
        ws.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
      } catch {
        // Déjà fermée.
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Les "ping" sont servis par l'auto-réponse (voir constructeur) sans
    // réveiller le hub ; seuls les changements de visibilité arrivent ici.
    if (message === FOREGROUND_MESSAGE || message === BACKGROUND_MESSAGE) {
      ws.serializeAttachment({
        foreground: message === FOREGROUND_MESSAGE,
      } satisfies SocketAttachment);
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // 1005/1006 (fermeture sans code / anormale) ne sont pas des codes
    // qu'on a le droit de renvoyer : on répond par une fermeture normale.
    ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
  }
}

// Un hub par compte ET par hôte : défense en profondeur pour qu'un compte
// d'un environnement ne reçoive jamais les événements du compte de même id
// d'un autre environnement (chaque preview PR a sa propre base D1, donc ses
// propres ids utilisateurs).
//
// Namespace : en prod, la classe est déclarée via "exports" (wrangler.jsonc)
// et atteinte par `exports`. Les previews PR (Cloudflare Previews, `wrangler
// preview`) ne publient pas "exports" : scripts/preview-d1.ts y déclare la
// classe via "migrations" et la lie sous "previews.durable_objects"
// (USER_SYNC_HUB), ce qui donne à chaque preview ses propres instances,
// isolées de la prod et des autres previews.
function hubFor(hostname: string, userId: number) {
  const namespace = (env as Env).USER_SYNC_HUB ?? workerExports.UserSyncHub;
  return namespace.get(namespace.idFromName(`${hostname}:${userId}`));
}

// Ouverture de la WebSocket de synchro (GET /api/sync/socket). Renvoie la
// réponse 101 du hub telle quelle : elle ne doit surtout pas repasser par
// withSecurityHeaders (voir worker/index.ts), qui la reconstruirait via
// `new Response(...)` et perdrait la WebSocket.
export async function openSyncSocket(request: Request, userId: number): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket attendue.", { status: 426 });
  }
  // Garde anti-CSWSH : le cookie de session est déjà SameSite=Lax, mais on
  // refuse aussi explicitement toute poignée de main venant d'une autre
  // origine que l'app elle-même.
  const url = new URL(request.url);
  // `URL.parse` plutôt que `new URL` : une origine illisible (ex. « null »,
  // envoyée par un document sandboxé) est refusée au lieu de lever.
  const origin = request.headers.get("origin");
  if (origin && URL.parse(origin)?.host !== url.host) {
    return new Response("Origine refusée.", { status: 403 });
  }
  try {
    return await hubFor(url.hostname, userId).fetch(request);
  } catch (err) {
    // Hub indisponible (ex. classe pas encore provisionnée sur ce
    // déploiement) : le client retombera sur son repli (rechargement au
    // retour au premier plan) sans rien casser.
    logError("Synchro temps réel : ouverture de la WebSocket impossible.", err);
    return new Response("Synchro temps réel indisponible.", { status: 503 });
  }
}

// Diffuse un événement aux autres appareils du compte, sans retarder la
// réponse HTTP de l'écriture (waitUntil) ni jamais la faire échouer : la
// synchro temps réel est un plus, la donnée est déjà écrite en base.
export function publishToUser(request: Request, userId: number, event: SyncEvent): void {
  const sourceClientId = syncClientIdOf(request);
  const hostname = new URL(request.url).hostname;
  waitUntil(
    (async () => {
      try {
        await hubFor(hostname, userId).publish(event, sourceClientId);
      } catch (err) {
        logError(`Synchro temps réel : diffusion "${event.type}" impossible.`, err);
      }
    })()
  );
}

// Livraison d'une notification (cron, voir worker/notify.ts) : l'hôte vient
// de l'abonnement rattaché au compte (subscriptions.sync_host), et l'appelant
// attend le résultat pour savoir s'il doit retomber sur le Web Push. Seuls
// les appareils avec l'app au premier plan comptent. Ne lève jamais : un hub
// indisponible compte comme "aucun appareil connecté".
export async function deliverToUser(
  hostname: string,
  userId: number,
  event: SyncEvent
): Promise<number> {
  try {
    return await hubFor(hostname, userId).publish(event, null, true);
  } catch (err) {
    logError(`Synchro temps réel : livraison "${event.type}" impossible.`, err);
    return 0;
  }
}

// Sessions révoquées (audit M1) : sans ça, une WebSocket déjà ouverte
// continuait de recevoir les événements du compte après la déconnexion.
// `scope` : l'appareil à l'origine de la requête seul ("self"), ou tous les
// autres ("others"), ou tous ("all"). Ne lève jamais.
export async function revokeUserSockets(
  request: Request,
  userId: number,
  scope: "self" | "others" | "all"
): Promise<void> {
  const clientId = syncClientIdOf(request);
  if (scope === "self" && !clientId) {
    return;
  }
  try {
    await hubFor(new URL(request.url).hostname, userId).revoke(
      scope === "self" ? clientId : null,
      scope === "others" ? clientId : null
    );
  } catch (err) {
    logError("Synchro temps réel : fermeture des WebSockets impossible.", err);
  }
}
