// Vérification des quotas Cloudflare du tableau de bord admin
// (worker/cloudflare-usage.ts) : calcul des chiffres du jour et des 7 jours,
// erreurs lisibles (secret absent, jeton refusé, Cloudflare injoignable).

import { billingPeriod, cloudflareUsage, summarize } from "../worker/cloudflare-usage.ts";

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

const day = "2026-11-17";
const raw = {
  w: [
    {
      sum: { requests: 500, errors: 2, cpuTimeUs: 2_000_000 },
      dimensions: { date: day, scriptName: "seancy", status: "success" },
    },
    {
      sum: { requests: 4, errors: 4, cpuTimeUs: 48_000 },
      dimensions: { date: day, scriptName: "seancy", status: "exceededCpu" },
    },
    {
      sum: { requests: 40, errors: 0, cpuTimeUs: 1000 },
      dimensions: { date: day, scriptName: "seancy-develop", status: "success" },
    },
    {
      sum: { requests: 900, errors: 9, cpuTimeUs: 1 },
      dimensions: { date: "2026-11-16", scriptName: "seancy", status: "success" },
    },
  ],
  ai: [
    {
      count: 3,
      sum: { totalNeurons: 120.6 },
      dimensions: { date: day, modelId: "@cf/meta/llama-3.1-8b-instruct" },
    },
    {
      count: 1,
      sum: { totalNeurons: 50 },
      dimensions: { date: "2026-11-16", modelId: "@cf/meta/llama-3.1-8b-instruct" },
    },
  ],
  d1: [
    { sum: { rowsRead: 1000, rowsWritten: 10 }, dimensions: { date: day, databaseId: "a" } },
    { sum: { rowsRead: 5, rowsWritten: 1 }, dimensions: { date: day, databaseId: "b" } },
    { sum: { rowsRead: 7, rowsWritten: 3 }, dimensions: { date: "2026-11-16", databaseId: "a" } },
  ],
  st: [
    {
      max: { databaseSizeBytes: 1000 },
      dimensions: { databaseId: "3403301e-2ef9-4f70-9f2e-e10d577beda0" },
    },
    { max: { databaseSizeBytes: 500 }, dimensions: { databaseId: "b" } },
  ],
};
const u = summarize(raw, day);
check("Requêtes du jour : tous les Workers du compte", u.requests, 544);
check("Requêtes par Worker, les plus nombreuses d'abord", u.byScript, [
  { name: "seancy", n: 504 },
  { name: "seancy-develop", n: 40 },
]);
check("Erreurs et dépassements de calcul du Worker seancy", [u.errors, u.exceededCpu], [6, 4]);
check("Temps de calcul moyen d'une requête de seancy (ms)", u.cpuMs, 4.06);
check(
  "Neurones et appels Workers AI du jour, par modèle",
  [u.neurons, u.aiCalls, u.byModel],
  [121, 3, [{ name: "meta/llama-3.1-8b-instruct", neurons: 121 }]]
);
check(
  "Lignes D1 lues et écrites du jour (toutes les bases)",
  [u.rowsRead, u.rowsWritten],
  [1005, 11]
);
check("Taille des bases : total et base de prod", [u.storage, u.prodStorage], [1500, 1000]);
check("7 derniers jours, le plus récent d'abord", u.history, [
  { date: day, requests: 544, errors: 6, neurons: 121, rowsWritten: 11 },
  { date: "2026-11-16", requests: 900, errors: 9, neurons: 50, rowsWritten: 3 },
]);

check(
  "Bases sans la liste D1 : celles qui ont une taille, la prod nommée et en tête",
  [u.dbNames, u.databases.map((d) => [d.name, d.prod, d.size, d.rowsRead, d.rowsWritten])],
  [
    false,
    [
      ["seancy-notifications", true, 1000, 0, 0],
      ["", false, 500, 5, 1],
    ],
  ]
);
const named = summarize(raw, day, [
  {
    uuid: "b",
    name: "seancy-develop",
    created_at: "2026-10-19T12:35:08Z",
    num_tables: 30,
    file_size: 600,
  },
  { uuid: "c", name: "seancy-preview-pr-344", num_tables: 30, file_size: 9000 },
  {
    uuid: "3403301e-2ef9-4f70-9f2e-e10d577beda0",
    name: "seancy-notifications",
    num_tables: 31,
    file_size: 2000,
  },
]);
check(
  "Bases avec la liste D1 : noms, tables, prod en tête puis la plus grosse, total recalculé",
  [
    named.dbNames,
    named.storage,
    named.prodStorage,
    named.databases.map((d) => [d.name, d.tables, d.size, d.rowsRead]),
  ],
  [
    true,
    11600,
    2000,
    [
      ["seancy-notifications", 31, 2000, 0],
      ["seancy-preview-pr-344", 30, 9000, 0],
      ["seancy-develop", 30, 600, 5],
    ],
  ]
);

// Forfait Workers Paid : période de facturation du 17 au 16, coût au-delà de l'inclus
check(
  "Période de facturation : le jour anniversaire, avant et après, mois courts",
  [
    billingPeriod("2026-11-17"),
    billingPeriod("2026-12-03"),
    billingPeriod("2027-01-16"),
    billingPeriod("2027-02-10", 31),
  ],
  [
    { from: "2026-11-17", renews: "2026-12-17" },
    { from: "2026-11-17", renews: "2026-12-17" },
    { from: "2026-12-17", renews: "2027-01-17" },
    { from: "2027-01-31", renews: "2027-02-28" },
  ]
);
check(
  "Rythme : 3 derniers jours complets de la période, sans le jour en cours",
  [
    u.month.perDay.requests,
    summarize(raw, "2026-11-20").month.perDay.requests,
    summarize(raw, "2026-11-20").month.perDay.rowsWritten,
  ],
  [0, 181, 4]
);
check(
  "Mois en cours le jour de l'abonnement : seulement ce jour",
  [u.month.from, u.month.requests, u.month.rowsRead, u.month.rowsWritten, u.month.cost.total],
  ["2026-11-17", 544, 1005, 11, 0]
);
{
  const big = summarize(
    {
      w: [
        {
          sum: { requests: 12_000_000, errors: 0, cpuTimeUs: 40_000_000_000 },
          dimensions: { date: "2026-11-20", scriptName: "seancy", status: "success" },
        },
        {
          sum: { requests: 1_000_000, errors: 0, cpuTimeUs: 0 },
          dimensions: { date: "2026-11-16", scriptName: "seancy", status: "success" },
        },
      ],
      ai: [
        {
          count: 1,
          sum: { totalNeurons: 12_000 },
          dimensions: { date: "2026-11-20", modelId: "@cf/m" },
        },
        {
          count: 1,
          sum: { totalNeurons: 9_000 },
          dimensions: { date: "2026-11-21", modelId: "@cf/m" },
        },
      ],
      d1: [
        {
          sum: { rowsRead: 1_000_000, rowsWritten: 52_000_000 },
          dimensions: { date: "2026-11-21", databaseId: "a" },
        },
      ],
      st: [{ max: { databaseSizeBytes: 6 * 1024 ** 3 }, dimensions: { databaseId: "a" } }],
    },
    "2026-12-01"
  );
  check(
    "Au-delà de l'inclus : coût estimé par poste (période commencée le 17, jour d'avant ignoré)",
    [big.month.requests, big.month.cpuMs, big.month.neuronsBilled, big.month.cost],
    [
      12_000_000,
      40_000_000,
      2_000,
      {
        requests: 0.6,
        cpuMs: 0.2,
        rowsRead: 0,
        rowsWritten: 2,
        storage: 0.75,
        neurons: 0.02,
        total: 3.57,
      },
    ]
  );
}

const main = async () => {
  const env = {};
  check("Sans secret : signalé comme réglage manquant", await cloudflareUsage(env), {
    error: "Secret CF_ANALYTICS_TOKEN absent",
    missing: true,
  });
  const withToken = { CF_ANALYTICS_TOKEN: "jeton" };
  const refused = await cloudflareUsage(withToken, 1, (async () =>
    Response.json(
      { data: null, errors: [{ message: "not authorized" }] },
      { status: 200 }
    )) as typeof fetch);
  check(
    "Jeton refusé : la permission à donner est dite",
    "error" in refused && /Account Analytics : Read/.test(refused.error),
    true
  );
  const down = await cloudflareUsage(withToken, 2, (async () => {
    throw new Error("réseau");
  }) as typeof fetch);
  check("Cloudflare injoignable", down, { error: "API Cloudflare injoignable" });
  let sent: RequestInit | undefined;
  const ok = await cloudflareUsage(withToken, Date.parse(`${day}T12:00:00Z`), (async (
    _u: string,
    init: RequestInit
  ) => {
    sent = init;
    return Response.json({ data: { viewer: { accounts: [raw] } }, errors: null });
  }) as typeof fetch);
  check("Réponse lue : chiffres du jour", "usage" in ok && ok.usage.requests, 544);
  check(
    "Jeton envoyé dans l'en-tête, période des 7 jours",
    [
      (sent?.headers as Record<string, string>).authorization,
      JSON.parse(String(sent?.body)).variables.from,
    ],
    ["Bearer jeton", "2026-11-11"]
  );

  console.log(`\n${passed} OK, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
};
void main();
