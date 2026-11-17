// Vérification du relevé de consommation de Claude (worker/claude-usage.ts) :
// lecture du journal de claude-code-action, nettoyage, totaux, quota.
// Script autonome, même principe que verify-tickets.ts.

import {
  cleanRun,
  mergeLimits,
  parseExecution,
  summarize,
  type RunUsage,
} from "../worker/claude-usage.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    console.log(`     attendu: ${JSON.stringify(expected)}`);
    console.log(`     obtenu : ${JSON.stringify(actual)}`);
  }
  if (ok) {
    passed++;
  } else {
    failed++;
  }
}

const NOW = Date.UTC(2026, 10, 17, 20, 0);
const result = {
  type: "result",
  subtype: "success",
  total_cost_usd: 1.234,
  num_turns: 42,
  duration_ms: 600_000,
  usage: { input_tokens: 1, output_tokens: 2 },
  modelUsage: {
    "claude-opus-5-5": {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 20000,
      cacheCreationInputTokens: 3000,
      costUSD: 1.2,
    },
    "claude-haiku-5-5": { inputTokens: 100, outputTokens: 50, costUSD: 0.034 },
  },
};
const rate = (info: Record<string, unknown>) => ({
  type: "rate_limit_event",
  rate_limit_info: info,
});

// Journal : tableau de messages (format de claude-code-action)
{
  const run = parseExecution(
    JSON.stringify([
      { type: "system", subtype: "init" },
      rate({
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.42,
        resetsAt: 1_800_000_000,
      }),
      { type: "assistant" },
      rate({
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.81,
        resetsAt: 1_800_000_000,
      }),
      rate({
        status: "allowed",
        rateLimitType: "seven_day",
        utilization: 37,
        resetsAt: 1_800_500_000_000,
      }),
      result,
    ]),
    NOW
  );
  check("Jetons par modèle tirés de modelUsage", run?.models["claude-opus-5-5"], {
    input: 1000,
    output: 500,
    cacheRead: 20000,
    cacheWrite: 3000,
    cost: 1.2,
  });
  check(
    "Coût estimé, tours et durée",
    [run?.cost, run?.turns, run?.durationMs],
    [1.234, 42, 600000]
  );
  check(
    "Quota : dernier état de chaque fenêtre, en %, remise à zéro en ms",
    run?.limits.map((l) => [l.type, l.status, l.used, l.resetsAt]),
    [
      ["five_hour", "allowed_warning", 81, 1_800_000_000_000],
      ["seven_day", "allowed", 37, 1_800_500_000_000],
    ]
  );
}
// Journal en lignes JSON, sans modelUsage ni relevé de quota
{
  const old = {
    ...result,
    modelUsage: undefined,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 },
  };
  const run = parseExecution(
    `${JSON.stringify({ type: "system" })}\n${JSON.stringify(old)}\n`,
    NOW
  );
  check("Lignes JSON, sans modelUsage : usage de la boucle principale", run?.models.claude, {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 0,
    cost: 1.234,
  });
  check("Sans relevé de quota : aucune fenêtre", run?.limits, []);
}
check(
  "Journal sans résultat : rien à relever",
  parseExecution(JSON.stringify([{ type: "assistant" }])),
  null
);
check("Journal illisible : rien à relever", parseExecution("pas du json"), null);
check(
  "Quota sans pourcentage : inconnu (null), pas 0",
  parseExecution(
    JSON.stringify([rate({ status: "rejected", rateLimitType: "five_hour" }), result]),
    NOW
  )?.limits[0].used,
  null
);

// Nettoyage de ce qu'envoie le workflow
{
  const clean = cleanRun(
    {
      models: { m: { input: -5, output: "x", cacheRead: 10, cacheWrite: Infinity, cost: 0.5 } },
      cost: 0.5,
      limits: [{ type: "five_hour", status: "allowed", used: 250, resetsAt: 1, at: NOW + 999 }],
    },
    NOW
  );
  check("Nettoyage : nombres négatifs, textes et infinis à 0", clean?.models.m, {
    input: 0,
    output: 0,
    cacheRead: 10,
    cacheWrite: 0,
    cost: 0.5,
  });
  check(
    "Nettoyage : % borné à 100, date du relevé pas dans le futur",
    [clean?.limits[0].used, clean?.limits[0].at],
    [100, NOW]
  );
  check("Nettoyage : relevé sans modèles refusé", cleanRun({ cost: 1 }), null);
}

// Totaux : jour (Paris), 7 et 30 jours, par modèle et par ticket
{
  const run = (tokens: number, cost: number, model = "opus"): RunUsage => ({
    models: { [model]: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost } },
    cost,
    turns: 1,
    durationMs: 1,
    limits: [],
  });
  const day = 86_400_000;
  const s = summarize(
    [
      { ticket: "a", at: NOW - 3600_000, run: run(100, 1) },
      { ticket: "a", at: NOW - 2 * day, run: run(200, 2) },
      { ticket: "b", at: NOW - 10 * day, run: run(400, 4, "sonnet") },
      { ticket: "c", at: NOW - 40 * day, run: run(800, 8) },
    ],
    [],
    NOW
  );
  check(
    "Totaux : aujourd'hui, 7 jours, 30 jours (au-delà ignoré)",
    [s.today.tokens, s.week.tokens, s.month.tokens, s.month.runs, s.month.cost],
    [100, 300, 700, 3, 7]
  );
  check(
    "Par modèle, le plus consommateur d'abord",
    s.byModel.map((m) => [m.model, m.tokens]),
    [
      ["sonnet", 400],
      ["opus", 300],
    ]
  );
  check(
    "Par ticket",
    s.byTicket.map((t) => [t.ticket, t.runs, t.tokens]),
    [
      ["b", 1, 400],
      ["a", 2, 300],
    ]
  );
}

// Relevés de quota : le plus récent de chaque fenêtre
check(
  "Quota : le relevé le plus récent l'emporte, les autres fenêtres restent",
  mergeLimits(
    [
      { type: "five_hour", status: "allowed", used: 10, resetsAt: 0, at: 1 },
      { type: "seven_day", status: "allowed", used: 20, resetsAt: 0, at: 1 },
    ],
    [{ type: "five_hour", status: "allowed_warning", used: 85, resetsAt: 0, at: 2 }]
  ).map((l) => [l.type, l.used]),
  [
    ["five_hour", 85],
    ["seven_day", 20],
  ]
);

console.log(`\n${passed} OK, ${failed} en échec`);
process.exit(failed ? 1 : 0);
