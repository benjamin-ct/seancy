// Client des routes /api/tickets/* (worker/tickets.ts) pour la page Tickets.
// Même origine que l'app : le cookie de session part automatiquement ; le
// serveur vérifie que le compte fait partie des administrateurs.

export type TicketStatus = "idea" | "todo" | "work" | "review" | "done";
export type Model = "opus" | "sonnet";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface HistoryEvent {
  at: number;
  who: "moi" | "claude" | "auto";
  kind: string;
  text?: string;
  pr?: string;
  by?: string;
}
export interface TicketFile {
  id: string;
  name: string;
  type: string;
  size: number;
}
export interface Ticket {
  id: string;
  status: TicketStatus;
  position: number;
  title: string;
  detail: string;
  labels: string[];
  links: { url: string; title: string }[];
  model: Model;
  effort: Effort;
  urgent: boolean;
  sent: number;
  answer: string;
  pr: string;
  feedback: string;
  followUp: string;
  notes: string;
  progress: string;
  progressAt: number;
  stage: "" | "start" | "work" | "fail" | "quota" | "retry";
  run: string;
  issue: string;
  retries: number;
  autofix: number;
  queued: number;
  preview: string;
  doneAt: number;
  history: HistoryEvent[];
  trello: {
    url: string;
    list: string;
    comments: { at: number; author: string; text: string }[];
  } | null;
  files: TicketFile[];
  /** Qui a créé le ticket (nom affiché) ; « Claude » pour un ticket créé par une session Claude. */
  author: string;
  authorEmail: string;
  createdAt: number;
}
/** Étiquette partagée : nom et couleur Trello (« green », « red_dark »… ; vide = sans couleur). */
export interface LabelDef {
  name: string;
  color: string;
}
export interface TicketsConfig {
  github: boolean;
  discord: boolean;
  key: boolean;
  repo: string;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/tickets${path}`, init);
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    throw new ApiError(body?.error || `Erreur ${res.status}`, res.status);
  }
  return body as T;
}
const post = <T>(path: string, data: unknown, method = "POST") =>
  request<T>(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });

/** Release develop → main (tableau de bord) : voir worker/tickets.ts (ReleaseState). */
export interface ReleaseState {
  version: string;
  next: string;
  notes: { bump: "patch" | "minor" | "major"; summary: string }[];
  pending: string[];
  since: number;
  pr: { number: number; url: string; state: "wait" | "fail" | "merged"; why: string } | null;
}
export const releaseState = () => request<{ release: ReleaseState }>("/release");
export const startRelease = () => post<{ release: ReleaseState }>("/release", { action: "start" });
/** PR de Dependabot vers develop (worker/release.ts) : état de leur CI, fusion d'une PR prête. */
export interface DepPr {
  number: number;
  title: string;
  url: string;
  state: "ok" | "wait" | "fail";
}
export const listDeps = () => request<{ deps: DepPr[] }>("/deps");
export const mergeDep = (number: number) =>
  post<{ message: string; deps: DepPr[] }>("/deps", { number });
export const listTickets = () =>
  request<{
    tickets: Ticket[];
    labels?: LabelDef[];
    config: TicketsConfig;
    /** CI des PR à valider (passage régulier du serveur). */
    ci?: Record<string, "ok" | "wait" | "fail">;
  }>("");
/** Étiquette ajoutée ou changée (`from` : ancien nom si renommée), ou retirée (`remove`) de tous les tickets. */
export const saveLabel = (change: {
  name?: string;
  color?: string;
  from?: string;
  remove?: boolean;
}) => post<{ labels: LabelDef[] }>("/labels", change);
export const createTicket = (data: Partial<Ticket> & { send?: boolean; before?: string }) =>
  post<{ ticket: Ticket }>("", data);
export const editTicket = (id: string, fields: Partial<Ticket>) =>
  post<{ ticket: Ticket }>(`/${id}`, fields, "PATCH");
export const deleteTicket = (id: string) => request<{ ok: true }>(`/${id}`, { method: "DELETE" });
export const moveTicket = (id: string, to: TicketStatus | undefined, before: string) =>
  post<{ ticket: Ticket }>(`/${id}/move`, { to, before });
export type TicketAction = "send" | "unsend" | "validate" | "unqueue" | "retouch" | "reopen";
export const ticketAction = (id: string, action: TicketAction, text = "") =>
  post<{ ok: true; queued?: boolean; merged?: number; position?: number; why?: string }>(
    `/${id}/action`,
    { action, text }
  );
export const newKey = () => post<{ key: string }>("/key", {});
/** Notifications push des tickets pour un abonnement de cet appareil : état, activation, arrêt. */
export const ticketPush = (action: "state" | "on" | "off", sub: PushSubscriptionJSON) =>
  post<{ on: boolean }>("/push", { action, endpoint: sub.endpoint, keys: sub.keys });
export const deleteFile = (id: string, fileId: string) =>
  request<{ ok: true }>(`/${id}/files/${fileId}`, { method: "DELETE" });
export const fileUrl = (f: TicketFile) => `/api/tickets/files/${f.id}`;

const MAX_BYTES = 1_500_000;
// Au-delà, une image est réduite avant l'envoi : le Worker n'a que 10 ms de
// calcul par requête (forfait gratuit) et enregistrer une grosse image dans
// D1 les dépasse (HTTP 503)
const SHRINK_ABOVE = 250_000;

/** Image de plus de 250 Ko : redimensionnée (1400 px au plus de côté) et recompressée en JPEG ; la plus petite version gardée. */
async function shrink(file: File): Promise<Blob> {
  if (file.size <= SHRINK_ABOVE || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
    return file;
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let best: Blob = file;
  for (const q of [0.8, 0.65, 0.5]) {
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", q));
    if (blob && blob.size < best.size) {
      best = blob;
    }
    if (best.size <= SHRINK_ABOVE) {
      break;
    }
  }
  return best;
}

export async function uploadFile(id: string, file: File): Promise<TicketFile> {
  const blob = await shrink(file);
  const name = blob === file ? file.name : file.name.replace(/\.\w+$/, "") + ".jpg";
  if (blob.size > MAX_BYTES) {
    throw new ApiError(`${file.name} : trop gros (1,5 Mo au plus)`, 413);
  }
  const res = await request<{ file: TicketFile }>(`/${id}/files?name=${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": blob.type || file.type },
    body: blob,
  });
  return res.file;
}
