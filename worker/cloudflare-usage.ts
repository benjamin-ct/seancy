// Quotas Cloudflare du compte, montrés sur le tableau de bord de l'espace admin
// (GET /api/admin/usage) : requêtes des Workers, neurones Workers AI, lignes
// lues et écrites dans D1, taille des bases, et les 7 derniers jours. Source :
// l'API d'analyse GraphQL de Cloudflare (mêmes chiffres que le tableau de bord
// Cloudflare), avec le secret CF_ANALYTICS_TOKEN (jeton « Account Analytics :
// Read » du compte, lecture seule ; avec aussi « D1 : Read », la liste des bases
// avec leur nom, leurs tables et leur taille). Forfait Workers Paid depuis le
// 17 nov. 2026 : volumes inclus par mois (période de facturation, remise à zéro
// le jour anniversaire de l'abonnement), facturés au-delà ; Workers AI garde
// 10 000 neurones gratuits par jour UTC. Comptés pour tout le compte (prod,
// develop, previews et autres Workers).

const ACCOUNT_ID = "96a41a5c3797a592a91ab5263c395f91";
// Base D1 de production (binding DB de wrangler.jsonc)
const PROD_DB = "3403301e-2ef9-4f70-9f2e-e10d577beda0";
/**
 * Forfait Workers Paid (https://developers.cloudflare.com/workers/platform/pricing/,
 * relevé en nov. 2026) : volume inclus par période de facturation, puis prix en $
 * par unité au-delà. Les neurones Workers AI restent gratuits par jour (UTC).
 */
export const PAID = {
  fee: 5,
  requests: { included: 10_000_000, price: 0.3 / 1e6 },
  cpuMs: { included: 30_000_000, price: 0.02 / 1e6 },
  rowsRead: { included: 25_000_000_000, price: 0.001 / 1e6 },
  rowsWritten: { included: 50_000_000, price: 1 / 1e6 },
  storage: { included: 5 * 1024 ** 3, price: 0.75 / 1024 ** 3 },
  neuronsPerDay: { included: 10_000, price: 0.011 / 1000 },
} as const;
/**
 * Jour du mois où le forfait a été pris (17 nov. 2026) : les volumes inclus
 * repartent de zéro ce jour-là chaque mois. Cloudflare → Facturation le dit
 * (lecture impossible avec le jeton d'analyse, sans permission Billing).
 */
export const BILLING_DAY = 17;

/** Début (inclus) et renouvellement de la période de facturation qui contient `day` (AAAA-MM-JJ, UTC). */
export function billingPeriod(
  day: string,
  billingDay = BILLING_DAY
): { from: string; renews: string } {
  const [y, m, d] = day.split("-").map(Number);
  // Jour d'anniversaire du mois (y, m0), ramené au dernier jour d'un mois trop court
  const at = (yy: number, m0: number) => {
    const last = new Date(Date.UTC(yy, m0 + 1, 0)).getUTCDate();
    return new Date(Date.UTC(yy, m0, Math.min(billingDay, last))).toISOString().slice(0, 10);
  };
  const thisMonth = at(y, m - 1);
  return d >= Number(thisMonth.slice(8))
    ? { from: thisMonth, renews: at(y, m) }
    : { from: at(y, m - 2), renews: thisMonth };
}

/** Base D1 du compte, avec son activité du jour. */
export interface Database {
  id: string;
  name: string;
  prod: boolean;
  created: string;
  tables: number | null;
  size: number;
  rowsRead: number;
  rowsWritten: number;
}
/** Base telle que la liste l'API D1 (GET /accounts/{id}/d1/database). */
export interface D1Info {
  uuid: string;
  name: string;
  created_at?: string;
  num_tables?: number;
  file_size?: number;
}

/** Période de facturation en cours : volumes utilisés et coût estimé au-delà de l'inclus ($). */
export interface Month {
  from: string;
  renews: string;
  requests: number;
  cpuMs: number;
  rowsRead: number;
  rowsWritten: number;
  /** Neurones au-delà des 10 000 gratuits de chaque jour. */
  neuronsBilled: number;
  cost: {
    requests: number;
    cpuMs: number;
    rowsRead: number;
    rowsWritten: number;
    storage: number;
    neurons: number;
    total: number;
  };
}

export interface Usage {
  day: string;
  month: Month;
  requests: number;
  byScript: { name: string; n: number }[];
  /** Worker seancy : erreurs et requêtes arrêtées pour dépassement de la limite de calcul. */
  errors: number;
  exceededCpu: number;
  /** Temps de calcul moyen d'une requête du Worker seancy (ms). */
  cpuMs: number;
  neurons: number;
  aiCalls: number;
  byModel: { name: string; neurons: number }[];
  rowsRead: number;
  rowsWritten: number;
  storage: number;
  prodStorage: number;
  /** Bases du compte : la plus grosse d'abord, la prod en tête. dbNames : noms connus (jeton avec « D1 : Read »). */
  databases: Database[];
  dbNames: boolean;
  history: {
    date: string;
    requests: number;
    errors: number;
    neurons: number;
    rowsWritten: number;
  }[];
}

interface Raw {
  w?: {
    sum: { requests: number; errors: number; cpuTimeUs: number };
    dimensions: { date: string; scriptName: string; status: string };
  }[];
  ai?: {
    count: number;
    sum: { totalNeurons: number };
    dimensions: { date: string; modelId: string };
  }[];
  d1?: {
    sum: { rowsRead: number; rowsWritten: number };
    dimensions: { date: string; databaseId: string };
  }[];
  st?: { max: { databaseSizeBytes: number }; dimensions: { databaseId: string } }[];
}

const QUERY = `query($a: string!, $from: Date!, $day: Date!) { viewer { accounts(filter: { accountTag: $a }) {
  w: workersInvocationsAdaptive(limit: 5000, filter: { date_geq: $from }) {
    sum { requests errors cpuTimeUs } dimensions { date scriptName status } }
  ai: aiInferenceAdaptiveGroups(limit: 2000, filter: { date_geq: $from }) {
    count sum { totalNeurons } dimensions { date modelId } }
  d1: d1AnalyticsAdaptiveGroups(limit: 2000, filter: { date_geq: $from }) {
    sum { rowsRead rowsWritten } dimensions { date databaseId } }
  st: d1StorageAdaptiveGroups(limit: 100, filter: { date_geq: $day }) {
    max { databaseSizeBytes } dimensions { databaseId } }
} } }`;

const top = <T>(m: Map<string, number>, f: (name: string, n: number) => T, n = 6) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => f(k, v));
const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

/** Réponse GraphQL (et liste des bases D1 si elle a pu être lue) → chiffres du jour (UTC) et des 7 derniers jours. */
export function summarize(
  raw: Raw,
  day: string,
  list: D1Info[] | null = null,
  worker = "seancy"
): Usage {
  const days = new Map<string, Usage["history"][number]>();
  const at = (date: string) => {
    let d = days.get(date);
    if (!d) {
      d = { date, requests: 0, errors: 0, neurons: 0, rowsWritten: 0 };
      days.set(date, d);
    }
    return d;
  };
  const scripts = new Map<string, number>();
  const models = new Map<string, number>();
  let errors = 0;
  let exceededCpu = 0;
  let cpuUs = 0;
  let ownRequests = 0;
  let aiCalls = 0;
  let rowsRead = 0;
  const dbRead = new Map<string, number>();
  const dbWritten = new Map<string, number>();
  const { from, renews } = billingPeriod(day);
  const month = { requests: 0, cpuUs: 0, rowsRead: 0, rowsWritten: 0 };
  for (const r of raw.w ?? []) {
    const { date, scriptName, status } = r.dimensions;
    at(date).requests += r.sum.requests;
    if (date >= from) {
      month.requests += r.sum.requests;
      month.cpuUs += r.sum.cpuTimeUs;
    }
    if (scriptName === worker) {
      at(date).errors += r.sum.errors;
    }
    if (date !== day) {
      continue;
    }
    add(scripts, scriptName, r.sum.requests);
    if (scriptName === worker) {
      errors += r.sum.errors;
      cpuUs += r.sum.cpuTimeUs;
      ownRequests += r.sum.requests;
      if (status === "exceededCpu") {
        exceededCpu += r.sum.requests;
      }
    }
  }
  for (const r of raw.ai ?? []) {
    at(r.dimensions.date).neurons += r.sum.totalNeurons;
    if (r.dimensions.date === day) {
      add(models, r.dimensions.modelId.replace(/^@cf\//, ""), r.sum.totalNeurons);
      aiCalls += r.count;
    }
  }
  for (const r of raw.d1 ?? []) {
    at(r.dimensions.date).rowsWritten += r.sum.rowsWritten;
    if (r.dimensions.date >= from) {
      month.rowsRead += r.sum.rowsRead;
      month.rowsWritten += r.sum.rowsWritten;
    }
    if (r.dimensions.date === day) {
      rowsRead += r.sum.rowsRead;
      add(dbRead, r.dimensions.databaseId, r.sum.rowsRead);
      add(dbWritten, r.dimensions.databaseId, r.sum.rowsWritten);
    }
  }
  const sizes = raw.st ?? [];
  const sizeOf = (id: string) =>
    sizes.find((r) => r.dimensions.databaseId === id)?.max.databaseSizeBytes ?? 0;
  // Liste des bases : celle de l'API D1 si elle a pu être lue, sinon les bases qui ont une taille aujourd'hui
  const databases: Database[] = (
    list ??
    sizes.map((r): D1Info => ({
      uuid: r.dimensions.databaseId,
      name: r.dimensions.databaseId === PROD_DB ? "seancy-notifications" : "",
    }))
  )
    .map((d) => ({
      id: d.uuid,
      name: d.name,
      prod: d.uuid === PROD_DB,
      created: d.created_at ?? "",
      tables: d.num_tables ?? null,
      size: d.file_size ?? sizeOf(d.uuid),
      rowsRead: dbRead.get(d.uuid) ?? 0,
      rowsWritten: dbWritten.get(d.uuid) ?? 0,
    }))
    .sort((a, b) => Number(b.prod) - Number(a.prod) || b.size - a.size);
  const today = at(day);
  const storage = list
    ? databases.reduce((s, d) => s + d.size, 0)
    : sizes.reduce((s, r) => s + r.max.databaseSizeBytes, 0);
  const neuronsBilled = Math.round(
    [...days.values()]
      .filter((d) => d.date >= from)
      .reduce((s, d) => s + Math.max(0, d.neurons - PAID.neuronsPerDay.included), 0)
  );
  const cpuMs = Math.round(month.cpuUs / 1000);
  const over = (used: number, p: { included: number; price: number }) =>
    Math.max(0, used - p.included) * p.price;
  const cost = {
    requests: over(month.requests, PAID.requests),
    cpuMs: over(cpuMs, PAID.cpuMs),
    rowsRead: over(month.rowsRead, PAID.rowsRead),
    rowsWritten: over(month.rowsWritten, PAID.rowsWritten),
    storage: over(storage, PAID.storage),
    neurons: neuronsBilled * PAID.neuronsPerDay.price,
  };
  const cents = (n: number) => Math.round(n * 100) / 100;
  return {
    day,
    month: {
      from,
      renews,
      requests: month.requests,
      cpuMs,
      rowsRead: month.rowsRead,
      rowsWritten: month.rowsWritten,
      neuronsBilled,
      cost: {
        requests: cents(cost.requests),
        cpuMs: cents(cost.cpuMs),
        rowsRead: cents(cost.rowsRead),
        rowsWritten: cents(cost.rowsWritten),
        storage: cents(cost.storage),
        neurons: cents(cost.neurons),
        total: cents(Object.values(cost).reduce((a, b) => a + b, 0)),
      },
    },
    requests: today.requests,
    byScript: top(scripts, (name, n) => ({ name, n })),
    errors,
    exceededCpu,
    cpuMs: ownRequests ? Math.round(cpuUs / ownRequests / 10) / 100 : 0,
    neurons: Math.round(today.neurons),
    aiCalls,
    byModel: top(models, (name, neurons) => ({ name, neurons: Math.round(neurons) })),
    rowsRead,
    rowsWritten: today.rowsWritten,
    storage,
    prodStorage: databases.find((d) => d.prod)?.size ?? 0,
    databases,
    dbNames: !!list,
    history: [...days.values()]
      .map((d) => ({ ...d, neurons: Math.round(d.neurons) }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 7),
  };
}

// Relu au plus toutes les 2 minutes (chaque ouverture du tableau de bord ne refait pas la requête)
let cache: { at: number; usage: Usage } | null = null;

/** Quotas du compte, ou une erreur lisible (secret absent, jeton refusé, Cloudflare injoignable). */
export async function cloudflareUsage(
  // Seulement les deux réglages utiles (pas tout Env : le fichier reste vérifiable seul, scripts/verify-cloudflare-usage.ts)
  env: { CF_ANALYTICS_TOKEN?: string; CF_ACCOUNT_ID?: string },
  now = Date.now(),
  fetchFn: typeof fetch = fetch
): Promise<{ usage: Usage } | { error: string; missing?: boolean }> {
  if (!env.CF_ANALYTICS_TOKEN) {
    return { error: "Secret CF_ANALYTICS_TOKEN absent", missing: true };
  }
  if (cache && now - cache.at < 120_000) {
    return { usage: cache.usage };
  }
  const day = new Date(now).toISOString().slice(0, 10);
  // Depuis le début de la période de facturation, et au moins les 7 derniers jours
  const week = new Date(now - 6 * 86_400_000).toISOString().slice(0, 10);
  const start = billingPeriod(day).from;
  const from = start < week ? start : week;
  const account = env.CF_ACCOUNT_ID || ACCOUNT_ID;
  const authorization = `Bearer ${env.CF_ANALYTICS_TOKEN}`;
  // Liste des bases en même temps (permission « D1 : Read » ; sans elle, seulement leurs identifiants)
  const listing = fetchFn(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database?per_page=100`,
    { headers: { authorization }, signal: AbortSignal.timeout(8000) }
  )
    .then(async (r) => {
      const d = (await r.json()) as { success?: boolean; result?: D1Info[] };
      return r.ok && d.success && Array.isArray(d.result) ? d.result : null;
    })
    .catch(() => null);
  const res = await fetchFn("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { a: account, from, day } }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!res) {
    return { error: "API Cloudflare injoignable" };
  }
  const body = (await res.json().catch(() => null)) as {
    data?: { viewer?: { accounts?: Raw[] } };
    errors?: { message: string }[] | null;
  } | null;
  const raw = body?.data?.viewer?.accounts?.[0];
  if (!res.ok || !raw) {
    const why = body?.errors?.[0]?.message || `HTTP ${res.status}`;
    return {
      error:
        res.status === 401 || res.status === 403 || /auth/i.test(why)
          ? `Jeton refusé par Cloudflare (${why}) : il doit avoir « Account Analytics : Read » sur le compte`
          : `Réponse de Cloudflare inattendue : ${why}`,
    };
  }
  cache = { at: now, usage: summarize(raw, day, await listing) };
  return { usage: cache.usage };
}
