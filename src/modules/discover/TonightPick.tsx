import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { discover, getGenres } from "../../core/api/tmdb.ts";
import { useRegion } from "../../core/context/RegionContext.tsx";
import { useFavoriteProviders } from "../../core/context/FavoriteProvidersContext.tsx";
import { useExcludedGenres } from "../../core/context/ExcludedGenresContext.tsx";
import { useExcludedTitles } from "../../core/context/ExcludedTitlesContext.tsx";
import { useLibrary } from "../../core/context/LibraryContext.tsx";
import { useAuth } from "../../core/context/AuthContext.tsx";
import type { Genre, MediaItem } from "../../core/types/tmdb.ts";
import { storageGetJSON, storageSetJSON } from "../../shared/lib/storage.ts";
import AiTonightPick from "./AiTonightPick.tsx";
import TonightPickCard from "./TonightPickCard.tsx";
import styles from "./TonightPick.module.css";

// Parmi combien de films populaires on tire celui du soir : assez pour
// varier d'un jour à l'autre, assez peu pour rester sur des titres connus.
const PICK_POOL_SIZE = 10;
// Évite de mettre en avant un titre populaire mais quasi pas noté.
const MIN_VOTE_COUNT = 300;

// Titres écartés aujourd'hui via « Autre suggestion » : gardés pour la
// journée sur cet appareil (le tirage du jour étant stable, le même film
// reviendrait sinon à chaque visite), oubliés le lendemain.
const SKIPPED_KEY = "tonightPick.skipped";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function readSkipped(): number[] {
  const raw = storageGetJSON<{ date?: string; ids?: unknown } | null>(SKIPPED_KEY, null);
  return raw?.date === today() && Array.isArray(raw.ids)
    ? raw.ids.filter((id): id is number => typeof id === "number")
    : [];
}

function writeSkipped(ids: number[]) {
  storageSetJSON(SKIPPED_KEY, { date: today(), ids });
}

// Tirage stable sur la journée (même film à chaque visite du jour, un autre
// le lendemain) plutôt qu'un Math.random() qui changerait à chaque
// remontage de la page.
function dailyIndex(size: number): number {
  let hash = 0;
  for (const char of today()) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % size;
}

/** « Pour vous ce soir » (en tête de Découvrir) : suggestions IA du jour
 * pour un compte connecté (voir AiTonightPick et carte Trello "Worker AI
 * pour l'algo V2"). Un visiteur, sans historique côté serveur, garde le
 * tirage populaire côté client ci-dessous, qui sert aussi de repli si
 * l'endpoint des suggestions est injoignable. */
export default function TonightPick() {
  const { status } = useAuth();
  const [aiUnavailable, setAiUnavailable] = useState(false);
  const handleAiUnavailable = useCallback(() => setAiUnavailable(true), []);

  if (status === "loading") {
    return <div className={`${styles.hero} ${styles.placeholder}`} aria-hidden="true" />;
  }
  if (status === "authenticated" && !aiUnavailable) {
    return <AiTonightPick onUnavailable={handleAiUnavailable} />;
  }
  return <PopularTonightPick />;
}

/** Tirage populaire côté client : un film populaire et bien noté,
 * disponible sur vos plateformes si vous en avez choisi, hors genres/titres
 * exclus et films déjà vus. « Autre suggestion » écarte le film du jour (sur
 * cet appareil) et en tire un autre. */
function PopularTonightPick() {
  const { i18n } = useTranslation();
  const { region } = useRegion();
  const { favoriteProviderIds } = useFavoriteProviders();
  const { excludedGenreIds } = useExcludedGenres();
  const { filterExcluded } = useExcludedTitles();
  const { isWatched } = useLibrary();
  const [candidates, setCandidates] = useState<MediaItem[] | null>(null);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [skipped, setSkipped] = useState<number[]>(readSkipped);

  const favoritesKey = favoriteProviderIds.join(",");
  const excludedGenresKey = excludedGenreIds.join(",");

  useEffect(() => {
    let cancelled = false;
    discover("movie", {
      excludeGenreIds: excludedGenreIds,
      providerIds: favoriteProviderIds.length ? favoriteProviderIds : undefined,
      region,
      sortField: "popularity",
      excludeUpcoming: true,
      voteCountMin: MIN_VOTE_COUNT,
    })
      .then((data) => {
        if (!cancelled) {
          setCandidates(
            filterExcluded(data.results, "movie").map((r) => ({ ...r, mediaType: "movie" }))
          );
        }
      })
      .catch(() => !cancelled && setCandidates([]));
    getGenres("movie")
      .then((data) => !cancelled && setGenres(data.genres || []))
      .catch(() => !cancelled && setGenres([]));
    return () => {
      cancelled = true;
    };
    // Clés stables plutôt que les tableaux eux-mêmes (nouvelle référence à
    // chaque rendu des contextes) ; i18n.language : titres/synopsis TMDB
    // dans la langue active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, favoritesKey, excludedGenresKey, i18n.language]);

  const unwatched = (candidates ?? []).filter((c) => !isWatched("movie", c.id));
  // Les titres écartés laissent la place aux suivants dans l'ordre de
  // popularité ; une fois tout écarté, on repart du début.
  const remaining = unwatched.filter((c) => !skipped.includes(c.id));
  const pool = (remaining.length ? remaining : unwatched).slice(0, PICK_POOL_SIZE);
  const pick = pool[dailyIndex(pool.length)];

  if (candidates === null) {
    return <div className={`${styles.hero} ${styles.placeholder}`} aria-hidden="true" />;
  }
  if (unwatched.length === 0) {
    return null;
  }

  function skip() {
    const next = remaining.length > 1 ? [...skipped, pick.id] : [pick.id];
    setSkipped(next);
    writeSkipped(next);
  }

  return (
    <TonightPickCard
      mediaType="movie"
      item={pick}
      genreIds={pick.genre_ids || []}
      genreName={genres.find((g) => g.id === pick.genre_ids?.[0])?.name}
      onSkip={skip}
    />
  );
}
