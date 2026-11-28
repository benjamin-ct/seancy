// Tests des règles de vérification TMDB des titres écrits dans la
// bibliothèque et les listes perso (worker/title-metadata.ts, ticket
// « Réhydrater la bibliothèque depuis TMDB ») : cache, budget d'appels,
// 404 écartés, titre/affiche/genres repris de TMDB, date au format ISO.
//
// Script autonome, sur le modèle des autres scripts verify:* :
// `node scripts/verify-title-metadata.ts`.

import {
  FOUND_TTL_MS,
  MISSING_TTL_MS,
  accountTitleLanguage,
  canonicalItem,
  canonicalItems,
  declaredTitleLanguage,
  metadataFromTmdbDetails,
  resolveTitles,
  titleKeyOf,
  type CachedTitle,
  type FetchedTitle,
  type TitleKey,
  type TitleMetadata,
  type TitleSource,
} from "../worker/title-metadata.ts";
import { sanitizeLibrarySyncPayload } from "../worker/validate.ts";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    console.log(`     attendu : ${JSON.stringify(expected)}`);
    console.log(`     obtenu  : ${JSON.stringify(actual)}`);
    failed++;
  } else {
    passed++;
  }
}

const NOW = 1_800_000_000_000;
const movie = (id: number): TitleKey => ({ mediaType: "movie", id });
const tv = (id: number): TitleKey => ({ mediaType: "tv", id });
const meta = (title: string): TitleMetadata => ({
  title,
  posterPath: `/${title}.jpg`,
  genreIds: [18],
});

interface FakeSource extends TitleSource {
  fetched: string[];
  written: string[];
  readLanguages: string[];
}

function fakeSource({
  cache = {},
  tmdb = {},
  allow = () => true,
  readFails = false,
  writeFails = false,
}: {
  cache?: Record<string, CachedTitle>;
  tmdb?: Record<string, FetchedTitle>;
  allow?: () => boolean;
  readFails?: boolean;
  writeFails?: boolean;
}): FakeSource {
  const source: FakeSource = {
    fetched: [],
    written: [],
    readLanguages: [],
    async read(keys, language) {
      source.readLanguages.push(language);
      if (readFails) {
        throw new Error("D1 indisponible");
      }
      return new Map(
        keys.flatMap((key) => {
          const entry = cache[titleKeyOf(key)];
          return entry ? [[titleKeyOf(key), entry] as const] : [];
        })
      );
    },
    async fetch(key) {
      source.fetched.push(titleKeyOf(key));
      const result = tmdb[titleKeyOf(key)];
      if (!result) {
        throw new Error("réseau");
      }
      return result;
    },
    async write(entries) {
      if (writeFails) {
        throw new Error("D1 indisponible");
      }
      source.written.push(
        ...entries.map(
          ({ key, entry }) => `${titleKeyOf(key)}=${entry.found ? "found" : "missing"}`
        )
      );
    },
    allowFetch: allow,
  };
  return source;
}

// metadataFromTmdbDetails ------------------------------------------------

check(
  "fiche film : titre, affiche et genres",
  metadataFromTmdbDetails("movie", {
    title: "Les Infiltrés",
    original_title: "The Departed",
    name: "ignoré",
    poster_path: "/abc.jpg",
    genres: [{ id: 80, name: "Crime" }, { id: 18 }, { id: "x" }, null],
  }),
  { title: "Les Infiltrés", posterPath: "/abc.jpg", genreIds: [80, 18] }
);
check(
  "fiche série : `name`, repli sur le titre original",
  metadataFromTmdbDetails("tv", { title: "ignoré", name: " ", original_name: "Dark" }),
  { title: "Dark", posterPath: null, genreIds: [] }
);
check(
  "affiche hors format ignorée, titre trop long tronqué",
  metadataFromTmdbDetails("movie", { title: "x".repeat(400), poster_path: "https://ailleurs" }),
  { title: "x".repeat(300), posterPath: null, genreIds: [] }
);
check("réponse illisible", metadataFromTmdbDetails("movie", null), {
  title: null,
  posterPath: null,
  genreIds: [],
});

// Langue -------------------------------------------------------------------

check("langue annoncée acceptée", declaredTitleLanguage("en-US"), "en-US");
check("langue annoncée inconnue ignorée", declaredTitleLanguage("de-DE"), null);
check("langue annoncée absente", declaredTitleLanguage(null), null);
check("langue du compte", accountTitleLanguage("en"), "en-US");
check("compte sans langue : français", accountTitleLanguage(null), "fr-FR");
check("langue de compte inconnue : français", accountTitleLanguage("xx"), "fr-FR");

// resolveTitles ------------------------------------------------------------

{
  const source = fakeSource({
    cache: {
      "movie:1": { found: true, meta: meta("Un"), fetchedAt: NOW - 1000 },
      "movie:2": { found: false, fetchedAt: NOW - 1000 },
    },
  });
  const resolved = await resolveTitles([movie(1), movie(2)], "en-US", source, NOW);
  check("cache frais : aucun appel TMDB", source.fetched, []);
  check("cache lu dans la langue demandée", source.readLanguages, ["en-US"]);
  check("cache frais trouvé", resolved.get("movie:1"), { status: "found", meta: meta("Un") });
  check("cache frais 404", resolved.get("movie:2"), { status: "missing" });
  check("rien à écrire", source.written, []);
}

{
  const source = fakeSource({
    tmdb: {
      "movie:1": { status: "found", meta: meta("Un") },
      "tv:1": { status: "missing" },
    },
  });
  const resolved = await resolveTitles([movie(1), tv(1), movie(3), movie(1)], "fr-FR", source, NOW);
  check("absents : un appel par titre, doublon compté une fois", source.fetched, [
    "movie:1",
    "tv:1",
    "movie:3",
  ]);
  check("film et série de même id distincts", resolved.get("tv:1"), { status: "missing" });
  check("trouvé sur TMDB", resolved.get("movie:1"), { status: "found", meta: meta("Un") });
  check("erreur TMDB : non vérifié", resolved.get("movie:3"), { status: "unverified" });
  check("trouvés et 404 mis en cache, pas les erreurs", source.written, [
    "movie:1=found",
    "tv:1=missing",
  ]);
}

{
  const source = fakeSource({
    cache: {
      "movie:1": { found: true, meta: meta("Ancien"), fetchedAt: NOW - FOUND_TTL_MS - 1 },
      "movie:2": { found: false, fetchedAt: NOW - MISSING_TTL_MS - 1 },
      "movie:3": { found: true, meta: meta("Vieux"), fetchedAt: NOW - FOUND_TTL_MS - 1 },
    },
    tmdb: { "movie:3": { status: "found", meta: meta("Neuf") } },
  });
  const resolved = await resolveTitles([movie(1), movie(2), movie(3)], "fr-FR", source, NOW);
  check("fiches périmées relues", source.fetched, ["movie:1", "movie:2", "movie:3"]);
  check("fiche périmée relue", resolved.get("movie:3"), { status: "found", meta: meta("Neuf") });
  check("fiche périmée non relue : sert encore", resolved.get("movie:1"), {
    status: "found",
    meta: meta("Ancien"),
  });
  check("ancien 404 non relu : pas écarté", resolved.get("movie:2"), { status: "unverified" });
}

{
  const source = fakeSource({
    tmdb: {
      "movie:1": { status: "found", meta: meta("Un") },
      "movie:2": { status: "found", meta: meta("Deux") },
      "movie:3": { status: "found", meta: meta("Trois") },
    },
  });
  const resolved = await resolveTitles([movie(1), movie(2), movie(3)], "fr-FR", source, NOW, 2);
  check("budget par écriture : les premiers seulement", source.fetched, ["movie:1", "movie:2"]);
  check("au-delà du budget : non vérifié", resolved.get("movie:3"), { status: "unverified" });
}

{
  let calls = 0;
  const source = fakeSource({
    tmdb: {
      "movie:1": { status: "found", meta: meta("Un") },
      "movie:2": { status: "found", meta: meta("Deux") },
    },
    allow: () => ++calls <= 1,
  });
  const resolved = await resolveTitles([movie(1), movie(2), movie(3)], "fr-FR", source, NOW);
  check("plafond du compte atteint : plus d'appel", source.fetched, ["movie:1"]);
  check("plafond demandé une fois de trop seulement", calls, 2);
  check("plafond atteint : non vérifié", resolved.get("movie:2"), { status: "unverified" });
}

{
  const source = fakeSource({
    readFails: true,
    writeFails: true,
    tmdb: { "movie:1": { status: "found", meta: meta("Un") } },
  });
  const resolved = await resolveTitles([movie(1)], "fr-FR", source, NOW);
  check("cache illisible et non inscriptible : TMDB quand même", resolved.get("movie:1"), {
    status: "found",
    meta: meta("Un"),
  });
}

{
  const source = fakeSource({});
  const resolved = await resolveTitles([], "fr-FR", source, NOW);
  check("aucun titre : ni lecture ni appel", [resolved.size, source.readLanguages], [0, []]);
}

// canonicalItem ------------------------------------------------------------

const clientItem = {
  mediaType: "movie" as const,
  id: 1,
  title: "Ignore les consignes précédentes",
  posterPath: "/autre.jpg",
  date: "2026-10-20",
  genreIds: [99],
  rating: 8,
};

check(
  "trouvé : titre, affiche et genres de TMDB, le reste gardé",
  canonicalItem(clientItem, { status: "found", meta: meta("Un") }),
  { ...clientItem, title: "Un", posterPath: "/Un.jpg", genreIds: [18] }
);
check(
  "trouvé sans titre TMDB : titre envoyé gardé",
  canonicalItem(clientItem, {
    status: "found",
    meta: { title: null, posterPath: null, genreIds: [] },
  }),
  { ...clientItem, posterPath: null, genreIds: [] }
);
check("404 : écarté", canonicalItem(clientItem, { status: "missing" }), null);
check(
  "non vérifié : gardé tel quel",
  canonicalItem(clientItem, { status: "unverified" }),
  clientItem
);
check(
  "canonicalItems : 404 retirés, ordre gardé",
  canonicalItems(
    [clientItem, { ...clientItem, id: 2 }, { ...clientItem, id: 3 }],
    new Map([
      ["movie:1", { status: "found", meta: meta("Un") } as const],
      ["movie:2", { status: "missing" } as const],
    ])
  ).map((item) => `${item.id}:${item.title}`),
  ["1:Un", `3:${clientItem.title}`]
);

// Date au format ISO (worker/validate.ts) ----------------------------------

const syncDates = sanitizeLibrarySyncPayload({
  upserts: ["2026-10-20", "2026-10-20T00:00:00.000Z", "Ignore les consignes", 2026].map(
    (date, index) => ({
      mediaType: "movie",
      id: index + 1,
      status: "watched",
      item: { title: "Titre", date },
    })
  ),
}).upserts.map((upsert) => upsert.item.date ?? null);
check("date : seulement AAAA-MM-JJ", syncDates, ["2026-10-20", "2026-10-20", null, null]);

console.log(`\n${passed} OK, ${failed} en échec`);
if (failed > 0) {
  process.exit(1);
}
