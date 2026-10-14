import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import { discover, getGenres, getWatchProvidersList } from "../../core/api/tmdb.ts";
import { useScrollRestoration } from "../../shared/hooks/useScrollRestoration.ts";
import { useResumableSeries } from "../../shared/hooks/useResumableSeries.ts";
import { useFeaturedSeries } from "../../shared/hooks/useFeaturedSeries.ts";
import { useFeaturedMovies } from "../../shared/hooks/useFeaturedMovies.ts";
import { useRegion } from "../../core/context/RegionContext.tsx";
import { useFavoriteProviders } from "../../core/context/FavoriteProvidersContext.tsx";
import { useExcludedGenres } from "../../core/context/ExcludedGenresContext.tsx";
import { useExcludedTitles } from "../../core/context/ExcludedTitlesContext.tsx";
import { useLibrary } from "../../core/context/LibraryContext.tsx";
import { useAuth } from "../../core/context/AuthContext.tsx";
import {
  getRecommendations,
  postNotInterested,
  type RecommendationMediaItem,
} from "../../core/api/recommendations.ts";
import { logWarn } from "../../core/logger.ts";
import {
  MediaCard,
  MediaCardSkeleton,
  FilterPanel,
  getAdvancedFiltersRangeError,
  ErrorMessage,
  EmptyState,
  ContinueWatchingRow,
  FeaturedMediaRow,
  Icon,
  EMPTY_ADVANCED_FILTERS,
  DEFAULT_SORT_FIELD,
  DEFAULT_SORT_DIRECTION,
} from "../../shared/components/index.ts";
import type { AdvancedFiltersState } from "../../shared/components/index.ts";
import type { Genre, MediaItem, MediaType } from "../../core/types/tmdb.ts";
import type { WatchProviderOption } from "../../core/api/tmdb.ts";
import gridStyles from "../../shared/styles/mediaGrid.module.css";
import TonightPick from "./TonightPick.tsx";
import { useDiscoverFilters } from "./discoverFilters.ts";
import styles from "./DiscoverPage.module.css";

const GRID_SKELETON_COUNT = 12;
// Taille de page de la grille personnalisée "Pour toi" — doit rester
// cohérente entre le chargement initial et loadMore() pour que l'offset
// envoyé à /api/recommendations (page - 1) * taille reste exact. Retour de
// review sur #296 : 24 déclenchait un nouveau chargement visible trop
// souvent au scroll ; 40 (le plafond côté Worker, voir handleGetRecommendations)
// ramène le même ressenti que la grille "Découvrir" classique (~20-24
// items/page TMDB, mais affichés par lots plus gros ici).
const PERSONALIZED_PAGE_SIZE = 40;

// Résultats déjà chargés, par entrée d'historique : au retour arrière, la
// grille réapparaît tout de suite (sans squelette ni nouvel appel), prête à
// être replacée à sa position de défilement.
interface ResultsSnapshot {
  results: MediaItem[];
  page: number;
  totalPages: number;
}
const resultsMemory = new Map<string, ResultsSnapshot>();

// Convertit les valeurs texte des <input> en nombres (ou undefined si vide)
// pour discover().
function toDiscoverParams(advanced: AdvancedFiltersState) {
  const num = (v: string) => (v === "" || v == null ? undefined : Number(v));
  return {
    yearMin: num(advanced.yearMin),
    yearMax: num(advanced.yearMax),
    voteAverageMin: num(advanced.voteAverageMin),
    voteAverageMax: num(advanced.voteAverageMax),
    voteCountMin: num(advanced.voteCountMin),
    runtimeMin: num(advanced.runtimeMin),
    runtimeMax: num(advanced.runtimeMax),
    originCountry: advanced.originCountry || undefined,
  };
}

// "En salle" : garde les films pour lesquels le Worker a trouvé une date de
// sortie ciné régionale (voir includeRegionReleaseDate, même indicateur que
// le badge "Salles" affiché par MediaCard). Le paramètre natif TMDB
// with_release_type n'a aucun effet observé en pratique (vérifié : résultats
// strictement identiques avec/sans sur discover/movie), d'où ce filtre côté
// client — même pattern que NewReleasesPage/ComingSoonPage.
function keepTheatricalOnly<T extends { region_release_date?: string | null }>(
  items: T[],
  active: boolean,
  mediaType: MediaType
): T[] {
  if (!active || mediaType !== "movie") {
    return items;
  }
  return items.filter((item) => item.region_release_date != null);
}

export default function DiscoverPage() {
  const { t, i18n } = useTranslation();
  // Page d'accueil : titre par défaut de l'appli.
  useDocumentTitle(null);
  const location = useLocation();
  const navigationType = useNavigationType();
  const restoredResults = navigationType === "POP" ? resultsMemory.get(location.key) : undefined;
  // Vrai jusqu'au premier passage des effets ci-dessous : ils ne doivent ni
  // remettre la page à 1 ni recharger la grille restaurée.
  const keepRestoredResultsRef = useRef(restoredResults !== undefined);

  // Filtres lus depuis l'URL (audit M13) : un retour arrière remonte la page
  // sur l'URL de l'entrée d'historique, donc avec ses filtres.
  const {
    mediaType,
    setMediaType,
    genreIds,
    setGenreIds,
    providerIds,
    setProviderIds,
    useMyPlatforms,
    setUseMyPlatforms,
    sortField,
    setSortField,
    sortDirection,
    setSortDirection,
    advanced,
    setAdvanced,
    inTheatersOnly,
    setInTheatersOnly,
  } = useDiscoverFilters();
  const [genres, setGenres] = useState<Genre[]>([]);
  const [providers, setProviders] = useState<WatchProviderOption[]>([]);
  const [page, setPage] = useState(restoredResults?.page ?? 1);
  const [results, setResults] = useState<MediaItem[]>(restoredResults?.results ?? []);
  const [totalPages, setTotalPages] = useState(restoredResults?.totalPages ?? 1);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error" | "invalid">(
    restoredResults ? "success" : "idle"
  );
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
  const { watchlist } = useLibrary();
  const { status: authStatus } = useAuth();
  // Grille personnalisée "Pour toi" affichée à la place du discover()
  // classique uniquement quand aucun filtre explicite n'est actif (sinon la
  // personnalisation contredirait le filtre choisi à la main) — voir
  // décision sur le ticket Trello "Recommandations personnalisées « Pour
  // toi »". Mémorisé par le rendu réellement affiché (`usingPersonalized`
  // state, pas recalculé ici) : un échec de l'appel /api/recommendations
  // retombe sur discover() sans que l'utilisateur distingue une grille
  // "vide" d'un filtre actif.
  const isDefaultFilters =
    genreIds.length === 0 &&
    providerIds.length === 0 &&
    !useMyPlatforms &&
    !inTheatersOnly &&
    sortField === DEFAULT_SORT_FIELD &&
    sortDirection === DEFAULT_SORT_DIRECTION &&
    JSON.stringify(advanced) === JSON.stringify(EMPTY_ADVANCED_FILTERS);
  const [usingPersonalized, setUsingPersonalized] = useState(false);

  const advancedKey = JSON.stringify(advanced);
  const advancedError = getAdvancedFiltersRangeError(advanced);
  const activeProviderIds = useMyPlatforms
    ? favoriteProviderIds
    : providerIds.length
      ? providerIds
      : undefined;
  // « année · genre » sous chaque carte : premier genre TMDB du titre (ou,
  // en grille personnalisée, la raison de la suggestion — voir reasonLabel
  // plus bas).
  const genreNames = useMemo(() => new Map(genres.map((g) => [g.id, g.name])), [genres]);

  const reasonLabel = useCallback(
    (item: MediaItem): string | undefined => {
      const reason = (item as Partial<RecommendationMediaItem>).reason;
      if (!reason) {
        return genreNames.get(item.genre_ids?.[0] ?? -1);
      }
      if (reason.kind === "genre") {
        return genreNames.get(reason.genreId);
      }
      if (reason.kind === "decade") {
        return t("discoverPage.reasonDecade", { decade: reason.decade });
      }
      return t("discoverPage.reasonTrending");
    },
    [genreNames, t]
  );

  // "Séries en cours" : séries entamées avec au moins un épisode non vu déjà
  // sorti (indépendant du filtre Films/Séries de la grille de suggestions
  // ci-dessous).
  const continuingSeries = useResumableSeries(watchlist);
  const continuingSeriesIds = new Set(continuingSeries.map((item) => item.id));

  // "Mise en avant" : séries suivies (watchlist incluse, pas seulement
  // entamées) dont un épisode vient de sortir ou arrive bientôt, et films
  // suivis dont la sortie initiale vient d'avoir lieu ou arrive bientôt —
  // sauf les séries déjà affichées dans "Séries en cours" juste au-dessus, pour ne
  // pas dupliquer la même série dans les deux rangées ("Séries en cours" ne
  // concerne que des séries, jamais des films).
  const featuredSeries = useFeaturedSeries(watchlist).filter(
    ({ item }) => !continuingSeriesIds.has(item.id)
  );
  const featuredMovies = useFeaturedMovies(watchlist, region);
  const featuredItems = [...featuredSeries, ...featuredMovies].sort((a, b) => {
    if (a.badge.kind !== b.badge.kind) {
      return a.badge.kind === "just_released" ? -1 : 1;
    }
    return a.badge.kind === "just_released"
      ? b.badge.date.localeCompare(a.badge.date)
      : a.badge.date.localeCompare(b.badge.date);
  });

  useEffect(() => {
    if (keepRestoredResultsRef.current) {
      return;
    }
    setPage(1);
  }, [
    mediaType,
    genreIds,
    providerIds,
    useMyPlatforms,
    sortField,
    sortDirection,
    advancedKey,
    inTheatersOnly,
  ]);

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
    // i18n.language : les libellés de genres/plateformes viennent de TMDB
    // dans la langue active (tmdbClient.ts), donc un changement de langue
    // doit redéclencher cet appel comme un changement de mediaType/region.
  }, [mediaType, region, i18n.language]);

  useEffect(() => {
    if (advancedError) {
      // Plage min/max incohérente (ex. note min > note max) : on n'appelle
      // pas l'API, qui retomberait silencieusement sur 0 résultat.
      setResults([]);
      setStatus("invalid");
      return;
    }
    if (keepRestoredResultsRef.current) {
      keepRestoredResultsRef.current = false;
      return;
    }
    let cancelled = false;
    // Filtre changé ou page quittée : la requête en cours est annulée et
    // libère sa place dans la file de tmdbFetch (audit M10).
    const controller = new AbortController();
    setStatus("loading");
    setLoadMoreError(null);
    const runClassicDiscover = () => {
      discover(mediaType, {
        signal: controller.signal,
        page: 1,
        genreId: genreIds,
        excludeGenreIds: excludedGenreIds,
        providerIds: activeProviderIds,
        region,
        sortField,
        sortDirection,
        excludeUpcoming: true,
        includeRegionReleaseDate: true,
        ...toDiscoverParams(advanced),
      })
        .then((data) => {
          if (cancelled) {
            return;
          }
          const kept = keepTheatricalOnly(
            filterExcluded(data.results, mediaType),
            inTheatersOnly,
            mediaType
          );
          setUsingPersonalized(false);
          setResults(kept.map((r) => ({ ...r, mediaType })));
          setTotalPages(Math.min(data.total_pages || 1, 500));
          setStatus("success");
        })
        .catch((err) => {
          if (cancelled) {
            return;
          }
          setError(err);
          setStatus("error");
        });
    };

    // Grille "Pour toi" réservée aux comptes connectés sans filtre actif
    // (voir isDefaultFilters) : repli immédiat et silencieux sur discover()
    // dans tous les autres cas, y compris un échec ou une liste vide de
    // /api/recommendations (cold start non applicable, erreur réseau...).
    if (authStatus === "authenticated" && isDefaultFilters) {
      getRecommendations(mediaType, PERSONALIZED_PAGE_SIZE, controller.signal, 0)
        .then((data) => {
          if (cancelled) {
            return;
          }
          const items = filterExcluded(data.items, mediaType);
          if (items.length === 0) {
            runClassicDiscover();
            return;
          }
          setUsingPersonalized(true);
          setResults(items);
          setPage(1);
          setTotalPages(data.hasMore ? 2 : 1);
          setStatus("success");
        })
        .catch((err) => {
          if (cancelled || err?.name === "AbortError") {
            return;
          }
          runClassicDiscover();
        });
    } else {
      runClassicDiscover();
    }

    return () => {
      cancelled = true;
      controller.abort();
    };
    // i18n.language : discover() renvoie titres/synopsis dans la langue
    // active (tmdbClient.ts) ; sans cette dépendance, changer de langue ne
    // redéclenche pas l'appel et les résultats restent dans l'ancienne
    // langue jusqu'au prochain changement de filtre ou remontage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mediaType,
    genreIds,
    excludedGenreIds,
    providerIds,
    useMyPlatforms,
    favoriteProviderIds,
    region,
    authStatus,
    isDefaultFilters,
    sortField,
    sortDirection,
    advancedKey,
    inTheatersOnly,
    i18n.language,
    reloadKey,
  ]);

  const loadMore = useCallback(() => {
    if (loadingMore || page >= totalPages || advancedError || loadMoreError) {
      return;
    }
    const nextPage = page + 1;
    setLoadingMore(true);

    if (usingPersonalized) {
      getRecommendations(
        mediaType,
        PERSONALIZED_PAGE_SIZE,
        undefined,
        (nextPage - 1) * PERSONALIZED_PAGE_SIZE
      )
        .then((data) => {
          setResults((prev) => {
            const seenIds = new Set(prev.map((item) => item.id));
            const fresh = filterExcluded(data.items, mediaType).filter(
              (item) => !seenIds.has(item.id)
            );
            return [...prev, ...fresh];
          });
          if (data.hasMore) {
            setPage(nextPage);
            setTotalPages(nextPage + 1);
            return;
          }
          // Lot personnalisé épuisé (plafond de calcul côté Worker, voir
          // RECOMMENDATION_CACHE_SIZE) : le scroll infini continue avec le
          // flux "Découvrir" classique plutôt que de s'arrêter net — mêmes
          // filtres par défaut, même pagination que les autres grilles.
          setUsingPersonalized(false);
          return discover(mediaType, {
            page: nextPage,
            genreId: genreIds,
            excludeGenreIds: excludedGenreIds,
            providerIds: activeProviderIds,
            region,
            sortField,
            sortDirection,
            excludeUpcoming: true,
            includeRegionReleaseDate: true,
            ...toDiscoverParams(advanced),
          }).then((discoverData) => {
            setResults((prev) => {
              const seenIds = new Set(prev.map((item) => item.id));
              const fresh = keepTheatricalOnly(
                filterExcluded(discoverData.results, mediaType).filter(
                  (item) => !seenIds.has(item.id)
                ),
                inTheatersOnly,
                mediaType
              ).map((r) => ({ ...r, mediaType }));
              return [...prev, ...fresh];
            });
            setPage(nextPage);
            setTotalPages(Math.min(discoverData.total_pages || 1, 500));
          });
        })
        .catch((err) => setLoadMoreError(err))
        .finally(() => setLoadingMore(false));
      return;
    }

    discover(mediaType, {
      page: nextPage,
      genreId: genreIds,
      excludeGenreIds: excludedGenreIds,
      providerIds: activeProviderIds,
      region,
      sortField,
      sortDirection,
      excludeUpcoming: true,
      includeRegionReleaseDate: true,
      ...toDiscoverParams(advanced),
    })
      .then((data) => {
        // TMDB peut renvoyer un même titre sur deux pages consécutives : on
        // déduplique pour éviter les doublons à l'écran.
        setResults((prev) => {
          const seenIds = new Set(prev.map((item) => item.id));
          const fresh = keepTheatricalOnly(
            filterExcluded(data.results, mediaType).filter((item) => !seenIds.has(item.id)),
            inTheatersOnly,
            mediaType
          ).map((r) => ({ ...r, mediaType }));
          return [...prev, ...fresh];
        });
        setPage(nextPage);
      })
      .catch((err) => setLoadMoreError(err))
      .finally(() => setLoadingMore(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loadingMore,
    loadMoreError,
    page,
    totalPages,
    advancedError,
    usingPersonalized,
    mediaType,
    genreIds,
    excludedGenreIds,
    providerIds,
    useMyPlatforms,
    favoriteProviderIds,
    region,
    sortField,
    sortDirection,
    advancedKey,
    inTheatersOnly,
    i18n.language,
  ]);

  useEffect(() => {
    if (status === "success") {
      resultsMemory.set(location.key, { results, page, totalPages });
    }
  }, [location.key, status, results, page, totalPages]);

  // Sentinelle observée pour déclencher le chargement de la page suivante
  // dès qu'elle approche du bas de l'écran (scroll infini, plus de bouton).
  // Retour de review sur #296 : 600px faisait apparaître le chargement trop
  // près du bas (visible), 1200px le déclenche assez tôt pour que le lot
  // suivant soit déjà là avant que l'utilisateur n'atteigne la fin.
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
      { rootMargin: "1200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [status, loadMore]);

  useScrollRestoration(status === "success", results.length);

  // Masque la carte immédiatement (optimiste) ; le signal négatif part en
  // tâche de fond. Pas de ré-affichage en cas d'échec réseau : impact nul
  // (le titre réapparaîtra simplement au prochain calcul côté Worker) pour
  // une action que l'utilisateur considère déjà faite.
  const handleNotInterested = useCallback((item: MediaItem) => {
    setResults((prev) => prev.filter((r) => r.id !== item.id));
    postNotInterested(item).catch((err) =>
      logWarn('Seancy : signal "pas intéressé" non enregistré.', err)
    );
  }, []);

  return (
    <div className={styles.page}>
      <h1 className={styles.srOnly}>{t("discoverPage.title")}</h1>

      <TonightPick />

      {continuingSeries.length > 0 && (
        <section className={styles.shelf}>
          <div className={styles.blockTitle}>
            <span className={styles.blockIcon}>
              <Icon name="repeat" />
            </span>
            <h2>
              {t("discoverPage.resumeTitle")}{" "}
              <span className={styles.meta}>{t("discoverPage.resumeSubtitle")}</span>
            </h2>
          </div>
          <ContinueWatchingRow items={continuingSeries} />
        </section>
      )}

      {featuredItems.length > 0 && (
        <section className={styles.shelf}>
          <div className={styles.blockTitle}>
            <span className={styles.blockIcon}>
              <Icon name="sparkle" />
            </span>
            <h2>
              {t("discoverPage.featuredTitle")}{" "}
              <span className={styles.meta}>{t("discoverPage.featuredSubtitle")}</span>
            </h2>
          </div>
          <FeaturedMediaRow items={featuredItems} />
        </section>
      )}

      <h2 className={styles.sectionTitle}>{t("discoverPage.suggestionsEyebrow")}</h2>
      <FilterPanel
        mediaType={mediaType}
        setMediaType={setMediaType}
        genres={genres}
        genreIds={genreIds}
        setGenreIds={setGenreIds}
        providers={providers}
        providerIds={providerIds}
        setProviderIds={setProviderIds}
        favoriteProviderIds={favoriteProviderIds}
        useMyPlatforms={useMyPlatforms}
        setUseMyPlatforms={setUseMyPlatforms}
        sortField={sortField}
        setSortField={setSortField}
        sortDirection={sortDirection}
        setSortDirection={setSortDirection}
        advanced={advanced}
        setAdvanced={setAdvanced}
        switches={
          mediaType === "movie"
            ? [
                {
                  key: "in-theaters-only",
                  label: t("filterPanel.inTheatersFilter"),
                  text: t("filterPanel.inTheatersOnly"),
                  checked: inTheatersOnly,
                  onChange: setInTheatersOnly,
                },
              ]
            : []
        }
      />

      {status === "loading" && (
        <div className={gridStyles.grid}>
          {Array.from({ length: GRID_SKELETON_COUNT }, (_, i) => (
            <MediaCardSkeleton key={i} />
          ))}
        </div>
      )}
      {status === "error" && (
        <ErrorMessage error={error} onRetry={() => setReloadKey((key) => key + 1)} />
      )}
      {status === "invalid" && advancedError && <EmptyState label={t(advancedError)} />}
      {status === "success" && results.length === 0 && (
        <EmptyState label={t("discoverPage.emptyState")} />
      )}

      {status === "success" && results.length > 0 && (
        <>
          <div className={gridStyles.grid}>
            {results.map((item) => (
              <MediaCard
                key={item.id}
                item={item}
                yearGenre
                genreName={reasonLabel(item)}
                onNotInterested={
                  (item as Partial<RecommendationMediaItem>).reason
                    ? handleNotInterested
                    : undefined
                }
              />
            ))}
          </div>
          {page < totalPages && (
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
        </>
      )}
    </div>
  );
}
