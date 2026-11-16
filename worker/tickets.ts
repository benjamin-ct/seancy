// Tickets de développement envoyés à Claude : routes /api/tickets/*, appelées
// par la page Tickets de l'espace admin (administrateurs connectés : secret
// ADMIN_EMAILS, voir worker/admin.ts) et par les sessions Claude du workflow « Tickets
// (Claude) » (en-tête X-Tickets-Key, clé créée depuis la page, seule son
// empreinte est gardée). Logique pure dans worker/tickets-logic.ts.
//
// Envoyer un ticket ouvre une issue GitHub « Ticket <id> » avec @claude
// (secret GITHUB_TICKETS_TOKEN : jeton à droits Issues, Pull requests,
// Contents et Actions sur le dépôt) ; le workflow la traite, ouvre la PR puis
// écrit son compte rendu (POST /api/tickets/<id>/answer). Valider fusionne la
// PR dès qu'elle contient toute sa base et que la CI est passée, sinon le
// ticket attend en file (tâche planifiée toutes les 2 minutes, runTicketsCron).
// Notifications sur Discord (secret DISCORD_TICKETS_WEBHOOK_URL, facultatif).
import { adminName, adminOf } from "./admin.ts";
import { hashToken } from "./auth.ts";
import {
  AUTOFIX_MAX,
  FIX_TEXT,
  RETRY_EVERY,
  RETRY_MAX,
  STATUSES,
  TicketError,
  applyAction,
  baseOf,
  cleanData,
  issueBody,
  issueTitle,
  noticeFor,
  parseData,
  positionBefore,
  prComment,
  prNumber,
  previewFromComments,
  testedOnBase,
  type Action,
  type Check,
  type Gh,
  type PullRequest,
  type Stage,
  type Ticket,
  type TicketData,
  type TicketFile,
  type TicketStatus,
} from "./tickets-logic.ts";
import type { Env } from "./types.ts";

export const TICKETS_CRON = "*/2 * * * *";
const FILE_MAX = 1_500_000;
const FILES_PER_TICKET = 30;
const FILE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(6))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const repoOf = (env: Env) => env.GITHUB_TICKETS_REPO || "benjamin-ct/seancy";
const siteOf = (env: Env) =>
  (env.TICKETS_SITE_URL || "https://admin.seancy.com").replace(/\/$/, "");

// ---------- Accès ----------

interface Access {
  admin: boolean;
  key: boolean;
  /** Administrateur connecté (nom affiché, adresse) : signe ses tickets et ses actions. */
  name: string;
  email: string;
}
async function accessOf(request: Request, env: Env): Promise<Access> {
  const k = request.headers.get("x-tickets-key") || "";
  let key = false;
  if (k.length >= 32) {
    const saved = await getMeta(env, "key");
    key = !!saved && (await hashToken(k)) === saved;
  }
  // Administrateur : même porte que tout l'espace admin (worker/admin.ts)
  const user = await adminOf(request, env);
  return user
    ? { admin: true, key, name: adminName(user), email: user.email.toLowerCase() }
    : { admin: false, key, name: "", email: "" };
}

async function getMeta(env: Env, k: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT v FROM ticket_meta WHERE k = ?")
    .bind(k)
    .first<{ v: string }>();
  return row?.v ?? null;
}
const setMeta = (env: Env, k: string, v: string) =>
  env.DB.prepare(
    "INSERT INTO ticket_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
  )
    .bind(k, v)
    .run();

// ---------- Base ----------

interface Row {
  id: string;
  status: string;
  position: number;
  data: string;
  trello_id: string | null;
  version: number;
  created_at: number;
}
const statusOf = (s: string): TicketStatus =>
  (STATUSES as readonly string[]).includes(s) ? (s as TicketStatus) : "todo";

function toTicket(row: Row, files: TicketFile[] = []): Ticket {
  return {
    ...parseData(row.data),
    id: row.id,
    status: statusOf(row.status),
    position: row.position,
    createdAt: row.created_at,
    files,
  };
}

async function filesOf(env: Env, ids?: string[]): Promise<Map<string, TicketFile[]>> {
  const q = ids?.length
    ? env.DB.prepare(
        `SELECT id, ticket_id, name, type, size FROM ticket_files WHERE ticket_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`
      ).bind(...ids)
    : env.DB.prepare(
        "SELECT id, ticket_id, name, type, size FROM ticket_files ORDER BY created_at"
      );
  const { results } = await q.all<TicketFile & { ticket_id: string }>();
  const map = new Map<string, TicketFile[]>();
  for (const f of results) {
    const list = map.get(f.ticket_id) ?? [];
    list.push({ id: f.id, name: f.name, type: f.type, size: f.size });
    map.set(f.ticket_id, list);
  }
  return map;
}

async function loadRow(env: Env, id: string): Promise<Row | null> {
  return env.DB.prepare(
    "SELECT id, status, position, data, trello_id, version, created_at FROM tickets WHERE id = ?"
  )
    .bind(id)
    .first<Row>();
}
async function loadTicket(env: Env, id: string): Promise<Ticket | null> {
  const row = await loadRow(env, id);
  return row ? toTicket(row, (await filesOf(env, [id])).get(id)) : null;
}
async function loadAll(env: Env): Promise<Ticket[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, status, position, data, trello_id, version, created_at FROM tickets ORDER BY position"
  ).all<Row>();
  const files = await filesOf(env);
  return results.map((r) => toTicket(r, files.get(r.id)));
}

/**
 * Modification d'un ticket : relu, changé par `fn`, écrit seulement s'il n'a
 * pas bougé entre-temps (colonne version), sinon refait (3 essais).
 */
async function mutate(
  env: Env,
  id: string,
  fn: (t: { status: TicketStatus; data: TicketData; position: number }) => {
    status: TicketStatus;
    data: TicketData;
    position?: number;
  },
  now = Date.now()
): Promise<Ticket> {
  for (let i = 0; i < 3; i++) {
    const row = await loadRow(env, id);
    if (!row) {
      throw new TicketError("Ticket introuvable", 404);
    }
    const next = fn({
      status: statusOf(row.status),
      data: parseData(row.data),
      position: row.position,
    });
    const r = await env.DB.prepare(
      "UPDATE tickets SET status = ?, position = ?, data = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?"
    )
      .bind(
        next.status,
        next.position ?? row.position,
        JSON.stringify(next.data),
        now,
        id,
        row.version
      )
      .run();
    if (r.meta.changes === 1) {
      return toTicket(
        {
          ...row,
          status: next.status,
          position: next.position ?? row.position,
          data: JSON.stringify(next.data),
        },
        (await filesOf(env, [id])).get(id)
      );
    }
  }
  throw new TicketError("Ticket modifié en même temps ailleurs : réessaie", 409);
}
const act = (env: Env, id: string, a: Action, now = Date.now(), by = "") =>
  mutate(env, id, (t) => applyAction(t, a, now, by), now);

async function columnOf(env: Env, status: TicketStatus) {
  const { results } = await env.DB.prepare("SELECT id, position FROM tickets WHERE status = ?")
    .bind(status)
    .all<{ id: string; position: number }>();
  return results;
}

async function insert(
  env: Env,
  data: TicketData,
  status: TicketStatus,
  {
    before,
    top = false,
    trelloId = null,
    position,
  }: { before?: string; top?: boolean; trelloId?: string | null; position?: number } = {},
  now = Date.now()
): Promise<string> {
  const col = await columnOf(env, status);
  const pos =
    position ??
    (top ? Math.min(0, ...col.map((x) => x.position)) - 1024 : positionBefore(col, before ?? ""));
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO tickets (id, status, position, data, trello_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
  )
    .bind(id, status, pos, JSON.stringify(data), trelloId, now, now)
    .run();
  return id;
}

// ---------- GitHub et Discord ----------

function gh(env: Env): Gh {
  return async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const r = await fetch(`https://api.github.com${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${env.GITHUB_TICKETS_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "seancy-tickets",
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const d = (await r.json().catch(() => ({}))) as T & { message?: string };
    if (!r.ok) {
      throw new TicketError(`GitHub : ${d.message || `erreur ${r.status}`}`, 502);
    }
    return d;
  };
}

async function notify(env: Env, text: string): Promise<void> {
  if (!env.DISCORD_TICKETS_WEBHOOK_URL) {
    return;
  }
  await fetch(env.DISCORD_TICKETS_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `${text}\n${siteOf(env)}/tickets`.slice(0, 1900),
      allowed_mentions: { parse: [] },
    }),
  }).catch(() => {});
}

/** Issues encore ouvertes du ticket (une par envoi) fermées : avant d'en ouvrir une autre, et à la fusion. */
async function closeTicketIssues(env: Env, id: string): Promise<void> {
  const call = gh(env);
  const repo = repoOf(env);
  const open = await call<{ number: number; title: string; pull_request?: unknown }[]>(
    `/repos/${repo}/issues?state=open&per_page=100`
  ).catch(() => []);
  for (const i of open.filter((x) => !x.pull_request && x.title === issueTitle(id))) {
    await call(`/repos/${repo}/issues/${i.number}`, {
      method: "PATCH",
      body: { state: "closed", state_reason: "completed" },
    }).catch(() => {});
  }
}

async function openIssue(env: Env, t: Ticket, reopen = false): Promise<void> {
  await closeTicketIssues(env, t.id);
  await gh(env)(`/repos/${repoOf(env)}/issues`, {
    method: "POST",
    body: { title: issueTitle(t.id), body: issueBody(t.id, t, reopen) },
  });
}

/** Ticket (re)parti chez Claude : commentaire sur sa PR s'il en a une (même branche), sinon nouvelle issue. */
async function dispatch(env: Env, t: Ticket, why: string): Promise<void> {
  const n = prNumber(t.pr);
  if (n) {
    await gh(env)(`/repos/${repoOf(env)}/issues/${n}/comments`, {
      method: "POST",
      body: { body: prComment(t.id, t, why) },
    });
  } else {
    await openIssue(env, t);
  }
}

const requireGitHub = (env: Env) => {
  if (!env.GITHUB_TICKETS_TOKEN) {
    throw new TicketError(
      "Tickets GitHub pas encore réglés (secret GITHUB_TICKETS_TOKEN du Worker)",
      503
    );
  }
};

// ---------- Validation ----------

async function autoFix(env: Env, t: Ticket, check: Check, now: number): Promise<Check> {
  if (!check.fix || t.autofix + 1 > AUTOFIX_MAX) {
    return {
      fail: `${check.fail}${check.fix ? ` (Claude n'a pas réussi à le régler en ${AUTOFIX_MAX} essais)` : ""} : demande une retouche`,
    };
  }
  const base = baseOf(t);
  const text =
    check.fix === "conflict" ? FIX_TEXT.conflict(base) : FIX_TEXT.tests(base, check.url ?? "");
  const next = await act(env, t.id, { type: "autofix", text }, now);
  await gh(env)(`/repos/${repoOf(env)}/issues/${prNumber(t.pr)}/comments`, {
    method: "POST",
    body: {
      body: prComment(
        t.id,
        next,
        `Correction automatique ${next.autofix}/${AUTOFIX_MAX} (${check.fix === "conflict" ? `conflit avec ${base}` : "CI en échec"}).`
      ),
    },
  });
  return {
    wait: `${check.fix === "conflict" ? `Conflit avec ${base}` : "CI en échec"} : Claude le règle tout seul (essai ${next.autofix}/${AUTOFIX_MAX}), puis la PR sera fusionnée`,
  };
}

/** PR fusionnée (squash), branche supprimée, issues fermées ; hotfix : main refusionné dans develop. */
async function mergeTicket(
  env: Env,
  t: Ticket,
  pr: PullRequest,
  now: number,
  by = ""
): Promise<Ticket> {
  const call = gh(env);
  const repo = repoOf(env);
  if (pr.draft) {
    await call("/graphql", {
      method: "POST",
      body: {
        query:
          "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }",
        variables: { id: pr.node_id },
      },
    });
  }
  if (!pr.merged) {
    await call(`/repos/${repo}/pulls/${pr.number}/merge`, {
      method: "PUT",
      body: { merge_method: "squash", commit_title: `${pr.title} (#${pr.number})` },
    });
  }
  await call(`/repos/${repo}/git/refs/heads/${encodeURIComponent(pr.head.ref)}`, {
    method: "DELETE",
  }).catch(() => {});
  await closeTicketIssues(env, t.id);
  let backport = "";
  if (pr.base.ref === "main") {
    try {
      await call(`/repos/${repo}/merges`, {
        method: "POST",
        body: {
          base: "develop",
          head: "main",
          commit_message: `Merge main into develop (backport #${pr.number})`,
        },
      });
      backport = " · main refusionné dans develop";
    } catch {
      backport = " · ⚠️ main n'a pas pu être refusionné dans develop (conflit) : à faire à la main";
    }
  }
  const next = await act(env, t.id, t.followUp ? { type: "followup" } : { type: "done" }, now, by);
  if (t.followUp) {
    await openIssue(env, next, true);
  }
  await notify(
    env,
    `🎉 Ticket validé : **${t.title}** — PR #${pr.number} fusionnée dans ${pr.base.ref}${backport}${t.followUp ? " · suite envoyée à Claude" : ""}`
  );
  return next;
}

async function validate(env: Env, t: Ticket, followUp: string, now: number, by: string) {
  const n = prNumber(t.pr);
  if (!n) {
    // Ticket sans PR (rien à coder) : fait, ou la suite repart chez Claude
    if (followUp) {
      await act(env, t.id, { type: "queue", followUp }, now, by);
      const next = await act(env, t.id, { type: "followup" }, now, by);
      await openIssue(env, next, true);
      return { ok: true, merged: 0 };
    }
    await act(env, t.id, { type: "done" }, now, by);
    await closeTicketIssues(env, t.id).catch(() => {});
    return { ok: true, merged: 0 };
  }
  const pr = await gh(env)<PullRequest>(`/repos/${repoOf(env)}/pulls/${n}`);
  const all = await loadAll(env);
  const ahead = all.filter((x) => x.queued && x.status !== "done" && x.id !== t.id);
  const queued = await act(env, t.id, { type: "queue", followUp }, now, by);
  let check: Check | null = pr.merged
    ? null
    : ahead.length
      ? { wait: "Après les tickets déjà en file" }
      : await testedOnBase(gh(env), repoOf(env), pr);
  if (check?.fail) {
    check = await autoFix(env, { ...queued, autofix: 0 }, check, now);
  }
  if (check?.fail) {
    await act(env, t.id, { type: "unqueue" }, now, by);
    throw new TicketError(check.fail, 409);
  }
  if (check?.wait) {
    return { ok: true, queued: true, position: ahead.length + 1, why: check.wait };
  }
  await mergeTicket(env, queued, pr, now, by);
  return { ok: true, merged: Number(n) };
}

/** File des validations : un ticket à la fois, dans l'ordre des validations, remis à jour et testé après le précédent. */
export async function validateQueue(env: Env, now = Date.now()): Promise<string | null> {
  if (!env.GITHUB_TICKETS_TOKEN) {
    return null;
  }
  const queue = (await loadAll(env))
    .filter((x) => x.queued && x.status !== "done")
    .sort((a, b) => a.queued - b.queued);
  const fixing = (x: Ticket) => x.status === "work";
  const stuck = queue.find((x) => fixing(x) && x.stage === "fail");
  const t = stuck ?? queue.find((x) => !fixing(x));
  if (!t) {
    return queue.length ? "wait" : null;
  }
  const n = prNumber(t.pr);
  const pr = n ? await gh(env)<PullRequest>(`/repos/${repoOf(env)}/pulls/${n}`) : null;
  let check: Check | null = stuck
    ? {
        fail: "Claude s'est arrêté sur une erreur en corrigeant la PR : relance le ticket ou demande une retouche",
      }
    : !pr
      ? { fail: "Pas de PR pour ce ticket" }
      : pr.merged
        ? null
        : await testedOnBase(gh(env), repoOf(env), pr);
  if (check?.fail && !stuck) {
    check = await autoFix(env, t, check, now);
  }
  if (check?.wait) {
    return "wait";
  }
  if (check?.fail || !pr) {
    await act(env, t.id, { type: "unqueue" }, now);
    await notify(env, `🚨 Validation impossible : **${t.title}** — ${check?.fail ?? "pas de PR"}`);
    return "fail";
  }
  await mergeTicket(env, t, pr, now);
  return "merged";
}

/** Tickets en pause faute de quota Claude : relancés une heure après (commentaire @claude), 8 fois au plus. */
export async function retryTickets(env: Env, now = Date.now()): Promise<number> {
  if (!env.GITHUB_TICKETS_TOKEN) {
    return 0;
  }
  const due = (await loadAll(env)).filter(
    (t) =>
      t.status === "work" && t.stage === "quota" && t.issue && now - t.progressAt >= RETRY_EVERY
  );
  for (const t of due) {
    const n = t.retries + 1;
    if (n > RETRY_MAX) {
      await act(
        env,
        t.id,
        {
          type: "progress",
          stage: "fail",
          text: `Toujours pas de quota Claude après ${RETRY_MAX} relances : relance le ticket à la main`,
        },
        now
      );
      await notify(
        env,
        `🚨 Ticket arrêté : **${t.title}** — pas de quota Claude après ${RETRY_MAX} relances`
      );
      continue;
    }
    try {
      await gh(env)(`/repos/${repoOf(env)}/issues/${t.issue}/comments`, {
        method: "POST",
        body: {
          body: prComment(
            t.id,
            t,
            `Relance automatique ${n}/${RETRY_MAX} (quota de Claude épuisé la dernière fois) : reprends là où tu en étais.`
          ),
        },
      });
      await act(env, t.id, { type: "retry", n }, now);
    } catch {
      // GitHub injoignable : nouvel essai au prochain passage
    }
  }
  return due.length;
}

/** Preview de la PR (commentaire de la CI) notée dans les tickets à valider qui n'en ont pas encore. */
async function findPreviews(env: Env, now: number): Promise<void> {
  if (!env.GITHUB_TICKETS_TOKEN) {
    return;
  }
  const list = (await loadAll(env))
    .filter((t) => t.status === "review" && prNumber(t.pr) && !t.preview)
    .slice(0, 5);
  for (const t of list) {
    const comments = await gh(env)<{ body?: string }[]>(
      `/repos/${repoOf(env)}/issues/${prNumber(t.pr)}/comments?per_page=100`
    ).catch(() => []);
    const url = previewFromComments(comments);
    if (url) {
      await act(env, t.id, { type: "preview", url }, now).catch(() => {});
    }
  }
}

export async function runTicketsCron(env: Env, now = Date.now()): Promise<void> {
  for (const [name, job] of [
    ["file de validation", () => validateQueue(env, now)],
    ["relances", () => retryTickets(env, now)],
    ["previews", () => findPreviews(env, now)],
  ] as const) {
    try {
      await job();
    } catch (err) {
      console.error(`Tickets (${name}) :`, err);
    }
  }
}

// ---------- Routes ----------

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const v = (await request.json()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const text = (v: unknown, max = 8000) => (typeof v === "string" ? v : "").slice(0, max);

function sniffOk(type: string, b: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  switch (type) {
    case "image/png":
      return b[0] === 0x89 && ascii(1, 4) === "PNG";
    case "image/jpeg":
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "image/gif":
      return ascii(0, 4) === "GIF8";
    case "application/pdf":
      return ascii(0, 5) === "%PDF-";
    default:
      return true; // vidéos : jamais exécutables, servies avec nosniff
  }
}

async function putFile(env: Env, request: Request, id: string, url: URL): Promise<Response> {
  if (!(await loadRow(env, id))) {
    return json({ error: "Ticket introuvable" }, 404);
  }
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!FILE_TYPES.has(type)) {
    return json({ error: "Type de fichier non pris en charge (images, PDF, vidéos)" }, 415);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > FILE_MAX) {
    return json({ error: "Fichier vide ou trop gros (1,5 Mo au plus)" }, 413);
  }
  if (!sniffOk(type, bytes)) {
    return json({ error: "Le contenu du fichier ne correspond pas à son type" }, 415);
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM ticket_files WHERE ticket_id = ?")
    .bind(id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= FILES_PER_TICKET) {
    return json({ error: `${FILES_PER_TICKET} fichiers au plus par ticket` }, 413);
  }
  const name =
    (url.searchParams.get("name") || "fichier")
      .split(/[\\/]/)
      .pop()!
      .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
      .slice(0, 120) || "fichier";
  const fid = newId() + newId();
  await env.DB.prepare(
    "INSERT INTO ticket_files (id, ticket_id, name, type, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(fid, id, name, type, bytes.length, bytes, Date.now())
    .run();
  return json({ ok: true, file: { id: fid, name, type, size: bytes.length } });
}

async function getFile(env: Env, fid: string): Promise<Response> {
  const f = await env.DB.prepare("SELECT name, type, data FROM ticket_files WHERE id = ?")
    .bind(fid)
    .first<{ name: string; type: string; data: ArrayBuffer | number[] }>();
  if (!f) {
    return json({ error: "Fichier introuvable" }, 404);
  }
  const data = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : new Uint8Array(f.data);
  return new Response(data, {
    headers: {
      "content-type": FILE_TYPES.has(f.type) ? f.type : "application/octet-stream",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}

async function importTickets(env: Env, items: unknown[]): Promise<Response> {
  const created: { trelloId: string; id: string }[] = [];
  const skipped: { trelloId: string; id: string }[] = [];
  for (const raw of items.slice(0, 200)) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const trelloId = text(o.trelloId, 40);
    if (!trelloId) {
      continue;
    }
    const existing = await env.DB.prepare("SELECT id FROM tickets WHERE trello_id = ?")
      .bind(trelloId)
      .first<{ id: string }>();
    if (existing) {
      skipped.push({ trelloId, id: existing.id });
      continue;
    }
    const data = cleanData(o);
    if (!data.title) {
      continue;
    }
    const status = statusOf(String(o.status));
    const position = Number.isFinite(Number(o.position)) ? Number(o.position) : undefined;
    const id = await insert(env, data, status, { trelloId, position });
    created.push({ trelloId, id });
  }
  return json({ ok: true, created, skipped });
}

export async function handleTickets(request: Request, env: Env, url: URL): Promise<Response> {
  const access = await accessOf(request, env);
  if (!access.admin && !access.key) {
    return json({ error: "Réservé aux administrateurs de Seancy" }, 403);
  }
  const parts = url.pathname
    .replace(/^\/api\/tickets\/?/, "")
    .split("/")
    .filter(Boolean);
  const m = request.method;
  const adminOnly = () => {
    if (!access.admin) {
      throw new TicketError("Réservé à la page Tickets", 403);
    }
  };
  const now = Date.now();
  try {
    if (!parts.length && m === "GET") {
      return json({
        tickets: await loadAll(env),
        config: {
          github: !!env.GITHUB_TICKETS_TOKEN,
          discord: !!env.DISCORD_TICKETS_WEBHOOK_URL,
          key: !!(await getMeta(env, "key")),
          repo: repoOf(env),
        },
      });
    }
    if (!parts.length && m === "POST") {
      const b = await body(request);
      // Seuls les champs d'un nouveau ticket ; l'auteur est celui qui fait la requête (Claude avec la clé)
      const data = cleanData(
        Object.fromEntries(
          ["title", "detail", "labels", "links", "model", "effort", "urgent"].map((k) => [k, b[k]])
        )
      );
      data.author = access.admin ? access.name : "Claude";
      data.authorEmail = access.admin ? access.email : "";
      if (!data.title) {
        const first = data.detail.split("\n").find((l) => l.trim()) ?? "";
        data.title = first.trim().slice(0, 120);
      }
      if (!data.title) {
        throw new TicketError("Écris un titre ou une description");
      }
      const status: TicketStatus = b.status === "idea" ? "idea" : "todo";
      if (b.send) {
        adminOnly();
        requireGitHub(env);
      }
      const id = await insert(
        env,
        data,
        status,
        { top: status === "idea", before: text(b.before, 40) || undefined },
        now
      );
      if (b.send) {
        const t = await act(env, id, { type: "send" }, now, access.name);
        try {
          await openIssue(env, t);
        } catch (err) {
          await act(env, id, { type: "unsend" }, now, access.name).catch(() => {});
          throw err;
        }
      }
      return json({ ok: true, ticket: await loadTicket(env, id) });
    }
    if (parts[0] === "key" && m === "POST") {
      adminOnly();
      const key = [...crypto.getRandomValues(new Uint8Array(24))]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      await setMeta(env, "key", await hashToken(key));
      return json({ key });
    }
    if (parts[0] === "import" && m === "POST") {
      const b = await body(request);
      return await importTickets(env, Array.isArray(b.tickets) ? b.tickets : []);
    }
    if (parts[0] === "files" && parts[1] && m === "GET") {
      return await getFile(env, parts[1]);
    }
    const id = parts[0];
    if (!id || !/^[a-f0-9]{12}$/.test(id)) {
      return json({ error: "Introuvable" }, 404);
    }
    const sub = parts[1] ?? "";
    if (!sub && m === "GET") {
      const t = await loadTicket(env, id);
      return t ? json({ ticket: t }) : json({ error: "Ticket introuvable" }, 404);
    }
    if (!sub && m === "PATCH") {
      adminOnly();
      return json({
        ok: true,
        ticket: await act(env, id, { type: "edit", fields: await body(request) }, now, access.name),
      });
    }
    if (!sub && m === "DELETE") {
      adminOnly();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM ticket_files WHERE ticket_id = ?").bind(id),
        env.DB.prepare("DELETE FROM tickets WHERE id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
    if (sub === "files" && m === "PUT") {
      return await putFile(env, request, id, url);
    }
    if (sub === "files" && parts[2] && m === "DELETE") {
      adminOnly();
      await env.DB.prepare("DELETE FROM ticket_files WHERE id = ? AND ticket_id = ?")
        .bind(parts[2], id)
        .run();
      return json({ ok: true });
    }
    if (sub === "move" && m === "POST") {
      adminOnly();
      const b = await body(request);
      const cur = await loadRow(env, id);
      if (!cur) {
        throw new TicketError("Ticket introuvable", 404);
      }
      const to = b.to ? statusOf(String(b.to)) : statusOf(cur.status);
      const col = await columnOf(env, to);
      const position = positionBefore(col, text(b.before, 40), id);
      const t = await mutate(
        env,
        id,
        (x) => ({
          ...(to === x.status
            ? { status: x.status, data: x.data }
            : applyAction(x, { type: "move", to }, now)),
          position,
        }),
        now
      );
      return json({ ok: true, ticket: t });
    }
    if (sub === "answer" && m === "POST") {
      const b = await body(request);
      const t = await act(
        env,
        id,
        { type: "answer", text: text(b.text), pr: text(b.pr, 400), notes: text(b.notes) },
        now
      );
      const msg = noticeFor({ type: "answer", text: "" }, t.title);
      if (msg) {
        await notify(env, msg);
      }
      return json({ ok: true, ticket: t });
    }
    if (sub === "progress" && m === "POST") {
      const b = await body(request);
      const a: Action = {
        type: "progress",
        stage: (["start", "work", "fail", "quota"].includes(String(b.stage))
          ? b.stage
          : "work") as Stage,
        text: text(b.text, 500),
        run: text(b.run, 400),
        issue: text(b.issue, 12),
      };
      const before = await loadTicket(env, id);
      const t = await act(env, id, a, now, access.name);
      const msg = before?.stage !== a.stage ? noticeFor(a, t.title) : null;
      if (msg) {
        await notify(env, msg);
      }
      return json({ ok: true, ticket: t });
    }
    if (sub === "action" && m === "POST") {
      adminOnly();
      const b = await body(request);
      const t = await loadTicket(env, id);
      if (!t) {
        throw new TicketError("Ticket introuvable", 404);
      }
      const action = String(b.action);
      if (action === "unsend") {
        const next = await act(env, id, { type: "unsend" }, now, access.name);
        if (env.GITHUB_TICKETS_TOKEN && !prNumber(t.pr)) {
          await closeTicketIssues(env, id).catch(() => {});
        }
        return json({ ok: true, ticket: next });
      }
      if (action === "unqueue") {
        return json({
          ok: true,
          ticket: await act(env, id, { type: "unqueue" }, now, access.name),
        });
      }
      requireGitHub(env);
      // Ticket parti chez Claude : si GitHub refuse (jeton expiré, panne), il
      // revient tel qu'il était plutôt que de rester « En cours » sans Claude
      const toClaude = async (a: Action, job: (next: Ticket) => Promise<void>) => {
        const next = await act(env, id, a, now, access.name);
        try {
          await job(next);
        } catch (err) {
          await mutate(env, id, () => ({ status: t.status, data: cleanData({ ...t }) }), now).catch(
            () => {}
          );
          throw err;
        }
        return json({ ok: true, ticket: next });
      };
      if (action === "send") {
        const relaunch = t.status === "work" && !!prNumber(t.pr);
        return await toClaude({ type: "send" }, (next) =>
          relaunch
            ? dispatch(
                env,
                next,
                "Relance du ticket (arrêté la dernière fois) : reprends là où tu en étais."
              )
            : openIssue(env, next)
        );
      }
      if (action === "retouch") {
        return await toClaude({ type: "retouch", text: text(b.text) }, (next) =>
          dispatch(env, next, "Retouche demandée.")
        );
      }
      if (action === "reopen") {
        return await toClaude({ type: "reopen", text: text(b.text) }, (next) =>
          openIssue(env, next, true)
        );
      }
      if (action === "validate") {
        if (t.status !== "review") {
          throw new TicketError("Seul un ticket à valider se valide", 409);
        }
        return json(await validate(env, t, text(b.text).trim(), now, access.name));
      }
      throw new TicketError("Action inconnue");
    }
    return json({ error: "Introuvable" }, 404);
  } catch (err) {
    if (err instanceof TicketError) {
      return json({ error: err.message }, err.status);
    }
    console.error("Tickets :", err);
    return json({ error: "Erreur du serveur des tickets" }, 500);
  }
}
