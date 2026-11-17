// Vérification de l'audit des dépendances de la CI (scripts/audit.ts) :
// exceptions datées, niveaux, avis hérités. Script autonome, même principe
// que verify-tickets.ts.

import { blocking, type AuditReport } from "./audit.ts";

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

const advisory = (id: string, severity: string) => ({
  source: 1,
  url: `https://github.com/advisories/${id}`,
  title: `avis ${id}`,
  severity,
});
const report: AuditReport = {
  vulnerabilities: {
    picomatch: { severity: "high", via: [advisory("GHSA-aaaa-bbbb-cccc", "high")] },
    vite: { severity: "high", via: ["picomatch"] },
    other: { severity: "moderate", via: [advisory("GHSA-dddd-eeee-ffff", "moderate")] },
  },
};
const ex = { "GHSA-aaaa-bbbb-cccc": { until: "2026-12-17", why: "test" } };
const ids = (r: { id: string }[]) => r.map((x) => x.id);

check("Sans exception : l'avis high bloque", ids(blocking(report, "high", "2026-11-17", {})), [
  "GHSA-aaaa-bbbb-cccc",
]);
check(
  "Exception valide : rien ne bloque au niveau high",
  ids(blocking(report, "high", "2026-11-17", ex)),
  []
);
check(
  "Exception le dernier jour : encore valide",
  ids(blocking(report, "high", "2026-12-17", ex)),
  []
);
check(
  "Exception expirée : l'avis bloque de nouveau",
  blocking(report, "high", "2026-12-18", ex).map((x) => [x.id, x.why]),
  [["GHSA-aaaa-bbbb-cccc", "exception expirée le 2026-12-17"]]
);
check(
  "Niveau moderate : l'autre avis bloque, l'exception tient",
  ids(blocking(report, "moderate", "2026-11-17", ex)),
  ["GHSA-dddd-eeee-ffff"]
);
check(
  "Paquet qui dépend d'un vulnérable : pas compté deux fois",
  blocking(report, "high", "2026-11-17", {}).length,
  1
);
check("Rapport vide : rien ne bloque", blocking({}, "high", "2026-11-17", ex), []);
check(
  "Correctif seulement par une version majeure : l'exception tient",
  ids(
    blocking(
      {
        vulnerabilities: {
          picomatch: {
            ...report.vulnerabilities!.picomatch,
            fixAvailable: { name: "vite", version: "6.2.7", isSemVerMajor: true },
          },
        },
      },
      "high",
      "2026-11-17",
      ex
    )
  ),
  []
);
check(
  "Correctif simple publié : l'exception tombe, avec la marche à suivre",
  blocking(
    {
      vulnerabilities: {
        picomatch: { ...report.vulnerabilities!.picomatch, fixAvailable: true },
      },
    },
    "high",
    "2026-11-17",
    ex
  ).map((x) => [x.id, /npm audit fix/.test(x.why)]),
  [["GHSA-aaaa-bbbb-cccc", true]]
);

console.log(`\n${passed} OK, ${failed} en échec`);
process.exit(failed ? 1 : 0);
