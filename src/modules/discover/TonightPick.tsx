import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { backdropUrl, discover, getGenres, posterSrcSet, posterUrl } from "../../core/api/tmdb.ts";
import { useRegion } from "../../core/context/RegionContext.tsx";
import { useFavoriteProviders } from "../../core/context/FavoriteProvidersContext.tsx";
import { useExcludedGenres } from "../../core/context/ExcludedGenresContext.tsx";
import { useExcludedTitles } from "../../core/context/ExcludedTitlesContext.tsx";
import { useLibrary } from "../../core/context/LibraryContext.tsx";
import { Icon } from "../../shared/components/index.ts";
import { posterAccentFromGenres } from "../../shared/lib/posterAccent.ts";
import type { Genre, MediaItem } from "../../core/types/tmdb.ts";
import posterStyles from "../../shared/styles/posterAccents.module.css";
import { storageGetJSON, storageSetJSON } from "../../shared/lib/storage.ts";
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

/** « Pour vous ce soir » (en tête de Découvrir, nouvelle DA) : un film
 * populaire et bien noté, disponible sur vos plateformes si vous en avez
 * choisi, hors genres/titres exclus et films déjà vus. « Autre suggestion »
 * écarte le film du jour et en tire un autre. Grand bloc avec spot
 * doré sur desktop, carte compacte (~130 px) sur mobile. */
export default function TonightPick() {
  const { t, i18n } = useTranslation();
  const { region } = useRegion();
  const { favoriteProviderIds } = useFavoriteProviders();
  const { excludedGenreIds } = useExcludedGenres();
  const { filterExcluded } = useExcludedTitles();
  const { isWatched, isInWatchlist, toggleWatchlist } = useLibrary();
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

  if (candidates === null) {
    return <div className={`${styles.hero} ${styles.placeholder}`} aria-hidden="true" />;
  }

  const unwatched = candidates.filter((c) => !isWatched("movie", c.id));
  if (unwatched.length === 0) {
    return null;
  }
  // Les titres écartés laissent la place aux suivants dans l'ordre de
  // popularité ; une fois tout écarté, on repart du début.
  const remaining = unwatched.filter((c) => !skipped.includes(c.id));
  const pool = (remaining.length ? remaining : unwatched).slice(0, PICK_POOL_SIZE);
  const pick = pool[dailyIndex(pool.length)];

  function skip() {
    const next = remaining.length > 1 ? [...skipped, pick.id] : [pick.id];
    setSkipped(next);
    writeSkipped(next);
  }

  const title = pick.title || pick.name || t("common.unknownTitle");
  const date = pick.release_date;
  const genreName = genres.find((g) => g.id === pick.genre_ids?.[0])?.name;
  const meta = [date?.slice(0, 4), genreName].filter(Boolean).join(" · ");
  const inWatchlist = isInWatchlist("movie", pick.id);
  const accentKey = posterAccentFromGenres(pick.genre_ids, `movie:${pick.id}`);
  // w780 suffit : le fond n'est affiché qu'à 35 % d'opacité (audit M9).
  const backdrop = backdropUrl(pick.backdrop_path, "w780");
  const detailUrl = `/media/movie/${pick.id}`;

  return (
    <section className={styles.hero} aria-labelledby="tonight-title">
      <button
        type="button"
        className={styles.skipIcon}
        onClick={skip}
        aria-label={t("tonightPick.another")}
        title={t("tonightPick.another")}
      >
        <Icon name="refresh" size={16} />
      </button>
      {backdrop && (
        <div className={styles.backdrop} style={{ backgroundImage: `url(${backdrop})` }} />
      )}
      <Link to={detailUrl} className={styles.poster} tabIndex={-1} aria-hidden="true">
        {pick.poster_path ? (
          <img
            src={posterUrl(pick.poster_path) ?? undefined}
            srcSet={posterSrcSet(pick.poster_path)}
            sizes="(max-width: 860px) 87px, 180px"
            alt=""
            fetchPriority="high"
          />
        ) : (
          <div className={`${styles.noPoster} ${posterStyles[accentKey]}`} />
        )}
      </Link>
      <div className={styles.body}>
        <p className={styles.eyebrow}>
          <Icon name="sparkle" /> {t("tonightPick.eyebrow")}
        </p>
        <h2 id="tonight-title" className={styles.title}>
          <Link to={detailUrl} className={styles.titleLink}>
            {title}
          </Link>
        </h2>
        <p className={styles.meta}>
          {meta}
          {pick.vote_average ? (
            <span className={styles.rating}>
              {meta ? " · " : ""}
              <Icon name="star" filled size={13} /> {pick.vote_average.toFixed(1)}
            </span>
          ) : null}
        </p>
        {pick.overview && <p className={styles.overview}>{pick.overview}</p>}
        <div className={styles.actions}>
          <Link to={detailUrl} className={styles.primary}>
            {t("tonightPick.seeDetails")}
          </Link>
          <button
            type="button"
            className={`${styles.secondary} ${inWatchlist ? styles.secondaryOn : ""}`}
            aria-pressed={inWatchlist}
            onClick={() =>
              toggleWatchlist({
                id: pick.id,
                mediaType: "movie",
                title,
                posterPath: pick.poster_path ?? null,
                date,
                genreIds: pick.genre_ids || [],
              })
            }
          >
            <Icon name="star" filled={inWatchlist} /> {t("mediaCard.wantToWatch")}
          </button>
          <button type="button" className={styles.secondary} onClick={skip}>
            <Icon name="refresh" /> {t("tonightPick.another")}
          </button>
        </div>
      </div>
    </section>
  );
}
