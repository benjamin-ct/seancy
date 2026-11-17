// Consommation de Claude par les tickets (tableau de bord de l'espace admin).
//
// À la fin de chaque passage de Claude, le workflow « Tickets (Claude) » lit
// son journal (execution_file de claude-code-action : tableau des messages du
// SDK) et envoie ici ce qu'il en tire (scripts/tickets.ts usage) :
// - les jetons et le coût estimé, par modèle, du message `result`
//   (`modelUsage`, sous-agents compris ; `total_cost_usd` est une estimation
//   au prix public, pas une facturation : l'abonnement n'est pas facturé ainsi) ;
// - l'état du quota de l'abonnement, des messages `rate_limit_event`
//   (fenêtre de 5 h, semaine…) : un relevé au moment du passage, pas un
//   compteur en direct (aucune lecture officielle du quota n'existe).
// Logique pure : vérifiée par scripts/verify-claude-usage.ts.

export interface ModelUse {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}
export interface Limit {
  /** five_hour, seven_day, seven_day_opus, seven_day_sonnet… */
  type: string;
  /** allowed, allowed_warning, rejected */
  status: string;
  /** Part utilisée en % (0 à 100) ; null si Claude ne l'a pas donnée. */
  used: number | null;
  /** Remise à zéro (ms) ; 0 si inconnue. */
  resetsAt: number;
  /** Date du relevé (ms). */
  at: number;
}
export interface RunUsage {
  models: Record<string, ModelUse>;
  cost: number;
  turns: number;
  durationMs: number;
  limits: Limit[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown, max = 60) => (typeof v === "string" ? v.slice(0, max) : "");

/** Journal d'un passage (tableau de messages, ou une ligne JSON par message) → consommation ; null sans `result`. */
export function parseExecution(raw: string, now = Date.now()): RunUsage | null {
  let messages: unknown[] = [];
  try {
    const v = JSON.parse(raw) as unknown;
    messages = Array.isArray(v) ? v : [v];
  } catch {
    messages = raw
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  const all = messages.filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
  const result = all.filter((m) => m.type === "result").pop();
  if (!result) {
    return null;
  }
  const models: Record<string, ModelUse> = {};
  for (const [name, u] of Object.entries((result.modelUsage ?? {}) as Record<string, unknown>)) {
    const x = (u ?? {}) as Record<string, unknown>;
    models[str(name, 80)] = {
      input: num(x.inputTokens),
      output: num(x.outputTokens),
      cacheRead: num(x.cacheReadInputTokens),
      cacheWrite: num(x.cacheCreationInputTokens),
      cost: num(x.costUSD),
    };
  }
  // Sans modelUsage (ancienne version) : l'usage de la boucle principale
  if (!Object.keys(models).length && result.usage && typeof result.usage === "object") {
    const u = result.usage as Record<string, unknown>;
    models.claude = {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      cost: num(result.total_cost_usd),
    };
  }
  // Dernier état connu de chaque fenêtre de quota
  const limits = new Map<string, Limit>();
  for (const m of all) {
    const info =
      m.type === "rate_limit_event" ? (m.rate_limit_info as Record<string, unknown>) : null;
    if (!info || typeof info !== "object") {
      continue;
    }
    const type = str(info.rateLimitType) || "five_hour";
    const u = typeof info.utilization === "number" ? info.utilization : null;
    const reset = num(info.resetsAt);
    limits.set(type, {
      type,
      status: str(info.status) || "allowed",
      // 0 à 1 ou 0 à 100 selon la version : ramené en %
      used: u === null ? null : Math.min(100, Math.round((u <= 1 ? u * 100 : u) * 10) / 10),
      // secondes ou millisecondes selon la version
      resetsAt: reset ? (reset < 1e12 ? reset * 1000 : reset) : 0,
      at: now,
    });
  }
  return {
    models,
    cost: num(result.total_cost_usd),
    turns: num(result.num_turns),
    durationMs: num(result.duration_ms),
    limits: [...limits.values()],
  };
}

/** Consommation reçue du workflow, nettoyée (nombres bornés, au plus 10 modèles et 10 fenêtres). */
export function cleanRun(v: unknown, now = Date.now()): RunUsage | null {
  const o = (v ?? {}) as Record<string, unknown>;
  if (!o || typeof o !== "object" || !o.models || typeof o.models !== "object") {
    return null;
  }
  const models: Record<string, ModelUse> = {};
  for (const [name, u] of Object.entries(o.models as Record<string, unknown>).slice(0, 10)) {
    const x = (u ?? {}) as Record<string, unknown>;
    models[str(name, 80)] = {
      input: num(x.input),
      output: num(x.output),
      cacheRead: num(x.cacheRead),
      cacheWrite: num(x.cacheWrite),
      cost: num(x.cost),
    };
  }
  const limits = (Array.isArray(o.limits) ? o.limits : []).slice(0, 10).map((l) => {
    const x = (l ?? {}) as Record<string, unknown>;
    return {
      type: str(x.type) || "five_hour",
      status: str(x.status) || "allowed",
      used: typeof x.used === "number" && x.used >= 0 ? Math.min(100, x.used) : null,
      resetsAt: num(x.resetsAt),
      at: Math.min(num(x.at) || now, now),
    };
  });
  return { models, cost: num(o.cost), turns: num(o.turns), durationMs: num(o.durationMs), limits };
}

export const tokensOf = (m: ModelUse) => m.input + m.output + m.cacheRead + m.cacheWrite;

export interface UsageRow {
  ticket: string;
  at: number;
  run: RunUsage;
}
interface Total {
  runs: number;
  tokens: number;
  output: number;
  cost: number;
}
export interface UsageSummary {
  today: Total;
  week: Total;
  month: Total;
  /** 30 jours, par modèle (le plus consommateur d'abord). */
  byModel: { model: string; tokens: number; cost: number }[];
  /** 30 jours, les tickets qui ont le plus consommé. */
  byTicket: { ticket: string; runs: number; tokens: number; cost: number }[];
  /** Dernier relevé de chaque fenêtre de quota. */
  limits: Limit[];
  last: number;
}

/** Totaux du jour (heure de Paris), des 7 et des 30 derniers jours. */
export function summarize(rows: UsageRow[], limits: Limit[], now = Date.now()): UsageSummary {
  const parisDay = (t: number) =>
    new Date(t).toLocaleDateString("fr-CA", { timeZone: "Europe/Paris" });
  const today = parisDay(now);
  const zero = (): Total => ({ runs: 0, tokens: 0, output: 0, cost: 0 });
  const t = { today: zero(), week: zero(), month: zero() };
  const models = new Map<string, { tokens: number; cost: number }>();
  const tickets = new Map<string, { runs: number; tokens: number; cost: number }>();
  for (const r of rows) {
    const age = now - r.at;
    if (age > 30 * 86_400_000) {
      continue;
    }
    const list = Object.entries(r.run.models);
    const tokens = list.reduce((s, [, m]) => s + tokensOf(m), 0);
    const output = list.reduce((s, [, m]) => s + m.output, 0);
    const cost = r.run.cost || list.reduce((s, [, m]) => s + m.cost, 0);
    for (const [key, ok] of [
      ["today", parisDay(r.at) === today],
      ["week", age <= 7 * 86_400_000],
      ["month", true],
    ] as const) {
      if (ok) {
        t[key].runs++;
        t[key].tokens += tokens;
        t[key].output += output;
        t[key].cost += cost;
      }
    }
    for (const [name, m] of list) {
      const x = models.get(name) ?? { tokens: 0, cost: 0 };
      x.tokens += tokensOf(m);
      x.cost += m.cost;
      models.set(name, x);
    }
    if (r.ticket) {
      const x = tickets.get(r.ticket) ?? { runs: 0, tokens: 0, cost: 0 };
      x.runs++;
      x.tokens += tokens;
      x.cost += cost;
      tickets.set(r.ticket, x);
    }
  }
  const round = (x: Total) => ({ ...x, cost: Math.round(x.cost * 100) / 100 });
  return {
    today: round(t.today),
    week: round(t.week),
    month: round(t.month),
    byModel: [...models.entries()]
      .map(([model, x]) => ({ model, tokens: x.tokens, cost: Math.round(x.cost * 100) / 100 }))
      .sort((a, b) => b.tokens - a.tokens),
    byTicket: [...tickets.entries()]
      .map(([ticket, x]) => ({ ticket, ...x, cost: Math.round(x.cost * 100) / 100 }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8),
    limits: [...limits].sort((a, b) => a.type.localeCompare(b.type)),
    last: rows.reduce((m, r) => Math.max(m, r.at), 0),
  };
}

/** Relevés de quota : le plus récent de chaque fenêtre (anciens et nouveaux mêlés). */
export function mergeLimits(old: Limit[], fresh: Limit[]): Limit[] {
  const by = new Map(old.map((l) => [l.type, l]));
  for (const l of fresh) {
    const prev = by.get(l.type);
    if (!prev || l.at >= prev.at) {
      by.set(l.type, l);
    }
  }
  return [...by.values()];
}
