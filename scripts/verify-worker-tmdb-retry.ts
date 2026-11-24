// Vérifie que tmdbFetch() côté Worker (worker/tmdb.ts) réessaie un 429 TMDB
// au lieu de le laisser remonter tel quel (issue Sentry 163541596 :
// getTheatricalIndex lance jusqu'à MAX_THEATRICAL_PAGES requêtes en
// parallèle par liste, et un seul 429 isolé faisait échouer tout
// /api/theatrical-index pour la région avant mise en cache).
//
// Pas de framework de test dans ce repo — script autonome, sur le modèle de
// scripts/verify-tmdb-retry-after.ts.

import { tmdbFetch } from "../worker/tmdb.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    console.log(`     attendu : ${JSON.stringify(expected)}`);
    console.log(`     obtenu  : ${JSON.stringify(actual)}`);
  }
  ok ? passed++ : failed++;
}

const env = { TMDB_API_KEY: "test-key" };
const realSetTimeout = globalThis.setTimeout;
// Le backoff réel (jusqu'à 2 s + 4 s) ralentirait ce script sans rien
// vérifier de plus : seul le nombre d'essais compte ici.
globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;

let calls = 0;
globalThis.fetch = (async () => {
  calls++;
  if (calls < 3) {
    return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as typeof fetch;

const result = await tmdbFetch<{ ok: boolean }>(env, "/movie/now_playing", { region: "US" });
check("réessaie après des 429 et renvoie la réponse finale", result, { ok: true });
check("deux réessais avant le succès", calls, 3);

calls = 0;
globalThis.fetch = (async () => {
  calls++;
  return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
}) as typeof fetch;

let threw = false;
try {
  await tmdbFetch(env, "/movie/upcoming", { region: "US" });
} catch (err) {
  threw = err instanceof Error && err.message === "Erreur TMDB (429) sur /movie/upcoming";
}
check("abandonne après MAX_RATE_LIMIT_RETRIES avec une erreur lisible", threw, true);
check("un essai initial + deux réessais, pas plus", calls, 3);

globalThis.setTimeout = realSetTimeout;

console.log(`\n${passed} OK, ${failed} FAIL`);
if (failed > 0) {
  process.exit(1);
}
