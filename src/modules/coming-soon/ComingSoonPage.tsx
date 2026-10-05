import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import { useScrollRestoration } from "../../shared/hooks/useScrollRestoration.ts";
import { usePrefillFromFavorites } from "../../shared/hooks/usePrefillFromFavorites.ts";
import { useNearViewport } from "../../shared/hooks/useNearViewport.ts";
import { useUpcomingRelease } from "../../shared/hooks/useUpcomingRelease.ts";
import {
  discover,
  getGenres,
  getWatchProvidersList,
  posterUrl,
  formatFullDate,
  dateLocaleTag,
  type DateLocale,
} from "../../core/api/tmdb.ts";
import { useRegion } from "../../core/context/RegionContext.tsx";
import { useLocale } from "../../core/context/LocaleContext.tsx";
import { useFavoriteProviders } from "../../core/context/FavoriteProvidersContext.tsx";
import { useFavoriteCountries } from "../../core/context/FavoriteCountriesContext.tsx";
import { useFavoriteLanguages } from "../../core/context/FavoriteLanguagesContext.tsx";
import { useExcludedGenres } from "../../core/context/ExcludedGenresContext.tsx";
import { useExcludedTitles } from "../../core/context/ExcludedTitlesContext.tsx";
import { useLibrary } from "../../core/context/LibraryContext.tsx";
import { useReminders } from "../../core/context/RemindersContext.tsx";
import {
  FilterPanel,
  ErrorMessage,
  EmptyState,
  PageHeader,
  Icon,
} from "../../shared/components/index.ts";
import ComingSoonSkeleton from "./components/ComingSoonSkeleton.tsx";
import { posterAccentFromGenres } from "../../shared/lib/posterAccent.ts";
import posterStyles from "../../shared/styles/posterAccents.module.css";
import type { DiscoverParams } from "../../core/api/tmdb.ts";
import type { Genre, MediaItem, MediaType } from "../../core/types/tmdb.ts";
import type { WatchProviderOption } from "../../core/api/tmdb.ts";
import gridStyles from "../../shared/styles/mediaGrid.module.css";
import styles from "./ComingSoonPage.module.css";

const WINDOWS = [
  { value: 7, key: "next7Days" },
  { value: 30, key: "next30Days" },
  { value: 90, key: "next3Months" },
];

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Fenêtre [demain ; aujourd'hui + windowDays] : uniquement des titres pas
// encore sortis (démarre à demain pour ne pas chevaucher "Nouveautés").
function dateRangeFor(windowDays: number) {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() + 1);
  const to = new Date(today);
  to.setDate(to.getDate() + windowDays);
  return { dateFrom: toIsoDate(from), dateTo: toIsoDate(to) };
}

// item.region_release_date (résolu côté Worker, voir discover() avec
// includeRegionReleaseDate) est la date de sortie ciné région-consciente ;
// item.release_date est la date "primaire" globale de TMDB, pas fiable pour
// la région active (même source que MediaCard, voir son commentaire) — sans
// ça, la date affichée en frise pouvait différer de celle de la fiche
// détail (qui calcule la vraie date régionale via getTheatricalDateFromDetails).
function releaseDateOf(item: MediaItem): string {
  return item.region_release_date || item.release_date || item.first_air_date || "";
}

function dedupe(items: MediaItem[]): MediaItem[] {
  const seen = new Set<number>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

function monthLabel(dateStr: string, locale: DateLocale): string {
  const d = new Date(dateStr);
  const label = d.toLocaleDateString(dateLocaleTag(locale), { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// « Cinéma » (libellé de releaseBadge.ts) devient « Salles » ; les autres
// libellés (plateforme/diffuseur, « Sortie numérique »...) restent tels quels.
const THEATRICAL_LABEL = "Cinéma";

function TimelineItem({ item }: { item: MediaItem }) {
  const { t } = useTranslation();
  const { isInWatchlist, toggleWatchlist } = useLibrary();
  const { hasReminder, toggleReminder } = useReminders();
  const { locale } = useLocale();
  const { region, getTheatricalStatus } = useRegion();
  const rowRef = useRef<HTMLDivElement>(null);
  const isNearViewport = useNearViewport(rowRef, true);
  const { release, status: releaseStatus } = useUpcomingRelease(
    isNearViewport,
    item.mediaType,
    item.id,
    region,
    item.release_date || item.first_air_date
  );
  // Film sans date exploitable dans release_dates : repli sur l'index des
  // sorties en salle (même logique que MediaCard).
  const isTheatrical =
    release?.label === THEATRICAL_LABEL ||
    (!release &&
      releaseStatus === "done" &&
      item.mediaType === "movie" &&
      getTheatricalStatus(item.id) === "upcoming");
  const channel = isTheatrical ? t("comingSoonPage.theaters") : release?.label;
  const title = item.title || item.name || t("comingSoonPage.unknownTitle");
  const date = releaseDateOf(item);
  // Rappel et envie de voir sont indépendants : l'un n'implique pas l'autre.
  const notifying = hasReminder(item.mediaType, item.id);
  const wanted = isInWatchlist(item.mediaType, item.id);
  const posterPath = item.poster_path ?? null;
  const accentKey = posterAccentFromGenres(item.genre_ids, `${item.mediaType}:${item.id}`);

  return (
    <div className={styles.item} ref={rowRef}>
      <div className={styles.date}>
        <b>{date ? new Date(date).getDate() : "—"}</b>
        <span>
          {date
            ? new Date(date)
                .toLocaleDateString(dateLocaleTag(locale), { month: "short" })
                .replace(".", "")
            : ""}
        </span>
      </div>
      <Link to={`/media/${item.mediaType}/${item.id}`} className={styles.thumb}>
        {item.poster_path ? (
          <img
            src={posterUrl(item.poster_path, "w92") ?? undefined}
            alt={title}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className={posterStyles[accentKey]} style={{ width: "100%", height: "100%" }} />
        )}
      </Link>
      <Link to={`/media/${item.mediaType}/${item.id}`} className={styles.body}>
        <div className={styles.title}>{title}</div>
        <div className={styles.meta}>
          {channel && (
            <span className={`${styles.channel} ${isTheatrical ? styles.channelTheaters : ""}`}>
              {isTheatrical && <Icon name="film" size={12} />}
              {channel}
            </span>
          )}
          <span className={styles.sub}>
            {formatFullDate(date, locale) ||
              (date ? date.slice(0, 4) : t("comingSoonPage.dateTbd"))}
          </span>
        </div>
      </Link>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.bell} ${notifying ? styles.bellOn : ""}`}
          aria-pressed={notifying}
          title={t("comingSoonPage.notifyTitle")}
          onClick={() =>
            toggleReminder({ id: item.id, mediaType: item.mediaType, title, posterPath, date })
          }
        >
          <Icon name="bell" size={14} />
          <span>{notifying ? t("comingSoonPage.notified") : t("comingSoonPage.notifyMe")}</span>
        </button>
        <button
          type="button"
          className={`${styles.want} ${wanted ? styles.wantOn : ""}`}
          aria-pressed={wanted}
          aria-label={t("comingSoonPage.wantToWatch")}
          title={t("comingSoonPage.wantToWatch")}
          onClick={() =>
            toggleWatchlist({
              id: item.id,
              mediaType: item.mediaType,
              title,
              posterPath,
              date,
              genreIds: item.genre_ids || [],
            })
          }
        >
          <Icon name="star" size={15} />
        </button>
      </div>
    </div>
  );
}

export default function ComingSoonPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("pageTitle.comingSoon"));
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
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const { region } = useRegion();
  const { locale } = useLocale();
  const { favoriteProviderIds } = useFavoriteProviders();
  const { excludedGenreIds } = useExcludedGenres();
  const { filterExcluded } = useExcludedTitles();
  const activeProviderIds = useMyPlatforms
    ? favoriteProviderIds
    : providerIds.length
      ? providerIds
      : undefined;

  const [allResults, setAllResults] = useState<MediaItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Les genres d'un type ne valent pas pour l'autre : on les vide dans le
  // même rendu que le changement de type (et pas dans un effet), sinon le
  // lot part une fois avec l'ancien filtre puis une seconde fois après le
  // reset — deux chargements successifs, d'où le clignotement Films/Séries.
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
    // Tri chronologique côté TMDB (et pas par popularité, qui ne garantit
    // l'ordre qu'au sein d'une page) : chaque page suivante ne peut alors
    // contenir que des dates >= celles déjà affichées, donc la simple
    // concaténation des pages reste toujours triée, sans retri client — un
    // tri par popularité laissait resurgir, des pages plus tard, un titre
    // moins populaire mais daté avant des titres déjà affichés (cause du
    // ticket : « je passe de décembre à octobre » en coming-soon).
    sortField: "year",
    sortDirection: "asc",
    includeRegionReleaseDate: true,
    ...dateRangeFor(windowDays),
  };
  const discoverParamsKey = JSON.stringify(discoverParams);

  const fetchPage = useCallback(
    (pageNumber: number) => discover(mediaType, { ...discoverParams, page: pageNumber }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mediaType, discoverParamsKey]
  );

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    fetchPage(1)
      .then((data) => {
        if (cancelled) {
          return;
        }
        const items = filterExcluded(data.results, mediaType).map((r) => ({ ...r, mediaType }));
        setAllResults(dedupe(items));
        setTotalPages(Math.min(data.total_pages || 1, 500));
        setPage(1);
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (loadingMore || page >= totalPages) {
      return;
    }
    const nextPage = page + 1;
    setLoadingMore(true);
    fetchPage(nextPage)
      .then((data) => {
        const fresh = filterExcluded(data.results, mediaType).map((r) => ({ ...r, mediaType }));
        setAllResults((prev) => dedupe([...prev, ...fresh]));
        setTotalPages(Math.min(data.total_pages || 1, 500));
        setPage(nextPage);
      })
      .catch((err) => setError(err))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, page, totalPages, mediaType, fetchPage, filterExcluded]);

  const hasMore = page < totalPages;
  const visibleResults = allResults;
  // Rechargement après un changement de filtre : on garde la chronologie
  // précédente à l'écran (atténuée) plutôt que de la remplacer par le
  // squelette, qui fait sauter toute la page le temps de la requête.
  const refreshing = status === "loading" && visibleResults.length > 0;

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

  useScrollRestoration(status === "success", visibleResults.length);

  // Regroupement par mois pour l'affichage calendrier, un bloc par mois pour
  // que son en-tête reste collé en haut tant qu'on défile dans ce mois — pas
  // de tri supplémentaire (visibleResults est déjà trié par date, TMDB
  // triant chronologiquement, voir discoverParams.sortField).
  const months: { label: string; items: MediaItem[] }[] = [];
  for (const item of visibleResults) {
    const date = releaseDateOf(item);
    const label = date ? monthLabel(date, locale) : t("comingSoonPage.dateTbd");
    const last = months[months.length - 1];
    if (last?.label === label) {
      last.items.push(item);
    } else {
      months.push({ label, items: [item] });
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow={t("comingSoonPage.eyebrow")}
        title={t("comingSoonPage.title")}
        lead={t("comingSoonPage.lead")}
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
          label: t("comingSoonPage.windowsLabel"),
          options: WINDOWS.map((w) => ({
            value: w.value,
            label: t(`comingSoonPage.windows.${w.key}`),
          })),
          value: windowDays,
          onChange: setWindowDays,
        }}
      />

      {status === "loading" && !refreshing && <ComingSoonSkeleton />}
      {status === "error" && <ErrorMessage error={error} />}
      {status === "success" && visibleResults.length === 0 && (
        <EmptyState label={t("comingSoonPage.emptyState")} />
      )}

      {(status === "success" || refreshing) && visibleResults.length > 0 && (
        <div className={refreshing ? gridStyles.refreshing : undefined} aria-busy={refreshing}>
          <div className={styles.timeline}>
            {months.map((month) => (
              <section key={month.label} className={styles.month}>
                <h2 className={styles.monthHeading}>{month.label}</h2>
                {month.items.map((item) => (
                  <TimelineItem key={`${item.mediaType}:${item.id}`} item={item} />
                ))}
              </section>
            ))}
          </div>
          {hasMore && (
            <div ref={sentinelRef} className={gridStyles.loadMore}>
              {loadingMore && <span>{t("common.loading")}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
