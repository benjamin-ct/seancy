// Audit des dépendances de la CI (ci.yml) : `npm audit`, avec des
// exceptions datées pour un avis qui n'a pas encore de version corrigée.
//
//   node scripts/audit.ts high       (PR)
//   node scripts/audit.ts moderate   (develop, avant une release)
//
// Une exception ne vaut que pour l'avis nommé, jusqu'à sa date, et tant
// qu'aucun correctif simple n'existe : dès que `npm audit fix` sait corriger
// sans version majeure, l'audit bloque de nouveau (le correctif est à mettre).
// Toute autre alerte au niveau demandé bloque.

import { execFileSync } from "node:child_process";

/** Avis ignorés jusqu'à la date donnée (incluse), avec la raison. */
export const EXCEPTIONS: Record<string, { until: string; why: string }> = {
  "GHSA-fc5q-39xc-vjpf": {
    until: "2026-12-17",
    why: "picomatch (ReDoS sur des motifs de fichiers, outils de construction) : aucune version corrigée publiée le 17 nov. 2026",
  },
};

const LEVELS = ["info", "low", "moderate", "high", "critical"];

interface Via {
  source?: number;
  url?: string;
  title?: string;
  severity?: string;
}
export interface AuditReport {
  vulnerabilities?: Record<
    string,
    {
      severity: string;
      via: (string | Via)[];
      /** true : `npm audit fix` corrige sans version majeure ; objet : seulement via un changement majeur. */
      fixAvailable?: boolean | { name: string; version: string; isSemVerMajor: boolean };
    }
  >;
}

/** Avis au niveau demandé ou au-dessus qui bloquent (exceptions expirées comprises). */
export function blocking(
  report: AuditReport,
  level: string,
  today: string,
  exceptions = EXCEPTIONS
): { id: string; title: string; why: string }[] {
  const min = LEVELS.indexOf(level);
  const found = new Map<string, { id: string; title: string; why: string }>();
  for (const v of Object.values(report.vulnerabilities ?? {})) {
    for (const via of v.via) {
      // Une chaîne : dépend d'un autre paquet vulnérable, dont l'avis est compté chez lui
      if (typeof via === "string" || LEVELS.indexOf(via.severity ?? "") < min) {
        continue;
      }
      const id = /GHSA-[\w-]+/.exec(via.url ?? "")?.[0] ?? String(via.source ?? "?");
      const ex = exceptions[id];
      const fixed = v.fixAvailable === true;
      if (ex && today <= ex.until && !fixed) {
        continue;
      }
      found.set(id, {
        id,
        title: via.title ?? "",
        why: !ex
          ? `${via.severity}`
          : fixed
            ? "correctif disponible : lancer npm audit fix, puis retirer l'exception"
            : `exception expirée le ${ex.until}`,
      });
    }
  }
  return [...found.values()];
}

const main = () => {
  const level = process.argv[2] || "high";
  if (!LEVELS.includes(level)) {
    console.error(`Niveau inconnu : ${level} (${LEVELS.join(", ")})`);
    process.exit(2);
  }
  let raw = "";
  try {
    raw = execFileSync("npm", ["audit", "--json"], { encoding: "utf8" });
  } catch (err) {
    // npm audit sort en erreur dès qu'il trouve une alerte : le rapport est dans stdout
    raw = (err as { stdout?: string }).stdout ?? "";
  }
  const report = JSON.parse(raw || "{}") as AuditReport;
  const today = new Date().toISOString().slice(0, 10);
  for (const [id, ex] of Object.entries(EXCEPTIONS)) {
    console.log(
      `Exception ${id} jusqu'au ${ex.until}${today > ex.until ? " (EXPIRÉE)" : ""} : ${ex.why}`
    );
  }
  const bad = blocking(report, level, today);
  if (bad.length) {
    console.error(`\n${bad.length} alerte(s) bloquante(s) au niveau « ${level} » :`);
    for (const b of bad) {
      console.error(`- ${b.id} (${b.why}) ${b.title}`);
    }
    console.error("\nDétail : npm audit");
    process.exit(1);
  }
  console.log(`\nAudit « ${level} » : aucune alerte bloquante.`);
};

// Lancé directement (pas importé par verify-audit.ts)
if (/(^|[\\/])audit\.ts$/.test(process.argv[1] ?? "")) {
  main();
}
