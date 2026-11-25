// Vérification de la logique pure de lecture des fragments de changelog
// (scripts/changesetLib.ts) — même principe que verify-favorite-iso-codes.ts.
// Pas de framework de test dans ce repo : script autonome.

import { isChangesetError, parseChangeset } from "./changesetLib.ts";

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

check(
  "Fragment valide (patch)",
  parseChangeset("x.md", "---\nbump: patch\n---\n\nCorrige un bug.\n"),
  { file: "x.md", bump: "patch", summary: "Corrige un bug." }
);

check(
  "Fragment valide (minor, description multi-lignes)",
  parseChangeset("x.md", "---\nbump: minor\n---\n\nNouvelle fonctionnalité.\nSur deux lignes.\n"),
  { file: "x.md", bump: "minor", summary: "Nouvelle fonctionnalité.\nSur deux lignes." }
);

check(
  "Frontmatter absent",
  isChangesetError(parseChangeset("x.md", "Pas de frontmatter du tout.\n")),
  true
);

check(
  "Bump invalide",
  isChangesetError(parseChangeset("x.md", "---\nbump: breaking\n---\n\nTexte.\n")),
  true
);

check("Bump absent", isChangesetError(parseChangeset("x.md", "---\n---\n\nTexte.\n")), true);

check(
  "Description vide",
  isChangesetError(parseChangeset("x.md", "---\nbump: major\n---\n\n   \n")),
  true
);

if (failed > 0) {
  console.log(`\n${failed} échec(s) sur ${passed + failed} vérifications.`);
  process.exit(1);
}
console.log(`\n${passed} vérification(s) OK.`);
