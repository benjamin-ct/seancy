// Vérification de la logique pure de validation des codes ISO langue/pays
// favoris (worker/validate.ts, sanitizeIsoCodeList) — même principe que
// sanitizeIdList pour les plateformes/genres favoris, mais pour des chaînes.
//
// Pas de framework de test dans ce repo : script autonome, sur le même
// modèle que verify-numeric-range-filter.ts.

import {
  sanitizeIsoCodeList,
  LANGUAGE_CODE_PATTERN,
  COUNTRY_CODE_PATTERN,
} from "../worker/validate.ts";

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
  "Codes langue valides conservés",
  sanitizeIsoCodeList(["fr", "en", "ja"], LANGUAGE_CODE_PATTERN),
  ["fr", "en", "ja"]
);

check(
  "Codes langue mal formés écartés (majuscules, longueur, non-chaîne)",
  sanitizeIsoCodeList(["fr", "FR", "fra", "f", 12, null, "en"], LANGUAGE_CODE_PATTERN),
  ["fr", "en"]
);

check(
  "Codes pays valides conservés",
  sanitizeIsoCodeList(["FR", "US", "JP"], COUNTRY_CODE_PATTERN),
  ["FR", "US", "JP"]
);

check(
  "Codes pays mal formés écartés (minuscules, longueur)",
  sanitizeIsoCodeList(["FR", "fr", "USA", "F", "US"], COUNTRY_CODE_PATTERN),
  ["FR", "US"]
);

check("Doublons dédupliqués", sanitizeIsoCodeList(["FR", "FR", "US"], COUNTRY_CODE_PATTERN), [
  "FR",
  "US",
]);

check("Entrée non tableau -> liste vide", sanitizeIsoCodeList("FR", COUNTRY_CODE_PATTERN), []);

check(
  "Liste tronquée à MAX_ID_LIST (500) entrées valides distinctes",
  sanitizeIsoCodeList(
    Array.from(
      { length: 600 },
      (_, i) => String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26))
    ),
    COUNTRY_CODE_PATTERN
  ).length,
  500
);

console.log(`\n${passed} test(s) passé(s), ${failed} échoué(s).`);
process.exit(failed > 0 ? 1 : 0);
