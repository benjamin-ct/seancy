// Tests unitaires des parties pures de worker/ai-suggestions.ts (suggestions
// IA « Pour vous ce soir », carte Trello "Worker AI pour l'algo V2") :
// lecture de la sortie du modèle et fin de journée calée sur Paris (durée de
// vie du lot du jour), changements d'heure compris.
//
// Pas de framework de test dans ce repo (aucun Jest/Vitest) : script
// autonome, exécutable avec `node scripts/verify-ai-suggestions.ts`, sur le
// même modèle que les autres scripts verify:*.

import { nextParisMidnight, parseSuggestions } from "../worker/ai-suggestions.ts";

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

check("liste numérotée simple", parseSuggestions("1. Heat (1995)\n2. Zodiac (2007)"), [
  { title: "Heat", year: 1995 },
  { title: "Zodiac", year: 2007 },
]);

check(
  "intro ignorée, puces, gras, parenthèses fermantes et plage d'années",
  parseSuggestions(
    "Voici mes suggestions :\n- **Mindhunter (2017)**\n3) True Detective (2014-2019)\n4. Le Cercle rouge (1970)"
  ),
  [
    { title: "Mindhunter", year: 2017 },
    { title: "True Detective", year: 2014 },
    { title: "Le Cercle rouge", year: 1970 },
  ]
);

check(
  "doublons (casse/accents) dédoublonnés, ligne sans année ignorée",
  parseSuggestions("1. Amélie (2001)\n2. amelie (2001)\n3. Sans année\n4. Amélie (1990)"),
  [
    { title: "Amélie", year: 2001 },
    { title: "Amélie", year: 1990 },
  ]
);

check(
  "au plus 12 titres gardés",
  parseSuggestions(
    Array.from({ length: 15 }, (_, i) => `${i + 1}. Titre ${i + 1} (${2000 + i})`).join("\n")
  ).length,
  12
);

check(
  "heure d'hiver : 22:30 UTC le 15/01 → minuit Paris = 23:00 UTC",
  new Date(nextParisMidnight(Date.UTC(2026, 0, 15, 22, 30))).toISOString(),
  "2026-01-15T23:00:00.000Z"
);

check(
  "heure d'été : 10:00 UTC le 15/07 → minuit Paris = 22:00 UTC",
  new Date(nextParisMidnight(Date.UTC(2026, 6, 15, 10, 0))).toISOString(),
  "2026-07-15T22:00:00.000Z"
);

check(
  "juste après minuit Paris (22:30 UTC en été) → minuit suivant",
  new Date(nextParisMidnight(Date.UTC(2026, 6, 15, 22, 30))).toISOString(),
  "2026-07-16T22:00:00.000Z"
);

check(
  "veille du passage à l'heure d'hiver (24/10, été) → minuit Paris = 22:00 UTC",
  new Date(nextParisMidnight(Date.UTC(2026, 9, 24, 12, 0))).toISOString(),
  "2026-10-24T22:00:00.000Z"
);

check(
  "jour du passage à l'heure d'hiver (25/10) → minuit Paris = 23:00 UTC",
  new Date(nextParisMidnight(Date.UTC(2026, 9, 25, 12, 0))).toISOString(),
  "2026-10-25T23:00:00.000Z"
);

console.log(`\n${passed} OK, ${failed} échec(s)`);
if (failed > 0) {
  process.exit(1);
}
