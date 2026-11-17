// Quotas Cloudflare du compte, montrés sur le tableau de bord de l'espace admin
// (GET /api/admin/usage) : requêtes des Workers, neurones Workers AI, lignes
// lues et écrites dans D1, taille des bases, et les 7 derniers jours. Source :
// l'API d'analyse GraphQL de Cloudflare (mêmes chiffres que le tableau de bord
// Cloudflare), avec le secret CF_ANALYTICS_TOKEN (jeton « Account Analytics :
// Read » du compte, lecture seule). Les quotas gratuits sont comptés par jour
// UTC pour tout le compte (prod, develop, previews et autres Workers).

const ACCOUNT_ID = "96a41a5c3797a592a91ab5263c395f91";
// Base D1 de production (binding DB de wrangler.jsonc)
const PROD_DB = "3403301e-2ef9-4f70-9f2e-e10d577beda0";
/** Forfait gratuit Workers (https://developers.cloudflare.com/workers/platform/pricing/). */
export const FREE = {
  requests: 100_000,
  neurons: 10_000,
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
  storage: 5 * 1024 ** 3,
};

export interface Usage {
  day: string;
  requests: number;
  byScript: { name: string; n: number }[];
  /** Worker seancy : erreurs et requêtes arrêtées pour dépassement des 10 ms de calcul. */
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
  w: workersInvocationsAdaptive(limit: 2000, filter: { date_geq: $from }) {
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

/** Réponse GraphQL → chiffres du jour (UTC) et des 7 derniers jours. */
export function summarize(raw: Raw, day: string, worker = "seancy"): Usage {
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
  for (const r of raw.w ?? []) {
    const { date, scriptName, status } = r.dimensions;
    at(date).requests += r.sum.requests;
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
    if (r.dimensions.date === day) {
      rowsRead += r.sum.rowsRead;
    }
  }
  const sizes = raw.st ?? [];
  const today = at(day);
  return {
    day,
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
    storage: sizes.reduce((s, r) => s + r.max.databaseSizeBytes, 0),
    prodStorage: sizes.find((r) => r.dimensions.databaseId === PROD_DB)?.max.databaseSizeBytes ?? 0,
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
  const from = new Date(now - 6 * 86_400_000).toISOString().slice(0, 10);
  const res = await fetchFn("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { a: env.CF_ACCOUNT_ID || ACCOUNT_ID, from, day },
    }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!res) {
    return { error: "API Cloudflare injoignable" };
  }
  const body = (await res.json().catch(() => null)) as {
    data?: { viewer?: { accounts?: Raw[] } };
    errors?: { message: string }[] | null;
  } | null;
  const account = body?.data?.viewer?.accounts?.[0];
  if (!res.ok || !account) {
    const why = body?.errors?.[0]?.message || `HTTP ${res.status}`;
    return {
      error:
        res.status === 401 || res.status === 403 || /auth/i.test(why)
          ? `Jeton refusé par Cloudflare (${why}) : il doit avoir « Account Analytics : Read » sur le compte`
          : `Réponse de Cloudflare inattendue : ${why}`,
    };
  }
  cache = { at: now, usage: summarize(account, day) };
  return { usage: cache.usage };
}
