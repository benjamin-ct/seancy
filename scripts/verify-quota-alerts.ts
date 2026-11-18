// Vérification des alertes de quota (worker/quota-alerts.ts) : volumes
// Cloudflare (80 %, rythme, épuisés), neurones du jour, quota de Claude, et
// envoi une seule fois. Script autonome, même principe que verify-tickets.ts.

import type { Usage } from "../worker/cloudflare-usage.ts";
import { claudeAlerts, cloudflareAlerts, newAlerts } from "../worker/quota-alerts.ts";

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

const usage = (m: Partial<Usage["month"]>, rest: Partial<Usage> = {}) =>
  ({
    day: "2026-11-27",
    neurons: 0,
    storage: 0,
    ...rest,
    month: {
      from: "2026-11-17",
      renews: "2026-12-17",
      requests: 0,
      cpuMs: 0,
      rowsRead: 0,
      rowsWritten: 0,
      ...m,
    },
  }) as Usage;
const keys = (a: { key: string; level: string }[]) => a.map((x) => `${x.key}`);
// 10 jours sur 30 écoulés
const NOW = Date.parse("2026-11-27T00:00:00Z");

check("Rien à signaler", cloudflareAlerts(usage({ requests: 1_000_000 }), NOW), []);
check(
  "80 % de l'inclus : alerte",
  keys(cloudflareAlerts(usage({ rowsWritten: 41_000_000 }), NOW)),
  ["cf:D1 · lignes écrites:2026-11-17:warn"]
);
{
  const pace = cloudflareAlerts(usage({ requests: 4_000_000 }), NOW);
  check(
    "40 % en un tiers du mois : épuisé avant la remise à zéro, date estimée",
    [keys(pace), /épuisé vers le 12 déc\./.test(pace[0]?.text ?? "")],
    [["cf:Requêtes des Workers:2026-11-17:warn"], true]
  );
}
check(
  "Moins de 3 jours écoulés : pas de projection sur un pic",
  cloudflareAlerts(usage({ requests: 4_000_000 }), Date.parse("2026-11-18T12:00:00Z")),
  []
);
check(
  "Inclus épuisé : alerte rouge, facturé",
  cloudflareAlerts(usage({ cpuMs: 31_000_000 }), NOW).map((a) => [a.level, /facturé/.test(a.text)]),
  [["bad", true]]
);
check(
  "Stockage : seuil de 80 %, sans projection",
  keys(cloudflareAlerts(usage({}, { storage: 4.5 * 1024 ** 3 }), NOW)),
  ["cf:D1 · stockage:2026-11-17:warn"]
);
check(
  "Neurones gratuits du jour : 80 % puis épuisés",
  [
    keys(cloudflareAlerts(usage({}, { neurons: 8_500 }), NOW)),
    keys(cloudflareAlerts(usage({}, { neurons: 10_200 }), NOW)),
  ],
  [["cf:neurons:2026-11-27:warn"], ["cf:neurons:2026-11-27:bad"]]
);

const reset = NOW + 3_600_000;
check(
  "Claude : 80 % ou alerte de Claude, puis atteint ; relevé périmé ignoré",
  claudeAlerts(
    [
      { type: "five_hour", status: "allowed", used: 85, resetsAt: reset, at: NOW },
      { type: "seven_day", status: "allowed_warning", used: null, resetsAt: reset, at: NOW },
      { type: "seven_day_opus", status: "rejected", used: null, resetsAt: reset, at: NOW },
      { type: "seven_day_sonnet", status: "allowed", used: 99, resetsAt: NOW - 1, at: NOW },
      { type: "overage", status: "allowed", used: 30, resetsAt: reset, at: NOW },
    ],
    NOW
  ).map((a) => [a.key, a.level]),
  [
    [`claude:five_hour:${reset}:warn`, "warn"],
    [`claude:seven_day:${reset}:warn`, "warn"],
    [`claude:seven_day_opus:${reset}:bad`, "bad"],
  ]
);

{
  const a = cloudflareAlerts(usage({ rowsWritten: 41_000_000 }), NOW);
  const first = newAlerts(a, []);
  const again = newAlerts(a, first.sent);
  check(
    "Une seule fois par seuil et par période",
    [first.fresh.length, again.fresh.length, again.sent.length],
    [1, 0, 1]
  );
}

console.log(`\n${passed} OK, ${failed} en échec`);
process.exit(failed ? 1 : 0);
