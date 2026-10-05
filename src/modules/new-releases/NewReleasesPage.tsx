import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import { discover, getGenres, getWatchProvidersList } from "../../core/api/tmdb.ts";
import { useScrollRestoration } from "../../shared/hooks/useScrollRestoration.ts";
import { usePrefillFromFavorites } from "../../shared/hooks/usePrefillFromFavorites.ts";
import { useRegion } from "../../core/context/RegionContext.tsx";
import { useFavoriteProviders } from "../../core/context/FavoriteProvidersContext.tsx";
import { useFavoriteCountries } from "../../core/context/FavoriteCountriesContext.tsx";
import { useFavoriteLanguages } from "../../core/context/FavoriteLanguagesContext.tsx";
import { useExcludedGenres } from "../../core/context/ExcludedGenresContext.tsx";
import { useExcludedTitles } from "../../core/context/ExcludedTitlesContext.tsx";
import {
  MediaCard,
  MediaCardSkeleton,
  FilterPanel,
  ErrorMessage,
  EmptyState,
  PageHeader,
} from "../../shared/components/index.ts";
import type { DiscoverParams } from "../../core/api/tmdb.ts";
import type { Genre, MediaItem, MediaType } from "../../core/types/tmdb.ts";
import type { WatchProviderOption } from "../../core/api/tmdb.ts";
import gridStyles from "../../shared/styles/mediaGrid.module.css";
import styles from "./NewReleasesPage.module.css";

const WINDOWS = [
  { value: 7, key: "last7Days" },
  { value: 30, key: "last30Days" },
  { value: 90, key: "last3Months" },
];

const GRID_SKELETON_COUNT = 12;

// Nombre de cartes révélées par "page" de scroll infini, et nombre de pages
// TMDB regroupées par lot de fetch : récupérer plusieurs pages TMDB d'un
// coup (même snapshot de popularité) évite qu'un titre de la page suivante
// se retrouve mieux classé qu'un titre de la page précédente simplement
// parce que le classement TMDB a légèrement bougé entre deux appels
// successifs pendant le scroll (cause du ticket "pas dans le bon ordre").
const REVEAL_SIZE = 20;
const TMDB_PAGES_PER_BATCH = 5;

async function fetchPages(
  mediaType: MediaType,
  params: DiscoverParams,
  fromPage: number,
  count: number
) {
  const pages = await Promise.all(
    Array.from({ length: count }, (_, i) => discover(mediaType, { ...params, page: fromPage + i }))
  );
  return pages.flatMap((p) => p.results || []) as MediaItem[];
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toIsoDate(d);
}

// Périodes d'affichage (nouvelle DA) : « Cette semaine », « Plus tôt ce
// mois-ci », puis « Plus tôt » pour la fenêtre de 3 mois. Fenêtres
// glissantes, comme les puces de période.
const PERIODS = [
  { key: "thisWeek", days: 7 },
  { key: "earlierThisMonth", days: 30 },
  { key: "earlier", days: Infinity },
] as const;

type PeriodKey = (typeof PERIODS)[number]["key"];

// Regroupe les résultats par période sans changer leur ordre (popularité)
// à l'intérieur d'une période. Un titre sans date, ou daté avant la fenêtre
// (date primaire TMDB plus ancienne que la sortie dans la région), tombe
// dans la dernière période de la fenêtre.
function groupByPeriod(items: MediaItem[], windowDays: number) {
  const periods = PERIODS.filter((_, i) => i === 0 || PERIODS[i - 1].days < windowDays);
  const bounds = periods.map((p) => (p.days === Infinity ? "" : daysAgoIso(p.days)));
  const groups = new Map<PeriodKey, MediaItem[]>(periods.map((p) => [p.key, []]));
  for (const item of items) {
    const date = item.release_date || item.first_air_date || "";
    const index = bounds.findIndex((bound) => date >= bound);
    const period = periods[index === -1 || !date ? periods.length - 1 : index];
    groups.get(period.key)!.push(item);
  }
  return [...groups].filter(([, list]) => list.length > 0);
}

// Fenêtre [aujourd'hui - windowDays ; aujourd'hui] : uniquement des titres
// déjà sortis (pas de bornes ouvertes vers le futur, sinon TMDB renvoie
// aussi des sorties à venir déjà programmées).
function dateRangeFor(windowDays: number) {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - windowDays);
  return { dateFrom: toIsoDate(from), dateTo: toIsoDate(today) };
}

export default function NewReleasesPage() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t("pageTitle.newReleases"));
  const [mediaType, setMediaType] = useState<MediaType>("movie");
  const [genreIds, setGenreIds] = useState<number[]>([]);
  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [useMyPlatforms, setUseMyPlatforms] = useState(false);
  const { favoriteCountryCodes } = useFavoriteCountries();
  const { favoriteLanguageCodes } = useFavoriteLanguages();
  // Pré-rempli depuis les pays/langues favoris du compte (réglage du
  // profil), modifiable ensuite pour cette page sans toucher à la
  // préférence enregistrée — même principe que `useMyPlatforms`, qui ne
  // modifie jamais `favoriteProviderIds` (voir usePrefillFromFavorites pour
  // la synchronisation asynchrone de ce pré-réglage).
  const [countries, setCountries] = usePrefillFromFavorites(favoriteCountryCodes);
  const [languages, setLanguages] = usePrefillFromFavorites(favoriteLanguageCodes);
  const [useMyCountries, setUseMyCountries] = useState(false);
  const [useMyLanguages, setUseMyLanguages] = useState(false);
  const activeCountries = useMyCountries ? favoriteCountryCodes : countries;
  const activeLanguages = useMyLanguages ? favoriteLanguageCodes : languages;
  const [windowDays, setWindowDays] = useState(30);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [providers, setProviders] = useState<WatchProviderOption[]>([]);
  const [allResults, setAllResults] = useState<MediaItem[]>([]);
  const [revealCount, setRevealCount] = useState(REVEAL_SIZE);
  const [fetchedPages, setFetchedPages] = useState(0);
  const [tmdbTotalPages, setTmdbTotalPages] = useState(1);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Échec du chargement de la page suivante (scroll infini) : affiché sous la
  // grille avec « Réessayer », au lieu d'un arrêt silencieux, et sans relance
  // automatique en boucle (audit M11).
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);
  // Incrémenté par « Réessayer » quand le premier chargement a échoué.
  const [reloadKey, setReloadKey] = useState(0);
  const { region } = useRegion();
  const { favoriteProviderIds } = useFavoriteProviders();
  const { excludedGenreIds } = useExcludedGenres();
  const { filterExcluded } = useExcludedTitles();
  const activeProviderIds = useMyPlatforms
    ? favoriteProviderIds
    : providerIds.length
      ? providerIds
      : undefined;

  // Les genres d'un type ne valent pas pour l'autre : on les vide dans le
  // même rendu que le changement de type (et pas dans un effet), sinon
  // discover() part une fois avec l'ancien filtre puis une seconde fois après
  // le reset — deux chargements successifs, d'où le clignotement Films/Séries.
  // Tableau conservé tel quel s'il est déjà vide, pour ne pas changer sa
  // référence (qui redéclencherait aussi l'appel).
  const changeMediaType = useCallback((next: MediaType) => {
    setMediaType(next);
    setGenreIds((prev) => (prev.length ? [] : prev));
  }, []);

  useEffect(() => {
    let cancelled = false;
    getGenres(mediaType)
      .then((data) => !cancelled && setGenres(data.genres || []))
      .catch(() => !cancelled && setGenres([]));
    getWatchProvidersList(mediaType, region)
      .then((list) => !cancelled && setProviders(list))
      .catch(() => !cancelled && setProviders([]));
    return () => {
      cancelled = true;
    };
  }, [mediaType, region]);

  const discoverParams: DiscoverParams = {
    genreId: genreIds,
    excludeGenreIds: excludedGenreIds,
    providerIds: activeProviderIds,
    region,
    originCountry: activeCountries[0] || undefined,
    originalLanguage: activeLanguages[0] || undefined,
    sortField: "popularity",
    sortDirection: "desc",
    includeProviderBadge: true,
    ...dateRangeFor(windowDays),
  };
  const discoverParamsKey = JSON.stringify(discoverParams);

  // Récupère un lot de TMDB_PAGES_PER_BATCH pages TMDB d'un coup (voir
  // REVEAL_SIZE/TMDB_PAGES_PER_BATCH ci-dessus) : l'ordre de popularité au
  // sein d'un même lot est donc cohérent, contrairement à un fetch page par
  // page étalé sur plusieurs dizaines de secondes de scroll.
  const fetchBatch = useCallback(
    async (fromPage: number, signal?: AbortSignal) => {
      const first = await discover(mediaType, { ...discoverParams, page: fromPage, signal });
      const totalPages = Math.min(first.total_pages || 1, 500);
      const pagesToFetch = Math.min(TMDB_PAGES_PER_BATCH, totalPages - fromPage + 1);
      const rest =
        pagesToFetch > 1
          ? await fetchPages(mediaType, discoverParams, fromPage + 1, pagesToFetch - 1)
          : [];
      const batch = filterExcluded([...(first.results as MediaItem[]), ...rest], mediaType).map(
        (r) => ({ ...r, mediaType })
      );
      return { batch, totalPages, newFetchedPages: fromPage - 1 + pagesToFetch };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mediaType, discoverParamsKey]
  );

  useEffect(() => {
    let cancelled = false;
    // Filtre changé ou page quittée : la requête en cours est annulée et
    // libère sa place dans la file de tmdbFetch (audit M10).
    const controller = new AbortController();
    setStatus("loading");
    setLoadMoreError(null);
    fetchBatch(1, controller.signal)
      .then(({ batch, totalPages, newFetchedPages }) => {
        if (cancelled) {
          return;
        }
        setRevealCount(REVEAL_SIZE);
        setAllResults(batch);
        setTmdbTotalPages(totalPages);
        setFetchedPages(newFetchedPages);
        setStatus("success");
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setError(err);
        setStatus("error");
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // i18n.language : discover() renvoie titres/synopsis dans la langue
    // active (tmdbClient.ts) ; sans cette dépendance, changer de langue ne
    // redéclenche pas l'appel et les résultats restent dans l'ancienne
    // langue jusqu'au prochain changement de filtre ou remontage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchBatch, i18n.language, reloadKey]);

  const loadMore = useCallback(() => {
    if (loadingMore || loadMoreError) {
      return;
    }
    if (revealCount < allResults.length) {
      setRevealCount((c) => Math.min(c + REVEAL_SIZE, allResults.length));
      return;
    }
    if (fetchedPages >= tmdbTotalPages) {
      return;
    }
    setLoadingMore(true);
    fetchBatch(fetchedPages + 1)
      .then(({ batch, totalPages, newFetchedPages }) => {
        const seenIds = new Set(allResults.map((item) => item.id));
        const fresh = batch.filter((item) => !seenIds.has(item.id));
        const merged = [...allResults, ...fresh];
        setAllResults(merged);
        setTmdbTotalPages(totalPages);
        setFetchedPages(newFetchedPages);
        setRevealCount((c) => Math.min(c + REVEAL_SIZE, merged.length));
      })
      .catch((err) => setLoadMoreError(err))
      .finally(() => setLoadingMore(false));
  }, [
    loadingMore,
    loadMoreError,
    revealCount,
    allResults,
    fetchedPages,
    tmdbTotalPages,
    fetchBatch,
  ]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (status !== "success") {
      return;
    }
    const el = sentinelRef.current;
    if (!el) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: "600px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [status, loadMore]);

  const visibleResults = useMemo(() => allResults.slice(0, revealCount), [allResults, revealCount]);
  const hasMore = revealCount < allResults.length || fetchedPages < tmdbTotalPages;

  useScrollRestoration(status === "success", visibleResults.length);

  const groups = useMemo(
    () => groupByPeriod(visibleResults, windowDays),
    [visibleResults, windowDays]
  );
  // Rechargement après un changement de filtre : on garde les résultats
  // précédents à l'écran (atténués) plutôt que de les remplacer par le
  // squelette, qui fait sauter toute la page le temps de la requête.
  const refreshing = status === "loading" && visibleResults.length > 0;

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow={t("newReleasesPage.eyebrow")}
        title={t("newReleasesPage.title")}
        lead={t("newReleasesPage.lead")}
        spot
      />

      <FilterPanel
        mediaType={mediaType}
        setMediaType={changeMediaType}
        genres={genres}
        genreIds={genreIds}
        setGenreIds={setGenreIds}
        providers={providers}
        providerIds={providerIds}
        setProviderIds={setProviderIds}
        favoriteProviderIds={favoriteProviderIds}
        useMyPlatforms={useMyPlatforms}
        setUseMyPlatforms={setUseMyPlatforms}
        countryLanguage={{
          countries,
          setCountries,
          languages,
          setLanguages,
          favoriteCountryCodes,
          useMyCountries,
          setUseMyCountries,
          favoriteLanguageCodes,
          useMyLanguages,
          setUseMyLanguages,
        }}
        periods={{
          label: t("newReleasesPage.windowsLabel"),
          options: WINDOWS.map((w) => ({
            value: w.value,
            label: t(`newReleasesPage.windows.${w.key}`),
          })),
          value: windowDays,
          onChange: setWindowDays,
        }}
      />

      {status === "loading" && !refreshing && (
        <div className={gridStyles.grid}>
          {Array.from({ length: GRID_SKELETON_COUNT }, (_, i) => (
            <MediaCardSkeleton key={i} />
          ))}
        </div>
      )}
      {status === "error" && (
        <ErrorMessage error={error} onRetry={() => setReloadKey((key) => key + 1)} />
      )}
      {status === "success" && visibleResults.length === 0 && (
        <EmptyState label={t("newReleasesPage.emptyState")} />
      )}

      {(status === "success" || refreshing) && visibleResults.length > 0 && (
        <div className={refreshing ? gridStyles.refreshing : undefined} aria-busy={refreshing}>
          {groups.map(([key, items]) => (
            <section key={key} className={styles.period} aria-labelledby={`period-${key}`}>
              <h2 id={`period-${key}`} className={styles.periodTitle}>
                {t(`newReleasesPage.periods.${key}`)}{" "}
                <span className={styles.count}>
                  {t("newReleasesPage.titlesCount", { count: items.length })}
                </span>
              </h2>
              <div className={gridStyles.grid}>
                {items.map((item) => (
                  <MediaCard key={item.id} item={item} showProviderBadge />
                ))}
              </div>
            </section>
          ))}
          {hasMore && (
            <div ref={sentinelRef} className={gridStyles.loadMore}>
              {loadingMore && <span>{t("common.loading")}</span>}
            </div>
          )}
          {loadMoreError && (
            <ErrorMessage
              error={{ message: `${t("common.loadMoreError")} ${loadMoreError.message}` }}
              onRetry={() => setLoadMoreError(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
