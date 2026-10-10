// Vérification de la logique pure de compilation du changelog
// (scripts/changelogRelease.ts) — même principe que verify-changeset-parsing.ts.
// Pas de framework de test dans ce repo : script autonome.

import {
  aggregateBump,
  bumpVersion,
  formatChangelogEntry,
  planRelease,
} from "./changelogRelease.ts";
import type { Changeset } from "./changesetLib.ts";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    console.log(`     attendu: ${JSON.stringify(expected)}`);
    console.log(`     obtenu : ${JSON.stringify(actual)}`);
  }
  ok ? passed++ : failed++;
}

function cs(bump: Changeset["bump"], summary: string, file = `${bump}.md`): Changeset {
  return { file, bump, summary };
}

// bumpVersion ----------------------------------------------------------
check("bumpVersion patch", bumpVersion("1.2.3", "patch"), "1.2.4");
check("bumpVersion minor remet patch à 0", bumpVersion("1.2.3", "minor"), "1.3.0");
check("bumpVersion major remet minor+patch à 0", bumpVersion("1.2.3", "major"), "2.0.0");
check("bumpVersion depuis 0.0.0", bumpVersion("0.0.0", "minor"), "0.1.0");

// aggregateBump ----------------------------------------------------------
check("aggregateBump un seul patch", aggregateBump([cs("patch", "x")]), "patch");
check(
  "aggregateBump le plus fort l'emporte (patch + minor → minor)",
  aggregateBump([cs("patch", "x"), cs("minor", "y")]),
  "minor"
);
check(
  "aggregateBump major l'emporte sur tout",
  aggregateBump([cs("patch", "x"), cs("major", "y"), cs("minor", "z")]),
  "major"
);

// formatChangelogEntry ----------------------------------------------------
check(
  "formatChangelogEntry groupe par section, major puis minor puis patch",
  formatChangelogEntry("1.1.0", "2026-10-10", [
    cs("patch", "Corrige un bug."),
    cs("minor", "Nouvelle fonctionnalité."),
  ]),
  "## 1.1.0 — 2026-10-10\n\n### Nouveautés\n\n- Nouvelle fonctionnalité.\n\n### Correctifs\n\n- Corrige un bug.\n"
);

check(
  "formatChangelogEntry description multi-lignes indentée sous le même point",
  formatChangelogEntry("1.0.1", "2026-10-10", [cs("patch", "Première ligne.\nDeuxième ligne.")]),
  "## 1.0.1 — 2026-10-10\n\n### Correctifs\n\n- Première ligne.\n  Deuxième ligne.\n"
);

// planRelease --------------------------------------------------------------
check("planRelease sans fragment renvoie null", planRelease("1.0.0", [], "2026-10-10"), null);

check(
  "planRelease avec fragments renvoie la version suivante et l'entrée",
  planRelease("1.0.0", [cs("minor", "Ajout.")], "2026-10-10"),
  {
    nextVersion: "1.1.0",
    changelogEntry: "## 1.1.0 — 2026-10-10\n\n### Nouveautés\n\n- Ajout.\n",
  }
);

if (failed > 0) {
  console.log(`\n${failed} échec(s) sur ${passed + failed} vérifications.`);
  process.exit(1);
}
console.log(`\n${passed} vérification(s) OK.`);
