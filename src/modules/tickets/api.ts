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

export const listTickets = () => request<{ tickets: Ticket[]; config: TicketsConfig }>("");
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
export const deleteFile = (id: string, fileId: string) =>
  request<{ ok: true }>(`/${id}/files/${fileId}`, { method: "DELETE" });
export const fileUrl = (f: TicketFile) => `/api/tickets/files/${f.id}`;

const MAX_BYTES = 1_500_000;

/** Image trop grosse : redimensionnée et recompressée en JPEG (2000 px au plus de côté). */
async function shrink(file: File): Promise<Blob> {
  if (file.size <= MAX_BYTES || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
    return file;
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const q of [0.85, 0.7, 0.55]) {
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", q));
    if (blob && blob.size <= MAX_BYTES) {
      return blob;
    }
  }
  return file;
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
