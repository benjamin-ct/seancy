// Vérification de la logique pure de lecture de CHANGELOG.md
// (src/modules/changelog/changelogParser.ts) — même principe que
// verify-changeset-parsing.ts. Pas de framework de test dans ce repo :
// script autonome.

import { parseChangelog } from "../src/modules/changelog/changelogParser.ts";

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

check("parseChangelog sur un fichier vide renvoie aucune release", parseChangelog(""), []);

check(
  "parseChangelog ignore l'en-tête avant la première release",
  parseChangelog("# Changelog\n\nFormat libre...\n"),
  []
);

check(
  "parseChangelog une release, une section, un item",
  parseChangelog(
    "# Changelog\n\n## 1.0.0 — 2026-10-10\n\n### Nouveautés\n\n- Première fonctionnalité.\n"
  ),
  [
    {
      version: "1.0.0",
      date: "2026-10-10",
      sections: [{ title: "Nouveautés", items: ["Première fonctionnalité."] }],
    },
  ]
);

check(
  "parseChangelog plusieurs releases, plusieurs sections",
  parseChangelog(
    "## 1.1.0 — 2026-10-11\n\n### Correctifs\n\n- Corrige un bug.\n\n## 1.0.0 — 2026-10-10\n\n### Nouveautés\n\n- Ajout.\n"
  ),
  [
    {
      version: "1.1.0",
      date: "2026-10-11",
      sections: [{ title: "Correctifs", items: ["Corrige un bug."] }],
    },
    {
      version: "1.0.0",
      date: "2026-10-10",
      sections: [{ title: "Nouveautés", items: ["Ajout."] }],
    },
  ]
);

check(
  "parseChangelog recolle les lignes de suite indentées au même point",
  parseChangelog(
    "## 1.0.1 — 2026-10-10\n\n### Correctifs\n\n- Première ligne.\n  Deuxième ligne.\n"
  ),
  [
    {
      version: "1.0.1",
      date: "2026-10-10",
      sections: [{ title: "Correctifs", items: ["Première ligne.\nDeuxième ligne."] }],
    },
  ]
);

check(
  "parseChangelog plusieurs sections dans la même release",
  parseChangelog(
    "## 2.0.0 — 2026-10-12\n\n### Changements majeurs\n\n- Cassant.\n\n### Nouveautés\n\n- Ajout.\n"
  ),
  [
    {
      version: "2.0.0",
      date: "2026-10-12",
      sections: [
        { title: "Changements majeurs", items: ["Cassant."] },
        { title: "Nouveautés", items: ["Ajout."] },
      ],
    },
  ]
);

if (failed > 0) {
  console.log(`\n${failed} échec(s) sur ${passed + failed} vérifications.`);
  process.exit(1);
}
console.log(`\n${passed} vérification(s) OK.`);
