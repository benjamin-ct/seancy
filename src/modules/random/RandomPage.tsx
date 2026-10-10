import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import {
  discover,
  getGenres,
  getWatchProvidersList,
  getDetails,
  watchProvidersFromDetails,
  posterUrl,
} from "../../core/api/tmdb.ts";
import { useLibrary } from "../../core/context/LibraryContext.tsx";
import { useRegion } from "../../core/context/RegionContext.tsx";
import { useFavoriteProviders } from "../../core/context/FavoriteProvidersContext.tsx";
import { useExcludedGenres } from "../../core/context/ExcludedGenresContext.tsx";
import { useExcludedTitles } from "../../core/context/ExcludedTitlesContext.tsx";
import {
  FilterPanel,
  EMPTY_ADVANCED_FILTERS,
  getAdvancedFiltersRangeError,
  TrailerButton,
  ErrorMessage,
  PageHeader,
  Icon,
  SlidingIndicator,
} from "../../shared/components/index.ts";
import type { AdvancedFiltersState } from "../../shared/components/index.ts";
import { posterAccentFromGenres } from "../../shared/lib/posterAccent.ts";
import posterStyles from "../../shared/styles/posterAccents.module.css";
import { ratingTier } from "../../shared/lib/ratingTier.ts";
import { prefersReducedMotion } from "../../shared/lib/motion.ts";
import type { LibraryItem } from "../../core/types/library.ts";
import type {
  Genre,
  MediaDetails,
  MediaItem,
  MediaType,
  RegionWatchProviders,
} from "../../core/types/tmdb.ts";
import type { WatchProviderOption } from "../../core/api/tmdb.ts";
import styles from "./RandomPage.module.css";

const MAX_ATTEMPTS = 6;
// Défilement d'affiches pendant un tirage : une affiche toutes les 350 ms,
// piochée parmi au plus REEL_MAX miniatures (w92, quelques Ko chacune) du
// catalogue, de l'historique et des envies de voir. Elles sont préchargées
// une seule fois et seules celles déjà chargées défilent : rien n'arrive en
// retard, rien n'est retéléchargé, même sur une connexion lente.
// 350 ms : moins de 3 changements par seconde, seuil WCAG 2.3.1 des contenus
// clignotants (à 90 ms, le défilement flashait à ~11 images/s). Désactivé
// avec « réduire les animations » (voir useReelPoster).
const REEL_INTERVAL_MS = 350;
const REEL_MAX = 16;
// Réserve d'affiches du catalogue dans laquelle le défilement pioche (voir
// collectCatalogPosters) : plus large que REEL_MAX pour que chaque tirage
// (nouveau genre, nouveau type) ait une chance d'apporter de la variété
// fraîche plutôt que de se faire immédiatement écarter par un plafond déjà
// atteint dès le tout premier lot chargé au montage.
const CATALOG_POOL_MAX = 64;
// Attente maximale de l'affiche du titre tiré avant de le révéler : le
// défilement continue en attendant, et la révélation montre la bonne affiche.
const POSTER_WAIT_MS = 2500;
// Durée plancher du défilement avant révélation (voir ticket Trello "Roue
// aléatoire") : un tirage catalogue peut résoudre en moins de 2s, trop vite
// pour que le défilement ait eu le temps de montrer plusieurs affiches — ça
// donnait l'impression d'un bug plutôt que d'un tirage réussi. ~3-4 affiches
// à REEL_INTERVAL_MS avant la révélation, quelle que soit la vitesse réelle
// du tirage.
const MIN_SPIN_MS = 1200;

type DrawSource = "watchlist" | "catalog";
// « Les deux » : chaque tirage choisit au hasard entre films et séries.
type TypeChoice = MediaType | "all";

interface Drawn {
  item: MediaItem;
  details: MediaDetails;
}

// Historique des tirages : propre à l'onglet (sessionStorage), les plus
// récents en premier.
const HISTORY_STORAGE_KEY = "seancy.randomHistory.v1";
const HISTORY_MAX = 12;

interface HistoryEntry {
  id: number;
  mediaType: MediaType;
  title: string;
  posterPath: string | null;
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = sessionStorage.getItem(HISTORY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

// « Disponible sur X, Y · inclus avec abonnement » : abonnement en priorité,
// sinon location/achat. null si aucune offre connue dans la région.
function availabilityOf(
  providers: RegionWatchProviders | null
): { names: string; kind: "subscription" | "rentBuy" } | null {
  const flatrate = providers?.flatrate ?? [];
  const rentBuy = [...(providers?.rent ?? []), ...(providers?.buy ?? [])];
  const list = flatrate.length > 0 ? flatrate : rentBuy;
  if (list.length === 0) {
    return null;
  }
  const names = [...new Set(list.map((p) => p.provider_name))].slice(0, 2).join(", ");
  return { names, kind: flatrate.length > 0 ? "subscription" : "rentBuy" };
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Résout quand l'image est chargée, en échec, ou au bout de timeoutMs. */
function preloadImage(src: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(resolve, timeoutMs);
    image.onload = image.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    image.src = src;
  });
}

// URL de la miniature qui défile pendant le tirage (null hors tirage ou tant
// qu'aucune n'est chargée).
function useReelPoster(rolling: boolean, posterPaths: string[]): string | null {
  // Lu une fois : piloté par setInterval en JS, le défilement échappe à la
  // media query CSS globale qui coupe les animations.
  const [reducedMotion] = useState(prefersReducedMotion);
  const [loaded, setLoaded] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  // Images gardées en mémoire : le défilement ne redemande rien au réseau.
  const images = useRef(new Map<string, HTMLImageElement>());

  useEffect(() => {
    if (reducedMotion) {
      return;
    }
    for (const path of posterPaths) {
      const src = posterUrl(path, "w92");
      if (!src || images.current.has(src)) {
        continue;
      }
      // Fenêtre glissante plutôt que plafond définitif : sans ça, les
      // REEL_MAX premières miniatures croisées (souvent le tout premier lot,
      // avant même le premier filtre) restaient les seules à jamais défiler,
      // même quand `posterPaths` s'enrichissait ensuite (nouveau genre,
      // nouveau tirage) — d'où le manque de variété remonté sur le ticket.
      if (images.current.size >= REEL_MAX) {
        const oldestSrc = images.current.keys().next().value;
        if (oldestSrc) {
          images.current.delete(oldestSrc);
          setLoaded((prev) => prev.filter((s) => s !== oldestSrc));
        }
      }
      const image = new Image();
      image.onload = () => setLoaded((prev) => [...prev, src]);
      image.src = src;
      images.current.set(src, image);
    }
  }, [posterPaths, reducedMotion]);

  useEffect(() => {
    if (!rolling || loaded.length < 2) {
      return;
    }
    // Saut aléatoire, jamais sur l'affiche courante.
    const timer = setInterval(
      () => setIndex((i) => i + 1 + Math.floor(Math.random() * (loaded.length - 1))),
      REEL_INTERVAL_MS
    );
    return () => clearInterval(timer);
  }, [rolling, loaded.length]);

  if (!rolling || loaded.length === 0) {
    return null;
  }
  return loaded[index % loaded.length];
}

function hasAnyProvider(providers: RegionWatchProviders | null, ids: string[]): boolean {
  if (!providers) {
    return false;
  }
  const available = [
    ...(providers.flatrate || []),
    ...(providers.rent || []),
    ...(providers.buy || []),
  ].map((p) => String(p.provider_id));
  return ids.some((id) => available.includes(id));
}

export default function RandomPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("pageTitle.random"));
  const [typeChoice, setTypeChoice] = useState<TypeChoice>("movie");
  const [genreIds, setGenreIds] = useState<number[]>([]);
  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [useMyPlatforms, setUseMyPlatforms] = useState(false);
  // Seule l'année de sortie est proposée parmi les filtres avancés.
  const [advanced, setAdvanced] = useState<AdvancedFiltersState>(EMPTY_ADVANCED_FILTERS);
  const { yearMin, yearMax } = advanced;
  const [genresByType, setGenresByType] = useState<Partial<Record<MediaType, Genre[]>>>({});
  const [providers, setProviders] = useState<WatchProviderOption[]>([]);
  const [excludeWatched, setExcludeWatched] = useState(true);
  const [chosenSource, setChosenSource] = useState<DrawSource | null>(null);
  // Incrémenté à chaque tirage réussi : relance l'animation d'apparition,
  // même quand le même titre ressort.
  const [drawCount, setDrawCount] = useState(0);
  // Affiches du catalogue vues au fil des requêtes (pour le défilement),
  // par type de média (voir collectCatalogPosters : un pool partagé entre
  // films et séries continuait à montrer des affiches de films pendant un
  // tirage « séries », faute d'être filtré par type).
  const [catalogPosters, setCatalogPosters] = useState<Partial<Record<MediaType, string[]>>>({});
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const historyId = useId();

  const [pick, setPick] = useState<MediaItem | null>(null);
  const [pickDetails, setPickDetails] = useState<MediaDetails | null>(null);
  const [providersResult, setProvidersResult] = useState<RegionWatchProviders | null>(null);
  const [status, setStatus] = useState<
    "idle" | "loading" | "empty" | "success" | "error" | "invalid"
  >("idle");
  const [error, setError] = useState<Error | null>(null);

  const { watchlist, watchedIds, isWatched, isInWatchlist, toggleWatched, toggleWatchlist } =
    useLibrary();
  // Par défaut tout le catalogue (voir ticket Trello "Roue aléatoire" : un
  // défaut sur « Mes envies de voir » surprenait, et menait au tirage lent
  // de drawFromWatchlist, voir plus bas), sauf choix explicite.
  const source: DrawSource = chosenSource ?? "catalog";
  const { region } = useRegion();
  const { favoriteProviderIds } = useFavoriteProviders();
  const { excludedGenreIds } = useExcludedGenres();
  const { filterExcluded } = useExcludedTitles();

  const yearRangeErrorKey = getAdvancedFiltersRangeError(advanced);
  const yearRangeError = yearRangeErrorKey ? t(yearRangeErrorKey) : null;

  const drawTypes: MediaType[] = useMemo(
    () => (typeChoice === "all" ? ["movie", "tv"] : [typeChoice]),
    [typeChoice]
  );

  useEffect(() => {
    setGenreIds([]);
  }, [typeChoice]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      drawTypes.map((type) =>
        getGenres(type)
          .then((data) => [type, data.genres || []] as const)
          .catch(() => [type, []] as const)
      )
    ).then((entries) => !cancelled && setGenresByType(Object.fromEntries(entries)));
    Promise.all(drawTypes.map((type) => getWatchProvidersList(type, region).catch(() => []))).then(
      (lists) => {
        if (!cancelled) {
          const byId = new Map(lists.flat().map((p) => [p.id, p]));
          setProviders([...byId.values()]);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [drawTypes, region]);

  function collectCatalogPosters(type: MediaType, items: { poster_path?: string | null }[]) {
    const paths = items.map((item) => item.poster_path).filter((p): p is string => !!p);
    if (paths.length === 0) {
      return;
    }
    // Fenêtre glissante (les plus récentes en dernier) : un plafond qui
    // arrête définitivement d'accepter de nouvelles affiches dès qu'il est
    // atteint une première fois (souvent au tout premier chargement, avant
    // même le premier filtre) figeait le défilement sur toujours les mêmes
    // affiches, quels que soient les tirages suivants (cause du ticket).
    setCatalogPosters((prev) => {
      const merged = [...new Set([...(prev[type] ?? []), ...paths])];
      const trimmed = merged.length > CATALOG_POOL_MAX ? merged.slice(-CATALOG_POOL_MAX) : merged;
      return { ...prev, [type]: trimmed };
    });
  }

  // Affiches populaires du type choisi, pour que le défilement pioche aussi
  // dans le catalogue même quand on tire dans « Mes envies de voir ».
  useEffect(() => {
    let cancelled = false;
    for (const type of drawTypes) {
      discover(type, { page: 1, region })
        .then((data) => !cancelled && collectCatalogPosters(type, shuffle(data.results ?? [])))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [drawTypes, region]);

  // Films et séries n'ont pas tout à fait les mêmes genres TMDB (« Action »
  // côté films, « Action & Aventure » côté séries) : en « Les deux », on
  // propose l'union des deux listes.
  const genres = useMemo(() => {
    const lists = Object.values(genresByType);
    const byId = new Map(lists.flat().map((g) => [g.id, g]));
    const merged = [...byId.values()];
    return lists.length > 1 ? merged.sort((a, b) => a.name.localeCompare(b.name)) : merged;
  }, [genresByType]);

  /** Genres choisis qui existent pour ce type ; null si aucun n'existe. */
  function genreIdsFor(type: MediaType): number[] | null {
    if (genreIds.length === 0) {
      return [];
    }
    const known = new Set((genresByType[type] ?? []).map((g) => g.id));
    const ids = genreIds.filter((id) => known.has(id));
    return ids.length > 0 ? ids : null;
  }

  const activeProviderIds = useMyPlatforms ? favoriteProviderIds.map(String) : providerIds;

  function rememberDraw(item: MediaItem, details: MediaDetails) {
    const entry: HistoryEntry = {
      id: item.id,
      mediaType: item.mediaType,
      title: details.title || details.name || item.title || item.name || "",
      posterPath: details.poster_path ?? item.poster_path ?? null,
    };
    setHistory((prev) => {
      const next = [
        entry,
        ...prev.filter((h) => h.id !== entry.id || h.mediaType !== entry.mediaType),
      ].slice(0, HISTORY_MAX);
      try {
        sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Stockage indisponible (navigation privée...) : historique en mémoire.
      }
      return next;
    });
  }

  // Tirage dans « Mes envies de voir » : mêmes filtres que pour le catalogue
  // (type, genres, années), les plateformes étant vérifiées sur la fiche du
  // titre (disponibilités dans la région), faute d'information dans la liste.
  async function drawFromWatchlist(): Promise<Drawn | null> {
    const min = yearMin ? Number(yearMin) : null;
    const max = yearMax ? Number(yearMax) : null;
    let pool = watchlist.filter((entry: LibraryItem) => {
      if (!drawTypes.includes(entry.mediaType)) {
        return false;
      }
      if (genreIds.length > 0 && !genreIds.some((g) => entry.genreIds?.includes(g))) {
        return false;
      }
      const year = entry.date ? Number(entry.date.slice(0, 4)) : null;
      if ((min !== null || max !== null) && year === null) {
        return false;
      }
      return (min === null || year! >= min) && (max === null || year! <= max);
    });
    // Évite de retomber sur le titre affiché quand il y a d'autres choix.
    if (pool.length > 1 && pick) {
      pool = pool.filter((entry) => entry.id !== pick.id || entry.mediaType !== pick.mediaType);
    }
    const candidates = shuffle(pool).slice(0, activeProviderIds.length > 0 ? MAX_ATTEMPTS : 1);
    // Les fiches sont demandées en parallèle plutôt que l'une après l'autre
    // (voir ticket Trello "Roue aléatoire" : jusqu'à MAX_ATTEMPTS fiches
    // complètes, chacune coûteuse (append_to_response), enchaînées en
    // séquence faisaient dériver un tirage jusqu'à ~10s).
    const detailsList = await Promise.all(
      candidates.map((entry) => getDetails(entry.mediaType, entry.id))
    );
    for (let i = 0; i < candidates.length; i++) {
      const entry = candidates[i];
      const details = detailsList[i];
      if (
        activeProviderIds.length > 0 &&
        !hasAnyProvider(watchProvidersFromDetails(details, region), activeProviderIds)
      ) {
        continue;
      }
      return {
        item: {
          ...details,
          id: entry.id,
          mediaType: entry.mediaType,
          genre_ids: details.genres?.map((g) => g.id) ?? entry.genreIds,
        },
        details,
      };
    }
    return null;
  }

  // Tirage dans tout le catalogue d'un type (films ou séries).
  async function drawFromCatalog(type: MediaType): Promise<Drawn | null> {
    const typeGenreIds = genreIdsFor(type);
    if (typeGenreIds === null) {
      return null;
    }
    const discoverParams = {
      genreId: typeGenreIds,
      excludeGenreIds: excludedGenreIds,
      providerIds: activeProviderIds.length > 0 ? activeProviderIds : undefined,
      region,
      yearMin: yearMin ? Number(yearMin) : undefined,
      yearMax: yearMax ? Number(yearMax) : undefined,
    };
    const first = await discover(type, { page: 1, ...discoverParams });
    collectCatalogPosters(type, first.results ?? []);
    const totalPages = Math.min(first.total_pages || 1, 500);
    if (totalPages === 0 || !first.results?.length) {
      return null;
    }

    let candidate: MediaItem | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !candidate; attempt++) {
      const page = Math.max(1, Math.floor(Math.random() * Math.min(totalPages, 100)) + 1);
      const data = page === 1 ? first : await discover(type, { page, ...discoverParams });
      // Les pages tirées au hasard ici (et pas seulement la première, déjà
      // collectée ci-dessus) sont justement la source de variété réelle du
      // défilement — sans ça, le pool catalogue restait figé sur la page 1
      // (toujours les mêmes ~20 titres pour un même jeu de filtres), cause
      // du manque de variété remonté sur le ticket malgré la fenêtre
      // glissante.
      if (page !== 1) {
        collectCatalogPosters(type, data.results ?? []);
      }
      let pool = filterExcluded(data.results, type);
      if (excludeWatched) {
        pool = pool.filter((item) => !watchedIds.has(`${type}:${item.id}`));
      }
      if (pool.length > 0) {
        candidate = { ...pool[Math.floor(Math.random() * pool.length)], mediaType: type };
      }
    }

    if (!candidate) {
      candidate = {
        ...first.results[Math.floor(Math.random() * first.results.length)],
        mediaType: type,
      };
    }

    return { item: candidate, details: await getDetails(type, candidate.id) };
  }

  async function drawRandom() {
    if (yearRangeError) {
      // Plage min/max incohérente : on n'appelle pas l'API, qui retomberait
      // silencieusement sur 0 résultat.
      setStatus("invalid");
      return;
    }
    setStatus("loading");
    setError(null);
    const startedAt = Date.now();
    try {
      let drawn: Drawn | null = null;
      if (source === "watchlist") {
        drawn = await drawFromWatchlist();
      } else {
        // « Les deux » : type tiré au hasard, l'autre en repli s'il ne donne
        // rien avec ces filtres.
        for (const type of shuffle(drawTypes)) {
          drawn = await drawFromCatalog(type);
          if (drawn) {
            break;
          }
        }
      }
      // Plusieurs `await` séparent ce point du déclenchement : la page peut
      // avoir été démontée entre-temps (navigation pendant le tirage, audit
      // M16) — poser le résultat sur un composant démonté ne crashe pas mais
      // fuit du travail (sessionStorage, re-renders) pour rien.
      if (!mountedRef.current) {
        return;
      }
      if (drawn) {
        const poster = posterUrl(drawn.item.poster_path, "w342");
        if (poster) {
          await preloadImage(poster, POSTER_WAIT_MS);
        }
      }
      // Délai plancher (voir MIN_SPIN_MS) : appliqué aussi bien au tirage
      // réussi qu'à "empty", pour que le défilement ne s'arrête jamais après
      // une seule affiche sous prétexte que la réponse réseau est arrivée
      // vite.
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_SPIN_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_SPIN_MS - elapsed));
      }
      if (!mountedRef.current) {
        return;
      }
      if (!drawn) {
        clearPick();
        setStatus("empty");
        return;
      }
      setPick(drawn.item);
      setPickDetails(drawn.details);
      setProvidersResult(watchProvidersFromDetails(drawn.details, region));
      rememberDraw(drawn.item, drawn.details);
      setDrawCount((count) => count + 1);
      setStatus("success");
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      clearPick();
      setError(err as Error);
      setStatus("error");
    }
  }

  function clearPick() {
    setPick(null);
    setPickDetails(null);
    setProvidersResult(null);
  }

  const title = pick?.title || pick?.name || "";
  const date = pick?.release_date || pick?.first_air_date;
  // Type du titre tiré (et non le filtre Films/Séries, qui peut avoir changé
  // depuis le tirage).
  const pickType = pick?.mediaType ?? drawTypes[0];
  const watched = pick ? isWatched(pickType, pick.id) : false;
  const inWatchlist = pick ? isInWatchlist(pickType, pick.id) : false;
  // Pas encore sorti (ciné ou plateforme) : le bouton "Vu" porterait à
  // confusion, donc masqué tant que rien n'a déjà été marqué vu (voir
  // MediaCard.tsx, même logique sur les cartes).
  const isUpcoming = Boolean(date && new Date(date) > new Date());
  const accentKey = pick
    ? posterAccentFromGenres(pick.genre_ids, `${pickType}:${pick.id}`)
    : "drama";
  const tier = pick?.vote_average != null ? ratingTier(pick.vote_average) : null;
  const rolling = status === "loading";
  const availability = availabilityOf(providersResult);

  // Affiches qui défilent pendant le tirage, façon machine à sous : catalogue,
  // historique et envies de voir, en alternance. Filtrées sur drawTypes (voir
  // ticket Trello "Roue aléatoire") : un tirage « séries » affichait des
  // affiches de films piochées dans l'historique/les envies de voir ou dans
  // un pool catalogue resté peuplé par un tirage « films » précédent.
  const reelPosters = useMemo(() => {
    const catalog = drawTypes.flatMap((type) => catalogPosters[type] ?? []);
    const personal = shuffle(
      [
        ...history.filter((h) => drawTypes.includes(h.mediaType)).map((h) => h.posterPath),
        ...watchlist
          .filter((w: LibraryItem) => drawTypes.includes(w.mediaType))
          .map((w: LibraryItem) => w.posterPath),
      ].filter((p): p is string => !!p)
    );
    const mixed = catalog.flatMap((path, i) => (personal[i] ? [path, personal[i]] : [path]));
    return [...new Set([...mixed, ...personal])];
  }, [catalogPosters, history, watchlist, drawTypes]);
  const reelPoster = useReelPoster(rolling, reelPosters);

  // Garde de démontage pour `drawRandom` (audit M16) : ses `await` peuvent se
  // résoudre après que la page a été quittée en plein tirage.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Un titre est déjà tiré à l'arrivée sur la page, avec la source et les
  // filtres par défaut (même tirage que le bouton « Tirer un titre »). La
  // bibliothèque vient du localStorage : « Mes envies de voir » est donc
  // déjà connue à ce moment-là.
  const initialDrawDone = useRef(false);
  useEffect(() => {
    if (initialDrawDone.current) {
      return;
    }
    initialDrawDone.current = true;
    void drawRandom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildLibItem() {
    if (!pick) {
      return null;
    }
    return {
      id: pick.id,
      mediaType: pickType,
      title,
      posterPath: pick.poster_path ?? null,
      date,
      genreIds: pick.genre_ids || [],
    };
  }

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow={t("randomPage.eyebrow")}
        title={t("randomPage.title")}
        lead={t("randomPage.lead")}
      />
      {/* Région live toujours montée (une région créée avec son contenu
          n'est pas annoncée) : le titre tiré est lu une fois le tirage fini. */}
      <p className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {pick && !rolling ? t("randomPage.drawnAnnouncement", { title }) : ""}
      </p>

      <div className={styles.source}>
        <div className={styles.sourceSwitch} role="group" aria-label={t("randomPage.source")}>
          <SlidingIndicator activeKey={source} />
          <button
            type="button"
            className={source === "watchlist" ? styles.sourceActive : ""}
            aria-pressed={source === "watchlist"}
            onClick={() => setChosenSource("watchlist")}
          >
            {t("randomPage.sourceWatchlist")}
          </button>
          <button
            type="button"
            className={source === "catalog" ? styles.sourceActive : ""}
            aria-pressed={source === "catalog"}
            onClick={() => setChosenSource("catalog")}
          >
            {t("randomPage.sourceCatalog")}
          </button>
        </div>
        <p className={styles.sourceHint}>
          {source === "watchlist"
            ? t("randomPage.sourceWatchlistHint")
            : t("randomPage.sourceCatalogHint")}
        </p>
      </div>

      {/* Mêmes filtres, dans la même disposition, que Découvrir, Nouveautés
          et Prochainement : bascule Films/Séries, bouton « Filtres », puces
          des filtres actifs et grille de champs titrés. */}
      <FilterPanel
        mediaType={typeChoice === "all" ? "movie" : typeChoice}
        setMediaType={setTypeChoice}
        allTypes={{ active: typeChoice === "all", onSelect: () => setTypeChoice("all") }}
        genres={genres}
        genreIds={genreIds}
        setGenreIds={setGenreIds}
        providers={providers}
        providerIds={providerIds}
        setProviderIds={setProviderIds}
        favoriteProviderIds={favoriteProviderIds}
        useMyPlatforms={useMyPlatforms}
        setUseMyPlatforms={setUseMyPlatforms}
        advanced={advanced}
        setAdvanced={setAdvanced}
        advancedFields={["year"]}
        switches={
          source === "catalog"
            ? [
                {
                  key: "without-watched",
                  label: t("randomPage.watchedFilter"),
                  text: t("randomPage.withoutWatched"),
                  checked: excludeWatched,
                  onChange: setExcludeWatched,
                },
              ]
            : []
        }
      />

      <div className={styles.drawRow}>
        <button
          type="button"
          className={styles.rollBtn}
          onClick={drawRandom}
          disabled={rolling || !!yearRangeError}
          aria-busy={rolling}
        >
          <span className={rolling ? styles.spinning : undefined}>
            <Icon name="repeat" size={20} />
          </span>
          {t("randomPage.draw")}
        </button>
      </div>

      {yearRangeError && (
        <p className={styles.rangeError} role="alert">
          <Icon name="alert" /> {yearRangeError}
        </p>
      )}

      {status === "error" && <ErrorMessage error={error} />}
      {status === "empty" && source === "catalog" && (
        <p className={styles.hint}>{t("randomPage.emptyHint")}</p>
      )}
      {status === "empty" && source === "watchlist" && (
        <p className={styles.hint}>
          {t("randomPage.emptyWatchlistHint")}{" "}
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => {
              setChosenSource("catalog");
              setStatus("idle");
            }}
          >
            {t("randomPage.drawFromCatalog")}
          </button>
        </p>
      )}

      {!pick && rolling && (
        <div className={styles.spotlight} aria-busy="true">
          {reelPoster ? (
            <div className={`${styles.posterWrap} ${styles.reel}`}>
              <img key="reel" src={reelPoster} alt="" />
            </div>
          ) : (
            <div className={`${styles.posterWrap} ${styles.fading}`} />
          )}
        </div>
      )}

      {pick && (
        <div key={drawCount} className={`${styles.spotlight} ${styles.reveal}`} aria-busy={rolling}>
          <div
            className={`${styles.posterWrap} ${rolling ? (reelPoster ? styles.reel : styles.fading) : ""}`}
          >
            {reelPoster ? (
              <img key="reel" src={reelPoster} alt="" />
            ) : pick.poster_path ? (
              <img
                key={pick.poster_path}
                src={posterUrl(pick.poster_path, "w342") ?? undefined}
                alt={title}
              />
            ) : (
              <div className={`${styles.posterEmpty} ${posterStyles[accentKey]}`}>{title}</div>
            )}
          </div>
          <div className={`${styles.head} ${rolling ? styles.fading : ""}`}>
            <p className={styles.badge}>{t("randomPage.badge")}</p>
            <h2 className={styles.title}>{title}</h2>
            <p className={styles.meta}>
              {pickType === "movie" ? t("randomPage.typeMovie") : t("randomPage.typeSeries")}
              {date ? ` · ${date.slice(0, 4)}` : ""}
              {pickDetails?.genres?.length
                ? ` · ${pickDetails.genres
                    .slice(0, 3)
                    .map((g) => g.name)
                    .join(", ")}`
                : ""}
              {tier && pick.vote_average != null && (
                <>
                  {" · "}
                  <Icon name="star" filled /> {pick.vote_average.toFixed(1)}
                </>
              )}
            </p>
          </div>
          <div className={`${styles.body} ${rolling ? styles.fading : ""}`}>
            {pick.overview && <p className={styles.overview}>{pick.overview}</p>}
            {availability && (
              <p className={styles.availability}>
                {t("randomPage.availableOn")} <b>{availability.names}</b>
                {" · "}
                {availability.kind === "subscription"
                  ? t("randomPage.withSubscription")
                  : t("randomPage.rentOrBuy")}
              </p>
            )}
            <div className={styles.actions}>
              <Link to={`/media/${pickType}/${pick.id}`} className={styles.primaryBtn}>
                {t("randomPage.viewSheet")}
              </Link>
              <button
                type="button"
                className={`${styles.secondaryBtn} ${inWatchlist ? styles.onWant : ""}`}
                aria-pressed={inWatchlist}
                onClick={() => {
                  const item = buildLibItem();
                  if (item) {
                    toggleWatchlist(item);
                  }
                }}
              >
                <Icon name="star" filled={inWatchlist} />
                {inWatchlist ? t("randomPage.wantToWatchOn") : t("randomPage.wantToWatchOff")}
              </button>
              {(watched || !isUpcoming) && (
                <button
                  type="button"
                  className={`${styles.secondaryBtn} ${watched ? styles.onWatched : ""}`}
                  aria-pressed={watched}
                  onClick={() => {
                    const item = buildLibItem();
                    if (item) {
                      toggleWatched(item);
                    }
                  }}
                >
                  <Icon name="check" strokeWidth={watched ? 3 : 2} />
                  {watched ? t("randomPage.watchedOn") : t("randomPage.watchedOff")}
                </button>
              )}
              <TrailerButton videos={pickDetails?.videos?.results} />
              <Link
                to={`/media/${pickType}/${pick.id}#recommendations`}
                className={styles.ghostBtn}
              >
                <Icon name="repeat" />
                {t("randomPage.similar")}
              </Link>
            </div>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <section className={styles.history} aria-labelledby={`${historyId}-history`}>
          <h2 id={`${historyId}-history`} className={styles.historyTitle}>
            {t("randomPage.historyTitle")}
          </h2>
          <ul className={styles.historyList}>
            {history.map((entry) => {
              const current = !!pick && entry.id === pick.id && entry.mediaType === pickType;
              return (
                <li key={`${entry.mediaType}:${entry.id}`}>
                  <Link
                    to={`/media/${entry.mediaType}/${entry.id}`}
                    className={`${styles.historyItem} ${current ? styles.historyCurrent : ""}`}
                    aria-current={current ? "true" : undefined}
                    title={entry.title}
                    aria-label={entry.title}
                  >
                    {entry.posterPath ? (
                      <img
                        src={posterUrl(entry.posterPath, "w154") ?? undefined}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <span className={styles.historyName}>{entry.title}</span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
