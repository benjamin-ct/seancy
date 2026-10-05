// Tests unitaires des utilitaires PURS de métadonnées film/série
// (src/core/api/movieMeta.ts) : durée estimée, date de sortie ciné FR,
// formatage de date lisible, statut "au cinéma".
//
// Pas de framework de test dans ce repo (aucun Jest/Vitest) : script
// autonome, exécutable avec `node scripts/verify-movie-meta.ts` (Node
// exécute le TypeScript nativement, sans étape de build), sur le même
// modèle que verify-upcoming-badge.ts. Les fonctions sont IMPORTÉES
// directement depuis movieMeta.ts (module pur, sans `import.meta.env` ni
// réseau, chargeable sous Node nu) : aucune copie à synchroniser.

import {
  estimateRuntimeMinutes,
  getTheatricalDateFromDetails,
  formatFullDate,
  dateLocaleTag,
  theatricalStatusFromDate,
} from "../src/core/api/movieMeta.ts";

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

const daysFromNow = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

// --- estimateRuntimeMinutes ---------------------------------------------

check("Film : runtime renvoyé tel quel", estimateRuntimeMinutes({ runtime: 128 }, "movie"), 128);
check("Film : runtime absent -> null", estimateRuntimeMinutes({ runtime: 0 }, "movie"), null);
check(
  "Série : durée épisode × nombre d'épisodes",
  estimateRuntimeMinutes({ episode_run_time: [42], number_of_episodes: 10 }, "tv"),
  420
);
check(
  "Série : episode_run_time manquant -> null",
  estimateRuntimeMinutes({ number_of_episodes: 10 }, "tv"),
  null
);
check(
  "Série : number_of_episodes manquant -> null",
  estimateRuntimeMinutes({ episode_run_time: [42] }, "tv"),
  null
);
check(
  "Série : episode_run_time vide -> repli sur last_episode_to_air.runtime (Breaking Bad)",
  estimateRuntimeMinutes(
    {
      episode_run_time: [],
      number_of_episodes: 62,
      last_episode_to_air: { runtime: 56, season_number: 5, episode_number: 16 },
    },
    "tv"
  ),
  3472
);
check(
  "Série : episode_run_time et last_episode_to_air absents -> repli sur next_episode_to_air.runtime",
  estimateRuntimeMinutes(
    {
      number_of_episodes: 10,
      next_episode_to_air: { runtime: 45, season_number: 1, episode_number: 3 },
    },
    "tv"
  ),
  450
);
check(
  "Série : aucune source de durée -> null",
  estimateRuntimeMinutes(
    {
      number_of_episodes: 10,
      last_episode_to_air: { runtime: null, season_number: 1, episode_number: 9 },
    },
    "tv"
  ),
  null
);
check("Détails null -> null (pas de crash)", estimateRuntimeMinutes(null, "movie"), null);

// --- getTheatricalDateFromDetails ---------------------------------------

check(
  "FR type 3 (sortie nationale) prioritaire sur type 2",
  getTheatricalDateFromDetails({
    release_dates: {
      results: [
        {
          iso_3166_1: "FR",
          release_dates: [
            { type: 2, release_date: "2026-01-10T00:00:00.000Z" },
            { type: 3, release_date: "2026-02-15T00:00:00.000Z" },
          ],
        },
      ],
    },
  }),
  "2026-02-15"
);
check(
  "FR : aucun type 3, repli sur type 2 (la plus ancienne)",
  getTheatricalDateFromDetails({
    release_dates: {
      results: [
        {
          iso_3166_1: "FR",
          release_dates: [
            { type: 2, release_date: "2026-04-20T00:00:00.000Z" },
            { type: 2, release_date: "2026-03-01T00:00:00.000Z" },
          ],
        },
      ],
    },
  }),
  "2026-03-01"
);
check(
  "Plusieurs type 3 -> la plus ancienne",
  getTheatricalDateFromDetails({
    release_dates: {
      results: [
        {
          iso_3166_1: "FR",
          release_dates: [
            { type: 3, release_date: "2026-06-10T00:00:00.000Z" },
            { type: 3, release_date: "2026-05-05T00:00:00.000Z" },
          ],
        },
      ],
    },
  }),
  "2026-05-05"
);
check(
  "Pas d'entrée pour la région par défaut (FR) -> null",
  getTheatricalDateFromDetails({
    release_dates: {
      results: [
        {
          iso_3166_1: "US",
          release_dates: [{ type: 3, release_date: "2026-01-01T00:00:00.000Z" }],
        },
      ],
    },
  }),
  null
);
check(
  "Région explicite (US) -> lit l'entrée US, pas FR",
  getTheatricalDateFromDetails(
    {
      release_dates: {
        results: [
          {
            iso_3166_1: "FR",
            release_dates: [{ type: 3, release_date: "2026-02-15T00:00:00.000Z" }],
          },
          {
            iso_3166_1: "US",
            release_dates: [{ type: 3, release_date: "2026-01-01T00:00:00.000Z" }],
          },
        ],
      },
    },
    "US"
  ),
  "2026-01-01"
);
check(
  "FR sans sortie ciné (type 3/2 absents) -> null",
  getTheatricalDateFromDetails({
    release_dates: {
      results: [
        {
          iso_3166_1: "FR",
          release_dates: [{ type: 4, release_date: "2026-01-01T00:00:00.000Z" }],
        },
      ],
    },
  }),
  null
);
check("release_dates absent -> null (pas de crash)", getTheatricalDateFromDetails({}), null);
check("details null -> null (pas de crash)", getTheatricalDateFromDetails(null), null);

// --- formatFullDate ------------------------------------------------------

check(
  "Date valide, locale par défaut -> format long fr-FR",
  formatFullDate("2026-09-12"),
  "12 septembre 2026"
);
check(
  "Date valide, locale fr explicite -> format long fr-FR",
  formatFullDate("2026-09-12", "fr"),
  "12 septembre 2026"
);
check(
  "Date valide, locale en -> format long en-US",
  formatFullDate("2026-09-12", "en"),
  "September 12, 2026"
);
check("Date null -> null", formatFullDate(null), null);
check("Chaîne vide -> null", formatFullDate(""), null);
check("Date invalide -> null", formatFullDate("pas-une-date"), null);

// --- dateLocaleTag ---------------------------------------------------------

check("Tag BCP47 pour fr", dateLocaleTag("fr"), "fr-FR");
check("Tag BCP47 pour en", dateLocaleTag("en"), "en-US");

// --- theatricalStatusFromDate -------------------------------------------

check("Sortie future -> upcoming", theatricalStatusFromDate(daysFromNow(10)), "upcoming");
check(
  "Sortie il y a 5 jours (< 42) -> in_theaters",
  theatricalStatusFromDate(daysFromNow(-5)),
  "in_theaters"
);
check(
  "Sortie il y a 100 jours (> 42) -> past",
  theatricalStatusFromDate(daysFromNow(-100)),
  "past"
);
check(
  "Sortie récente (40 jours, < 42) -> in_theaters",
  theatricalStatusFromDate(daysFromNow(-40)),
  "in_theaters"
);
check("Date absente -> null", theatricalStatusFromDate(null), null);

console.log(`\n${passed} test(s) passé(s), ${failed} échoué(s).`);
process.exit(failed > 0 ? 1 : 0);
