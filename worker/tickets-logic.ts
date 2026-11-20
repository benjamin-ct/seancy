// Tickets de développement envoyés à Claude (page /tickets) : logique pure,
// sans D1 ni Cloudflare, partagée par le Worker (worker/tickets.ts) et les
// vérifications (scripts/verify-tickets.ts). Reprise du système de tickets de
// Paddock Live, adaptée à Seancy (develop / main, hotfix, Discord).
//
// Colonnes (status) : idea (Idées), todo (À faire), work (En cours, chez
// Claude), review (À valider), done (Faits). Le passage d'une colonne à
// l'autre est toujours une action (applyAction) : envoi à Claude, compte
// rendu, retouche, validation… qui note aussi l'historique du ticket.

export const STATUSES = ["idea", "todo", "work", "review", "done"] as const;
export type TicketStatus = (typeof STATUSES)[number];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const STAGES = ["start", "work", "fail", "quota", "retry"] as const;
export type Stage = (typeof STAGES)[number] | "";
export type Model = "opus" | "sonnet";

export interface TicketLink {
  url: string;
  title: string;
}
export interface HistoryEvent {
  at: number;
  who: "moi" | "claude" | "auto";
  kind: string;
  text?: string;
  pr?: string;
  /** Qui a fait l'action (nom du compte administrateur) ; vide pour Claude et la validation automatique. */
  by?: string;
}
export interface TrelloComment {
  at: number;
  author: string;
  text: string;
}
/** Carte Trello d'origine (import, scripts/trello-import.ts) : gardée telle quelle pour que Claude relise tout. */
export interface TrelloOrigin {
  url: string;
  list: string;
  comments: TrelloComment[];
}
/** Administrateur qui s'est ajouté à un ticket qu'il n'a pas créé (filtre par personne, initiales sur la carte). */
export interface TicketMember {
  email: string;
  name: string;
}
export interface TicketFile {
  id: string;
  name: string;
  type: string;
  size: number;
  /** Date d'ajout (ms) : place la pièce jointe dans le fil de la conversation. */
  at?: number;
}
export interface TicketData {
  title: string;
  detail: string;
  labels: string[];
  links: TicketLink[];
  model: Model;
  effort: Effort;
  /** Hotfix : branche depuis main, PR vers main, puis main refusionné dans develop. */
  urgent: boolean;
  /** Modèle et effort choisis automatiquement d'après le ticket (worker/ticket-level.ts) à chaque passage. */
  auto: boolean;
  /** Dernier choix automatique et sa raison, montrés dans le ticket (« Sonnet · moyen : … »). */
  autoWhy: string;
  /** Date d'envoi à Claude (ms) ; 0 : pas chez Claude. */
  sent: number;
  /** Envoi annulé (ms) : un lancement de Claude déjà parti ne peut plus répondre ; 0 : rien d'annulé. */
  cancelled: number;
  answer: string;
  pr: string;
  feedback: string;
  followUp: string;
  notes: string;
  progress: string;
  progressAt: number;
  stage: Stage;
  run: string;
  issue: string;
  retries: number;
  autofix: number;
  /** Validé, en attente de fusion (ms) ; 0 : pas en file. */
  queued: number;
  preview: string;
  doneAt: number;
  history: HistoryEvent[];
  trello: TrelloOrigin | null;
  /** Qui a créé le ticket (nom affiché) et son adresse, pour le filtre « Les miens » ; « Claude » s'il vient d'une
   * session Claude (sentry-triage…), le créateur de la carte pour un ticket importé de Trello. Jamais modifiable. */
  author: string;
  authorEmail: string;
  /** Autres administrateurs ajoutés au ticket (« Me rajouter » dans la fiche). */
  members: TicketMember[];
}
export interface Ticket extends TicketData {
  id: string;
  createdAt: number;
  status: TicketStatus;
  position: number;
  files: TicketFile[];
}

export class TicketError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const HISTORY_MAX = 60;
const TRELLO_COMMENTS_MAX = 300;
const str = (v: unknown, max: number): string => (v == null ? "" : String(v)).slice(0, max);
const int = (v: unknown, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.floor(Number(v)) || 0));
const isUrl = (u: string) => /^https?:\/\/\S+$/.test(u);

export const EMPTY_DATA: TicketData = {
  title: "",
  detail: "",
  labels: [],
  links: [],
  model: "opus",
  effort: "high",
  urgent: false,
  auto: false,
  autoWhy: "",
  sent: 0,
  cancelled: 0,
  answer: "",
  pr: "",
  feedback: "",
  followUp: "",
  notes: "",
  progress: "",
  progressAt: 0,
  stage: "",
  run: "",
  issue: "",
  retries: 0,
  autofix: 0,
  queued: 0,
  preview: "",
  doneAt: 0,
  history: [],
  trello: null,
  author: "",
  authorEmail: "",
  members: [],
};

const LONG = new Set(["answer", "feedback", "followUp", "notes"]);
const SHORT = ["title", "progress", "pr", "run", "preview"] as const;

/** Données d'un ticket nettoyées : seuls les champs connus, bornés en taille. */
export function cleanData(
  input: Record<string, unknown>,
  old: TicketData = EMPTY_DATA
): TicketData {
  const out: TicketData = { ...old };
  const has = (k: string) => input[k] !== undefined;
  if (has("detail")) {
    out.detail = str(input.detail, 40000);
  }
  for (const k of SHORT) {
    if (has(k)) {
      out[k] = str(input[k], k === "title" ? 200 : 500).trim();
    }
  }
  for (const k of LONG) {
    if (has(k)) {
      (out as unknown as Record<string, string>)[k] = str(input[k], 8000);
    }
  }
  if (has("pr") && out.pr && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(out.pr)) {
    out.pr = "";
  }
  for (const k of ["run", "preview"] as const) {
    if (has(k) && out[k] && !/^https:\/\//.test(out[k])) {
      out[k] = "";
    }
  }
  if (has("author")) {
    out.author = str(input.author, 80).trim();
  }
  if (has("authorEmail")) {
    out.authorEmail = str(input.authorEmail, 200).trim().toLowerCase();
  }
  if (has("members")) {
    const seen = new Set<string>();
    out.members = (Array.isArray(input.members) ? input.members : [])
      .map((m) => {
        const o = (m ?? {}) as Record<string, unknown>;
        return { email: str(o.email, 200).trim().toLowerCase(), name: str(o.name, 80).trim() };
      })
      .filter((m) => m.email.includes("@") && !seen.has(m.email) && !!seen.add(m.email))
      .slice(0, 20);
  }
  if (has("issue")) {
    out.issue = /^\d{1,9}$/.test(String(input.issue)) ? String(input.issue) : "";
  }
  if (has("model")) {
    out.model = input.model === "sonnet" ? "sonnet" : "opus";
  }
  if (has("effort")) {
    out.effort = (EFFORTS as readonly string[]).includes(String(input.effort))
      ? (input.effort as Effort)
      : "high";
  }
  if (has("stage")) {
    out.stage = (STAGES as readonly string[]).includes(String(input.stage))
      ? (input.stage as Stage)
      : "";
  }
  if (has("auto")) {
    out.auto = input.auto === true || input.auto === 1 || input.auto === "1";
  }
  if (has("autoWhy")) {
    out.autoWhy = str(input.autoWhy, 300).trim();
  }
  if (has("urgent")) {
    out.urgent = input.urgent === true || input.urgent === 1 || input.urgent === "1";
  }
  for (const k of ["sent", "cancelled", "progressAt", "queued", "doneAt"] as const) {
    if (has(k)) {
      out[k] = int(input[k], 0, 8.64e15);
    }
  }
  if (has("retries")) {
    out.retries = int(input.retries, 0, 99);
  }
  if (has("autofix")) {
    out.autofix = int(input.autofix, 0, 9);
  }
  if (has("labels")) {
    out.labels = (Array.isArray(input.labels) ? input.labels : [])
      .map((l) => str(l, 50).trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  if (has("links")) {
    out.links = (Array.isArray(input.links) ? input.links : [])
      .map((l) => {
        const o = (l ?? {}) as Record<string, unknown>;
        return { url: str(o.url, 1000).trim(), title: str(o.title, 200).trim() };
      })
      .filter((l) => isUrl(l.url))
      .slice(0, 40);
  }
  if (has("history")) {
    out.history = cleanHistory(input.history);
  }
  if (has("trello")) {
    const o = input.trello as Record<string, unknown> | null;
    out.trello =
      o && typeof o === "object"
        ? {
            url: isUrl(str(o.url, 500)) ? str(o.url, 500) : "",
            list: str(o.list, 100),
            comments: (Array.isArray(o.comments) ? o.comments : [])
              .slice(-TRELLO_COMMENTS_MAX)
              .map((c) => {
                const x = (c ?? {}) as Record<string, unknown>;
                return {
                  at: int(x.at, 0, 8.64e15),
                  author: str(x.author, 100),
                  text: str(x.text, 6000),
                };
              })
              .filter((c) => c.text),
          }
        : null;
  }
  return out;
}

const WHO = ["moi", "claude", "auto"];
function cleanHistory(h: unknown): HistoryEvent[] {
  return (Array.isArray(h) ? h : [])
    .slice(-HISTORY_MAX)
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>;
      const ev: HistoryEvent = {
        at: int(o.at, 0, 8.64e15),
        who: (WHO.includes(String(o.who)) ? o.who : "moi") as HistoryEvent["who"],
        kind: str(o.kind, 20),
      };
      if (o.text) {
        ev.text = str(o.text, 3000);
      }
      if (o.pr) {
        ev.pr = str(o.pr, 400);
      }
      if (o.by) {
        ev.by = str(o.by, 80);
      }
      return ev;
    })
    .filter((e) => e.kind);
}

/** Données lues en base (JSON) : nettoyées, un ticket abîmé ne casse pas la page. */
export function parseData(raw: string | null | undefined): TicketData {
  try {
    const v = JSON.parse(raw || "{}") as Record<string, unknown>;
    return cleanData(v && typeof v === "object" ? v : {});
  } catch {
    return { ...EMPTY_DATA };
  }
}

export const prNumber = (url: string): string => /\/pull\/(\d+)/.exec(url || "")?.[1] ?? "";

// ---------- Actions ----------

export type Action =
  | { type: "edit"; fields: Record<string, unknown> }
  | { type: "move"; to: TicketStatus }
  | { type: "send" }
  | { type: "unsend" }
  | { type: "answer"; text: string; pr?: string; notes?: string }
  | { type: "progress"; stage: Stage; text: string; run?: string; issue?: string }
  | { type: "retouch"; text: string }
  | { type: "reopen"; text: string }
  | { type: "queue"; followUp?: string }
  | { type: "unqueue" }
  | { type: "done" }
  | { type: "followup" }
  | { type: "autofix"; text: string }
  | { type: "retry"; n: number }
  | { type: "preview"; url: string }
  /** Modèle et effort choisis automatiquement (sans événement d'historique) */
  | { type: "level"; model: Model; effort: Effort; why: string }
  /** Administrateur ajouté au ticket ou retiré (sans événement d'historique) */
  | { type: "member"; email: string; name: string; join: boolean };

/** Champs qu'une modification directe (fiche, glisser-déposer) peut changer. */
const EDITABLE = ["title", "detail", "labels", "links", "model", "effort", "urgent", "auto"];

/**
 * Nouvelle colonne et nouvelles données d'un ticket après une action, avec
 * l'événement d'historique correspondant. Lève TicketError si l'action n'est
 * pas permise depuis la colonne actuelle.
 */
export function applyAction(
  t: { status: TicketStatus; data: TicketData },
  a: Action,
  now: number,
  by = ""
): { status: TicketStatus; data: TicketData } {
  const d = t.data;
  const from = t.status;
  const ev: HistoryEvent[] = [];
  let status = from;
  let patch: Record<string, unknown> = {};
  const need = (ok: boolean, msg: string) => {
    if (!ok) {
      throw new TicketError(msg, 409);
    }
  };
  // Lancement de Claude parti avant « Annuler l'envoi » : ni étape ni compte rendu
  if (a.type === "answer" || a.type === "progress") {
    need(
      from === "work" || !d.cancelled,
      "Envoi annulé : ce ticket n'est plus chez Claude (renvoie-le pour qu'il le traite)"
    );
  }
  switch (a.type) {
    case "edit": {
      patch = Object.fromEntries(Object.entries(a.fields).filter(([k]) => EDITABLE.includes(k)));
      if ("title" in patch && !String(patch.title ?? "").trim()) {
        throw new TicketError("Titre manquant");
      }
      break;
    }
    case "move":
      need(
        (from === "idea" || from === "todo") && (a.to === "idea" || a.to === "todo"),
        "Seules les idées et les tickets à faire se rangent ainsi"
      );
      status = a.to;
      break;
    case "send": {
      const relaunch = from === "work" && (d.stage === "fail" || d.stage === "quota");
      need(from === "idea" || from === "todo" || relaunch, "Ticket déjà chez Claude ou à valider");
      status = "work";
      patch = { sent: now, stage: "", progress: "", progressAt: 0, retries: 0 };
      ev.push({ at: now, who: "moi", kind: d.sent || d.answer || relaunch ? "relance" : "envoi" });
      break;
    }
    case "unsend":
      need(from === "work", "Ce ticket n'est pas chez Claude");
      status = "todo";
      patch = { sent: 0, cancelled: now, stage: "", progress: "", queued: 0 };
      ev.push({ at: now, who: "moi", kind: "annule" });
      break;
    case "answer":
      need(from !== "done", "Ticket déjà fait");
      need(!!a.text.trim(), "Compte rendu vide");
      status = "review";
      patch = {
        answer: a.text,
        sent: 0,
        feedback: "",
        stage: "",
        progress: "",
        ...(a.pr ? { pr: a.pr } : {}),
        ...(a.notes ? { notes: a.notes } : {}),
      };
      break;
    case "progress":
      patch = {
        stage: a.stage,
        progress: a.text,
        progressAt: now,
        ...(a.run ? { run: a.run } : {}),
        ...(a.issue ? { issue: a.issue } : {}),
      };
      if (a.stage === "fail" && d.stage !== "fail") {
        ev.push({ at: now, who: "claude", kind: "arret", text: a.text });
      }
      break;
    case "retouch":
      need(from === "review" || from === "work", "Une retouche se demande sur un ticket à valider");
      need(!!a.text.trim(), "Écris ce qu'il faut changer");
      status = "work";
      patch = {
        feedback: a.text,
        sent: now,
        queued: 0,
        autofix: 0,
        stage: "",
        progress: "",
        retries: 0,
      };
      ev.push({ at: now, who: "moi", kind: "message", text: a.text });
      break;
    case "reopen":
      need(from === "done", "Seul un ticket fait se rouvre (sinon : retouche)");
      need(!!a.text.trim(), "Écris sur quoi revenir");
      status = "work";
      patch = {
        feedback: a.text,
        sent: now,
        doneAt: 0,
        pr: "",
        preview: "",
        stage: "",
        progress: "",
        retries: 0,
        autofix: 0,
        notes: [
          d.notes,
          d.pr ? `Ticket rouvert : sa PR précédente (${d.pr}) est déjà fusionnée` : "",
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 8000),
      };
      ev.push({ at: now, who: "moi", kind: "message", text: a.text });
      break;
    case "queue":
      need(from === "review", "Seul un ticket à valider se valide");
      patch = {
        queued: d.queued || now,
        ...(d.queued ? {} : { autofix: 0 }),
        ...(a.followUp ? { followUp: a.followUp } : {}),
      };
      if (!d.queued) {
        ev.push({ at: now, who: "moi", kind: "file" });
      }
      break;
    case "unqueue":
      patch = { queued: 0, followUp: "" };
      break;
    case "done":
      status = "done";
      patch = {
        doneAt: now,
        sent: 0,
        feedback: "",
        followUp: "",
        queued: 0,
        stage: "",
        autofix: 0,
      };
      ev.push({ at: now, who: "moi", kind: "valide", pr: d.pr });
      break;
    case "followup":
      // Validé avec un commentaire : PR fusionnée, puis le commentaire repart chez Claude (nouvelle PR)
      need(!!d.followUp, "Pas de suite demandée");
      status = "work";
      patch = {
        feedback: d.followUp,
        followUp: "",
        sent: now,
        queued: 0,
        autofix: 0,
        pr: "",
        preview: "",
        stage: "",
        progress: "",
        retries: 0,
        notes: [
          d.notes,
          d.pr ? `PR ${d.pr} validée et fusionnée ; suite demandée dans RETOUCHE DEMANDÉE` : "",
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 8000),
      };
      ev.push({ at: now, who: "moi", kind: "valide", pr: d.pr });
      ev.push({ at: now, who: "moi", kind: "message", text: d.followUp });
      break;
    case "autofix":
      status = "work";
      patch = { feedback: a.text, sent: now, autofix: d.autofix + 1, stage: "", progress: "" };
      ev.push({ at: now, who: "auto", kind: "message", text: a.text });
      break;
    case "retry":
      patch = {
        stage: "retry",
        progress: `Relance automatique ${a.n}/${RETRY_MAX} envoyée`,
        progressAt: now,
        retries: a.n,
      };
      break;
    case "preview":
      patch = { preview: a.url };
      break;
    case "level":
      patch = { model: a.model, effort: a.effort, autoWhy: a.why };
      break;
    case "member": {
      const email = a.email.trim().toLowerCase();
      need(!!email, "Compte inconnu");
      need(email !== d.authorEmail, "Tu as créé ce ticket : il est déjà à ton nom");
      const others = d.members.filter((m) => m.email !== email);
      patch = { members: a.join ? [...others, { email, name: a.name }] : others };
      break;
    }
  }
  // Événements de l'utilisateur : signés du nom de l'administrateur qui a fait l'action
  for (const e of ev) {
    if (e.who === "moi" && by) {
      e.by = by;
    }
  }
  // De nouveau chez Claude (envoi, retouche, relance…) : l'annulation précédente ne compte plus
  if (status === "work") {
    patch.cancelled = 0;
  }
  const data = cleanData(patch, d);
  if (a.type === "answer" && data.answer) {
    ev.push({ at: now, who: "claude", kind: "reponse", text: data.answer, pr: data.pr });
  }
  if (ev.length) {
    data.history = cleanHistory([...d.history, ...ev]);
  }
  return { status, data };
}

// ---------- GitHub ----------

export const RETRY_EVERY = 60 * 60_000;
export const RETRY_MAX = 8;
export const AUTOFIX_MAX = 2;

/** Base du ticket : main pour un hotfix, develop sinon. */
export const baseOf = (d: Pick<TicketData, "urgent">) => (d.urgent ? "main" : "develop");

/** Réglages lus par le workflow (.github/workflows/claude-tickets.yml) dans l'issue ou le commentaire. */
export const ticketOpts = (d: Pick<TicketData, "model" | "effort" | "urgent">) =>
  `Modèle : ${d.model}. Effort : ${d.effort}.${d.urgent ? " Hotfix : oui (pars de main, PR vers main)." : ""}`;

export const issueTitle = (id: string) => `Ticket ${id}`;

export function issueBody(id: string, d: TicketData, reopen = false): string {
  return [
    `@claude Ticket \`${id}\` envoyé depuis la page Tickets de Seancy. ${ticketOpts(d)}`,
    reopen
      ? "Ticket rouvert ou suite d'un ticket validé : sa PR précédente est déjà fusionnée (voir les notes de travail), pars d'une branche neuve avec une nouvelle PR ; la demande est dans RETOUCHE DEMANDÉE."
      : "",
    "",
    `Lis-le avec \`node scripts/tickets.ts inbox ${id}\`, traite-le en suivant le skill \`.claude/skills/ticket/SKILL.md\`, ouvre la PR (brouillon, base \`${baseOf(d)}\`), puis écris ton compte rendu : \`node scripts/tickets.ts answer ${id} --pr <PR> --text "…"\`.`,
  ]
    .filter((l, i) => l || i === 2)
    .join("\n");
}

/** Consigne d'un commentaire `@claude` sur la PR (retouche, correction automatique, relance). */
export function prComment(id: string, d: TicketData, why: string): string {
  return `@claude ${why} Ticket \`${id}\` (${ticketOpts(d)}) : lis-le avec \`node scripts/tickets.ts inbox ${id}\` (RETOUCHE DEMANDÉE, notes de travail), corrige sur cette PR, puis \`node scripts/tickets.ts answer ${id} --pr ${d.pr || "<PR>"} --text "…"\`.`;
}

export const FIX_TEXT = {
  conflict: (base: string) =>
    `Correction automatique demandée par la validation : la PR est en conflit avec ${base} (d'autres tickets ont été fusionnés entre-temps). Fusionne ${base} dans la branche de la PR (jamais de rebase), règle chaque conflit en gardant les changements des deux côtés, sans rien changer d'autre, relance les contrôles (format, lint, typecheck, vérifications, build), pousse, puis réponds avec le même compte rendu et une ligne « Conflits avec ${base} réglés ».`,
  tests: (base: string, url: string) =>
    `Correction automatique demandée par la validation : la CI échoue sur la PR avec les derniers changements de ${base}${url ? ` (${url})` : ""}. Mets la branche à jour de ${base} si besoin, trouve la cause, corrige-la sans rien changer d'autre, relance les contrôles, pousse, puis réponds avec le même compte rendu et une ligne « CI réparée ».`,
};

export type Gh = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
export interface PullRequest {
  number: number;
  title: string;
  draft: boolean;
  merged: boolean;
  state: string;
  node_id: string;
  base: { ref: string };
  head: { ref: string; sha: string };
}
export interface Check {
  wait?: string;
  fail?: string;
  fix?: "conflict" | "tests";
  url?: string;
}

/**
 * PR prête à fusionner ? Elle doit contenir toute sa base et la CI doit être
 * passée sur ce code exact. Sinon : base fusionnée dans la PR (la CI repart),
 * ou attente de la CI. Rend null quand la PR peut être fusionnée.
 */
export async function testedOnBase(gh: Gh, repo: string, pr: PullRequest): Promise<Check | null> {
  const cmp = await gh<{ behind_by: number }>(
    `/repos/${repo}/compare/${encodeURIComponent(pr.base.ref)}...${pr.head.sha}`
  );
  if (cmp.behind_by > 0) {
    try {
      await gh(`/repos/${repo}/pulls/${pr.number}/update-branch`, {
        method: "PUT",
        body: { expected_head_sha: pr.head.sha },
      });
    } catch {
      return {
        fail: `La PR est en conflit avec les derniers changements de ${pr.base.ref}`,
        fix: "conflict",
      };
    }
    return { wait: `PR mise à jour avec les derniers changements de ${pr.base.ref}, CI relancée` };
  }
  const { workflow_runs: all = [] } = await gh<{
    workflow_runs?: { status: string; conclusion: string | null; html_url: string }[];
  }>(`/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${pr.head.sha}&per_page=10`);
  const runs = all.filter(
    (r) => !["action_required", "cancelled", "skipped", "stale"].includes(r.conclusion ?? "")
  );
  if (!runs.length) {
    return { wait: "CI pas encore lancée sur la PR" };
  }
  if (runs.some((r) => r.conclusion === "success")) {
    return null;
  }
  if (runs.some((r) => r.status !== "completed")) {
    return { wait: "CI en cours sur la PR" };
  }
  const bad = runs.find((r) => r.conclusion === "failure") ?? runs[0];
  return {
    fail: `CI en échec sur la PR (avec les derniers changements de ${pr.base.ref})`,
    fix: "tests",
    url: bad?.html_url ?? "",
  };
}

/** Adresse de la preview postée par la CI sur la PR (commentaire « Preview deployed »). */
export function previewFromComments(comments: { body?: string }[]): string {
  for (const c of [...comments].reverse()) {
    if (/Preview deployed/i.test(c.body ?? "")) {
      const u = /https:\/\/[^\s)>\]]+\.workers\.dev[^\s)>\]]*/.exec(c.body ?? "")?.[0];
      if (u) {
        return u;
      }
    }
  }
  return "";
}

/** Notification Discord d'un changement fait par Claude ou le workflow (null : rien à dire). */
export function noticeFor(a: Action, title: string): string | null {
  if (a.type === "answer") {
    return `✅ Ticket prêt à valider : **${title}**`;
  }
  if (a.type === "progress" && a.stage === "fail") {
    return `🚨 Ticket arrêté : **${title}** — à relancer depuis la page Tickets`;
  }
  if (a.type === "progress" && a.stage === "quota") {
    return `⏸️ Ticket en pause : **${title}** — quota de Claude atteint, relance automatique dans 1 h`;
  }
  return null;
}

/** Position d'une carte posée avant `before` (fin de colonne sans elle). */
export function positionBefore(
  column: { id: string; position: number }[],
  before: string,
  self = ""
): number {
  const list = column.filter((x) => x.id !== self).sort((a, b) => a.position - b.position);
  const i = before ? list.findIndex((x) => x.id === before) : -1;
  if (i < 0) {
    return (list.at(-1)?.position ?? 0) + 1024;
  }
  const prev = i > 0 ? list[i - 1].position : list[i].position - 2048;
  return (prev + list[i].position) / 2;
}

// ---------- Étiquettes (couleurs façon Trello) ----------

/** Étiquette partagée par tous les tickets : nom et couleur Trello (« green », « red_dark »… ; vide = sans couleur). */
export interface LabelDef {
  name: string;
  color: string;
}
const LABEL_COLOR = /^(green|yellow|orange|red|purple|blue|sky|lime|pink|black)(_light|_dark)?$/;
const sameLabel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Liste d'étiquettes nettoyée : noms bornés, sans doublon (casse ignorée), couleurs connues seulement. */
export function cleanLabelDefs(input: unknown): LabelDef[] {
  const out: LabelDef[] = [];
  for (const x of Array.isArray(input) ? input : []) {
    const o = (x ?? {}) as Record<string, unknown>;
    const name = str(o.name, 50).trim();
    if (name && !out.some((d) => sameLabel(d.name, name))) {
      out.push({ name, color: LABEL_COLOR.test(String(o.color)) ? String(o.color) : "" });
    }
  }
  return out.slice(0, 300);
}

/**
 * Étiquette ajoutée ou changée (`from` : son ancien nom quand elle est
 * renommée), ou retirée (`remove`). Les autres gardent leur place.
 */
export function upsertLabel(
  defs: LabelDef[],
  change: { name?: unknown; color?: unknown; from?: unknown; remove?: unknown }
): LabelDef[] {
  const from = str(change.from, 50).trim();
  if (change.remove) {
    return defs.filter((d) => !sameLabel(d.name, from));
  }
  const [def] = cleanLabelDefs([{ name: change.name, color: change.color }]);
  if (!def) {
    throw new TicketError("Nom d'étiquette manquant");
  }
  const at = defs.findIndex((d) => sameLabel(d.name, from || def.name));
  const rest = defs.filter((d, i) => i !== at && !sameLabel(d.name, def.name));
  if (at < 0) {
    return [...rest, def];
  }
  rest.splice(Math.min(at, rest.length), 0, def);
  return rest;
}

/** Étiquettes venues d'ailleurs (import Trello) : couleur reprise pour les noms connus, les nouvelles ajoutées. */
export function mergeLabels(defs: LabelDef[], incoming: unknown): LabelDef[] {
  const out = [...defs];
  for (const d of cleanLabelDefs(incoming)) {
    const i = out.findIndex((x) => sameLabel(x.name, d.name));
    if (i < 0) {
      out.push(d);
    } else if (d.color) {
      out[i] = { ...out[i], color: d.color };
    }
  }
  return out;
}
