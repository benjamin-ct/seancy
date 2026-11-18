// Vérification de la logique pure des notes de série (src/core/lib/seriesRatings.ts)
// et de leur nettoyage côté serveur (worker/validate.ts) :
//   - saison = moyenne simple de ses épisodes notés, sinon note manuelle ;
//   - la moyenne des épisodes prend le dessus sur la note manuelle de la saison,
//     qui revient quand toutes les notes d'épisodes sont retirées ;
//   - série = moyenne des saisons (chaque saison compte pareil), saisons notées à
//     la main comprises, épisodes spéciaux (saison 0) exclus ; sinon note manuelle ;
//   - `rating` stocké = note effective arrondie à l'entier ; une entrée notée avant
//     les notes de saison/épisode garde sa note comme note manuelle ;
//   - le serveur ne garde que des clés et des notes (entiers de 1 à 10) valides.
//
// Pas de framework de test dans ce repo (voir verify-upcoming-badge.ts) : même
// principe, fonctions importées directement depuis les modules purs.

import {
  formatRating,
  seasonRating,
  seriesRating,
  withSeriesRating,
  type SeriesRatingFields,
} from "../src/core/lib/seriesRatings.ts";
import { sanitizeLibraryPayload, toPublicItem } from "../worker/validate.ts";
import type { LibraryItem } from "../src/core/types/library.ts";

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

// --- Saison -----------------------------------------------------------------

check("Saison sans note -> null", seasonRating({}, 1), {
  value: null,
  ratedEpisodes: 0,
  manual: null,
});
check("Saison notée à la main seulement", seasonRating({ seasonRatings: { "1": 8 } }, 1), {
  value: 8,
  ratedEpisodes: 0,
  manual: 8,
});
check(
  "Moyenne des épisodes de la saison (sans ceux des autres saisons)",
  seasonRating({ episodeRatings: { "1-1": 6, "1-2": 9, "2-1": 2, "11-1": 1 } }, 1),
  { value: 7.5, ratedEpisodes: 2, manual: null }
);
check(
  "La moyenne des épisodes prend le dessus sur la note manuelle",
  seasonRating({ seasonRatings: { "1": 3 }, episodeRatings: { "1-1": 8 } }, 1),
  { value: 8, ratedEpisodes: 1, manual: 3 }
);
check(
  "Toutes les notes d'épisodes retirées -> la note manuelle revient",
  seasonRating({ seasonRatings: { "1": 3 }, episodeRatings: {} }, 1),
  { value: 3, ratedEpisodes: 0, manual: 3 }
);

// --- Série ------------------------------------------------------------------

check(
  "Série = moyenne des saisons, pondérée par saison (pas par épisode)",
  seriesRating({ episodeRatings: { "1-1": 10, "1-2": 10, "1-3": 10, "2-1": 4 } }).value,
  7
);
check(
  "Saison notée à la main sans épisode noté : comptée dans la série",
  seriesRating({ seasonRatings: { "2": 6 }, episodeRatings: { "1-1": 9 } }),
  { value: 7.5, ratedSeasons: 2, manual: null }
);
check(
  "Épisodes spéciaux (saison 0) exclus de la note de la série",
  seriesRating({ episodeRatings: { "0-1": 1, "1-1": 9 } }).value,
  9
);
check(
  "La moyenne des saisons prend le dessus sur la note manuelle de la série",
  seriesRating({ manualRating: 4, seasonRatings: { "1": 8 } }),
  { value: 8, ratedSeasons: 1, manual: 4 }
);
check(
  "Sans saison notée -> note manuelle de la série",
  seriesRating({ manualRating: 4, episodeRatings: {} }),
  { value: 4, ratedSeasons: 0, manual: 4 }
);
check(
  "Entrée notée avant les notes de saison : `rating` = note manuelle",
  seriesRating({ rating: 7 }),
  { value: 7, ratedSeasons: 0, manual: 7 }
);
check(
  "manualRating à null : ne retombe pas sur `rating` (moyenne)",
  seriesRating({ rating: 8, manualRating: null }).manual,
  null
);

// --- Note stockée -----------------------------------------------------------

check(
  "withSeriesRating : moyenne arrondie et note manuelle figée",
  withSeriesRating({ rating: 5, episodeRatings: { "1-1": 7, "1-2": 8 } }),
  { rating: 8, episodeRatings: { "1-1": 7, "1-2": 8 }, manualRating: 5 }
);
check(
  "withSeriesRating : arrondi depuis la valeur affichée (7,45 -> 7,5 -> 8)",
  withSeriesRating<SeriesRatingFields>({
    manualRating: null,
    // Saison 1 : neuf épisodes à 7 et un à 6 -> 6,9 ; saison 2 notée 8 -> 7,45.
    episodeRatings: Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`1-${i + 1}`, i === 0 ? 6 : 7])
    ),
    seasonRatings: { "2": 8 },
  }).rating,
  8
);
check(
  "withSeriesRating : plus aucune note -> rating null",
  withSeriesRating<SeriesRatingFields>({ manualRating: null, episodeRatings: {} }).rating,
  null
);
check("formatRating fr : 7,5", formatRating(7.5, "fr-FR"), "7,5");
check("formatRating en : 7.3 (une décimale)", formatRating(7.333, "en-US"), "7.3");
check("formatRating : entier sans décimale", formatRating(8, "fr-FR"), "8");

// --- Nettoyage serveur ------------------------------------------------------

const clean = sanitizeLibraryPayload({
  watched: {
    "tv:1": {
      title: "Série",
      rating: 8,
      manualRating: null,
      seasonRatings: { "1": 9, x: 5, "2": 11, "3": 0, "4": 6.6 },
      episodeRatings: { "1-1": 7, "1": 4, "1-2": "8", "1-3": null },
    },
    "tv:2": { title: "Ancienne série", rating: 6 },
  },
  watchlist: {},
});
const series = clean.watched["tv:1"];
check("Serveur : manualRating null conservé", series?.manualRating, null);
check("Serveur : notes de saison valides seulement", series?.seasonRatings, { "1": 9, "4": 7 });
check("Serveur : notes d'épisode valides seulement", series?.episodeRatings, {
  "1-1": 7,
  "1-2": 8,
});
const legacy = clean.watched["tv:2"];
check(
  "Serveur : entrée sans notes de saison/épisode inchangée",
  [legacy?.manualRating, legacy?.seasonRatings, legacy?.episodeRatings],
  [undefined, undefined, undefined]
);
check(
  "Profil public : notes d'épisode/saison retirées, note du titre gardée",
  toPublicItem({
    id: 1,
    mediaType: "tv",
    title: "Série",
    posterPath: null,
    addedAt: 0,
    updatedAt: 0,
    rating: 8,
    manualRating: 5,
    seasonRatings: { "1": 8 },
    episodeRatings: { "1-1": 8 },
    watchedEpisodes: ["1-1"],
  } satisfies LibraryItem),
  { id: 1, mediaType: "tv", title: "Série", posterPath: null, addedAt: 0, updatedAt: 0, rating: 8 }
);

console.log(`\n${passed} OK, ${failed} échec(s)`);
if (failed > 0) {
  process.exit(1);
}
