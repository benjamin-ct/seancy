import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import type { TFunction } from "i18next";
import {
  backdropUrl,
  posterUrl,
  posterSrcSet,
  getDetails,
  peekDetails,
  watchProvidersFromDetails,
  estimateRuntimeMinutes,
  getTheatricalDateFromDetails,
  theatricalStatusFromDate,
  getSeriesEpisodeBadge,
  formatFullDate,
  dateLocaleTag,
} from "../../core/api/tmdb.ts";
import {
  TrailerButton,
  MediaCard,
  PersonCard,
  RatingStars,
  ErrorMessage,
  Dropdown,
  Icon,
} from "../../shared/components/index.ts";
import EpisodeTracker from "./components/EpisodeTracker.tsx";
import CollectionSection from "./components/CollectionSection.tsx";
import DetailSkeleton, { DETAIL_POSTER_SIZES } from "./components/DetailSkeleton.tsx";
import WhereToWatch from "./components/WhereToWatch.tsx";
import FollowingActivity from "./components/FollowingActivity.tsx";
import { airedEpisodesUpTo, useSeasonEpisodes } from "./useSeasonEpisodes.ts";
import { useLibrary } from "../../core/context/LibraryContext.tsx";
import { useReminders } from "../../core/context/RemindersContext.tsx";
import { regionName as countryDisplayName, useRegion } from "../../core/context/RegionContext.tsx";
import { useLocale } from "../../core/context/LocaleContext.tsx";
import { useExcludedGenres } from "../../core/context/ExcludedGenresContext.tsx";
import { useExcludedTitles } from "../../core/context/ExcludedTitlesContext.tsx";
import { useMembersOnly } from "../../core/context/MembersOnlyContext.tsx";
import { posterAccentFromGenres } from "../../shared/lib/posterAccent.ts";
import { STAR_LABEL_KEYS } from "../../shared/lib/ratingTier.ts";
import { pop } from "../../shared/lib/motion.ts";
import { getMediaPreview, type MediaPreview } from "../../shared/lib/mediaPreviewCache.ts";
import posterStyles from "../../shared/styles/posterAccents.module.css";
import dropdownStyles from "../../shared/components/Dropdown/Dropdown.module.css";
import gridStyles from "../../shared/styles/mediaGrid.module.css";
import type { CastMember, MediaDetails } from "../../core/types/tmdb.ts";
import { isMediaType } from "../../core/validation/mediaType.ts";
import styles from "./DetailPage.module.css";
import { TmdbHttpError } from "../../core/api/tmdbClient.ts";
import NotFoundPage from "../not-found/NotFoundPage.tsx";

// Acteurs affichés avant « Tout le casting » : une rangée de 6 sur desktop,
// deux rangées de 4 sur mobile (grille sans défilement horizontal).
const MAIN_CAST_COUNT = 6;
const MAIN_CAST_COUNT_MOBILE = 8;
const MOBILE_CAST_QUERY = "(max-width: 720px)";
// Certaines séries ont des milliers d'entrées de casting : TMDB les renvoie
// d'un bloc (pas de pagination des crédits), mais en afficher des milliers
// d'un coup fige la page. On les révèle par lots, multiple de 6 et de 4
// pour garder des rangées complètes quelle que soit la grille.
const CAST_BATCH = 48;

// Statut TMDB d'une série (« Returning Series », « Ended »…) → clé i18n.
const TV_STATUS_KEYS: Record<string, string> = {
  "Returning Series": "detailPage.tvStatusInProduction",
  "In Production": "detailPage.tvStatusInProduction",
  Planned: "detailPage.tvStatusPlanned",
  Pilot: "detailPage.tvStatusPlanned",
  Ended: "detailPage.tvStatusEnded",
  Canceled: "detailPage.tvStatusCanceled",
};

// « 2 h 46 » plutôt que « 166 min » (maquette) ; les durées de moins d'une
// heure (épisodes) restent en minutes.
function formatRuntime(t: TFunction, minutes: number): string {
  if (minutes < 60) {
    return t("detailPage.runtimeMinutes", { count: minutes });
  }
  const m = minutes % 60;
  return t("detailPage.runtimeHours", {
    hours: Math.floor(minutes / 60),
    minutes: String(m).padStart(2, "0"),
    count: m,
  });
}

function languageName(code: string | undefined, localeTag: string): string | null {
  if (!code) {
    return null;
  }
  try {
    const name = new Intl.DisplayNames([localeTag], { type: "language" }).of(code);
    return name ? name.charAt(0).toLocaleUpperCase(localeTag) + name.slice(1) : code;
  } catch {
    return code;
  }
}

function useMainCastCount(): number {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_CAST_QUERY).matches
  );
  useEffect(() => {
    const query = window.matchMedia(MOBILE_CAST_QUERY);
    const onChange = () => setIsMobile(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return isMobile ? MAIN_CAST_COUNT_MOBILE : MAIN_CAST_COUNT;
}

export default function DetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // `useParams` ne garantit rien sur la forme de `mediaType` : une URL
  // `/media/foo/1` le laisserait passer tel quel vers TMDB sans ce garde
  // (audit F6). `isMediaType` restreint ensuite le type du reste du
  // composant à `MediaType | undefined`, comme avant ce correctif.
  const { mediaType: rawMediaType, id } = useParams<{ mediaType: string; id: string }>();
  const mediaType = isMediaType(rawMediaType) ? rawMediaType : undefined;
  // Fiche déjà chargée pendant la session (déjà vue) : affichée dès le
  // premier rendu, sans passer par le squelette.
  const [details, setDetails] = useState<MediaDetails | null>(() =>
    mediaType && id ? peekDetails(mediaType, id) : null
  );
  const [status, setStatus] = useState<"loading" | "success" | "error">(() =>
    details ? "success" : "loading"
  );
  const [error, setError] = useState<Error | null>(null);
  // Incrémenté par « Réessayer » après un échec de chargement (audit M11).
  const [reloadKey, setReloadKey] = useState(0);
  const [preview, setPreview] = useState<MediaPreview | null>(null);
  // Titre de l'onglet : « Dune (2021) — Seancy », dès l'aperçu si on le connaît.
  const pageName = details ? details.title || details.name : preview?.title;
  const pageYear = (details?.release_date || details?.first_air_date)?.slice(0, 4);
  useDocumentTitle(
    pageName && pageYear ? t("pageTitle.withYear", { title: pageName, year: pageYear }) : pageName
  );
  const mainCastCount = useMainCastCount();
  // Nombre de lots de CAST_BATCH révélés en plus des acteurs principaux.
  const [castBatches, setCastBatches] = useState(0);
  const [newListName, setNewListName] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [markingSeries, setMarkingSeries] = useState(false);
  const { episodesBySeason, loadSeason } = useSeasonEpisodes(Number(id));
  const {
    isWatched,
    isInWatchlist,
    toggleWatched,
    toggleWatchlist,
    markSeriesWatched,
    getRating,
    rateWatched,
    customLists,
    isInList,
    addToList,
    removeFromList,
    createList,
  } = useLibrary();
  const { hasReminder, toggleReminder } = useReminders();
  const { region, regionName } = useRegion();
  const { locale } = useLocale();
  const { excludedGenreIds } = useExcludedGenres();
  const { isExcludedTitle, toggleExcludedTitle } = useExcludedTitles();
  const { requireMember } = useMembersOnly();
  const recommendationsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!mediaType || !id) {
      return;
    }
    let cancelled = false;
    setCastBatches(0);
    const ready = peekDetails(mediaType, id);
    if (ready) {
      setDetails(ready);
      setStatus("success");
      return;
    }
    setStatus("loading");
    setPreview(getMediaPreview(mediaType, id));
    getDetails(mediaType, id)
      .then((d) => {
        if (cancelled) {
          return;
        }
        setDetails(d);
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
    // `region` n'affecte pas la requête (getDetails renvoie déjà toutes les
    // régions dans `watch/providers`/`release_dates`) : les valeurs dérivées
    // de la région (providers, date ciné) sont recalculées à chaque rendu
    // plus bas, sans redéclencher ce fetch ni l'état "loading" — sinon un
    // changement de région (ex. détection async après le rendu initial en
    // région par défaut) provoquait un flash complet de la fiche (skeleton +
    // affiche qui semble ne se rafraîchir qu'au reload).
  }, [mediaType, id, reloadKey]);

  // Saute directement aux titres similaires si on arrive via le bouton "🔁".
  useEffect(() => {
    if (status === "success" && window.location.hash === "#recommendations") {
      recommendationsRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [status]);

  useEffect(() => {
    if (!linkCopied) {
      return;
    }
    const timer = setTimeout(() => setLinkCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [linkCopied]);

  if (!mediaType || !id) {
    return <NotFoundPage />;
  }

  function backLink(className: string) {
    return (
      <Link
        to="/"
        className={className}
        onClick={(e) => {
          // navigate(-1) déclenche un vrai retour arrière (POP), nécessaire
          // pour que useScrollRestoration restaure la position de la liste
          // d'origine — un <Link> classique crée une nouvelle entrée
          // d'historique (PUSH) et ne restaure jamais rien. Seulement si la
          // fiche n'est pas la première page de la session (clé "default") :
          // ouverte depuis un lien partagé, une notification ou un nouvel
          // onglet, reculer ferait quitter le site ; le lien mène alors à
          // l'accueil.
          if (location.key !== "default") {
            e.preventDefault();
            navigate(-1);
          }
        }}
      >
        {t("detailPage.back")}
      </Link>
    );
  }

  if (status === "loading") {
    return (
      <div className={styles.page}>
        {backLink(styles.backPlain)}
        <DetailSkeleton mediaType={mediaType} id={id} preview={preview} />
      </div>
    );
  }
  if (status === "error") {
    // Titre inexistant chez TMDB : vraie page « introuvable », pas un message
    // d'erreur technique (audit M11).
    if (error instanceof TmdbHttpError && error.status === 404) {
      return <NotFoundPage />;
    }
    return (
      <div className={styles.page}>
        {backLink(styles.backPlain)}
        <ErrorMessage error={error} onRetry={() => setReloadKey((key) => key + 1)} />
      </div>
    );
  }
  if (!details) {
    return null;
  }

  const title = details.title || details.name || t("common.unknownTitle");
  const originalTitle = details.original_title || details.original_name;
  const date = details.release_date || details.first_air_date;
  const providers = watchProvidersFromDetails(details, region);
  const runtime =
    details.runtime || details.episode_run_time?.[0] || details.last_episode_to_air?.runtime;
  const watched = isWatched(mediaType, id);
  const inWatchlist = isInWatchlist(mediaType, id);
  const excluded = isExcludedTitle(mediaType, id);
  const notifying = hasReminder(mediaType, Number(id));
  const accentKey = posterAccentFromGenres(
    details.genres?.map((g) => g.id),
    `${mediaType}:${id}`
  );
  const localeTag = dateLocaleTag(locale);

  const theatricalDate =
    mediaType === "movie" ? getTheatricalDateFromDetails(details, region) : null;
  // L'année de l'eyebrow et la date « Sortie » des infos suivent la même
  // source que le badge "au cinéma" : `details.release_date` est une date
  // globale TMDB indépendante de la région, alors que `theatricalDate` est
  // la sortie ciné réelle dans la région active.
  const displayDate = theatricalDate || date;
  // Pas de sens de proposer un rappel de sortie, ni de marquer "vu", pour un
  // titre déjà sorti : `displayDate` (et non `date`) pour rester cohérent
  // avec la date affichée à l'écran (ciné régional prioritaire sur la date
  // primaire TMDB, qui peut déjà être passée dans un autre pays).
  const isUpcoming = Boolean(displayDate && new Date(displayDate) > new Date());
  const theatricalStatus = theatricalStatusFromDate(theatricalDate);
  const theatricalDateFormatted = theatricalDate ? formatFullDate(theatricalDate, locale) : null;
  const theatricalMessage = theatricalStatus
    ? {
        in_theaters: t("detailPage.inTheatersNow", { date: theatricalDateFormatted }),
        upcoming: t("detailPage.upcomingTheatrical", { date: theatricalDateFormatted }),
        past: t("detailPage.pastTheatrical", { date: theatricalDateFormatted }),
      }[theatricalStatus]
    : null;

  const episodeBadge = mediaType === "tv" ? getSeriesEpisodeBadge(details) : null;
  const episodeBadgeDateFormatted = episodeBadge
    ? formatFullDate(episodeBadge.date, locale) || episodeBadge.date
    : null;
  const episodeBadgeMessage = episodeBadge
    ? episodeBadge.kind === "just_released"
      ? t("detailPage.episodeJustReleased", { date: episodeBadgeDateFormatted })
      : t("detailPage.episodeUpcoming", { date: episodeBadgeDateFormatted })
    : null;

  // Série : « Série · depuis 2022 · 2 saisons · ≈ 50 min/épisode ».
  const eyebrow = (
    mediaType === "movie"
      ? [t("detailPage.kindMovie"), displayDate?.slice(0, 4), runtime && formatRuntime(t, runtime)]
      : [
          t("detailPage.kindTv"),
          displayDate && t("detailPage.sinceYear", { year: displayDate.slice(0, 4) }),
          details.number_of_seasons &&
            t("detailPage.seasonsCount", { count: details.number_of_seasons }),
          runtime && t("detailPage.approxPerEpisode", { duration: formatRuntime(t, runtime) }),
        ]
  )
    .filter(Boolean)
    .join(" · ");

  // Série : casting de toutes les saisons (déjà trié par TMDB, rôles
  // principaux en tête), `credits` ne couvrant que la dernière saison.
  const aggregateCast = details.aggregate_credits?.cast;
  const cast: CastMember[] = aggregateCast?.length
    ? aggregateCast.map((member) => ({
        id: member.id,
        credit_id: member.roles?.[0]?.credit_id,
        name: member.name,
        character: member.roles
          ?.map((role) => role.character)
          .filter(Boolean)
          .join(" / "),
        profile_path: member.profile_path,
      }))
    : details.credits?.cast || [];
  const castExpanded = castBatches > 0;
  const visibleCast = cast.slice(0, mainCastCount + castBatches * CAST_BATCH);
  const castRemaining = cast.length - visibleCast.length;

  type DirectorEntry = { id: number; name: string };
  const directors: DirectorEntry[] =
    mediaType === "movie"
      ? (details.credits?.crew || [])
          .filter((c) => c.job === "Director")
          .map((c) => ({ id: c.id, name: c.name }))
      : (details.created_by || []).map((c) => ({ id: c.id, name: c.name }));

  const libItem = {
    id: Number(id),
    mediaType,
    title,
    posterPath: details.poster_path ?? null,
    // displayDate (sortie ciné régionale si connue) et pas `date` (date TMDB
    // globale) : sinon un ajout aux favoris/listes/rappels depuis cette fiche
    // stocke une date différente de celle affichée à l'écran juste au-dessus
    // (cause du ticket Trello sur les dates erronées en Prochainement/Ma liste).
    date: displayDate,
    genreIds: details.genres?.map((g) => g.id) || [],
    runtimeMinutes: estimateRuntimeMinutes(details, mediaType),
  };

  // TMDB n'a pas de paramètre d'exclusion par genre sur l'endpoint
  // recommandations : on filtre côté client sur les genres exclus.
  const recommendations = (details.recommendations?.results || []).filter(
    (item) => !item.genre_ids?.some((gId) => excludedGenreIds.includes(gId))
  );

  const listCount = customLists.filter((list) => isInList(list.id, mediaType, id)).length;

  const rating = watched ? getRating(mediaType, id) : null;

  // La note est portée par l'entrée « vu » de la bibliothèque : seul un titre
  // déjà vu peut être noté (les étoiles sont inactives sinon).
  function rate(value: number | null) {
    if (!mediaType || !id || !watched || !requireMember()) {
      return;
    }
    rateWatched(mediaType, id, value);
  }

  // « Marquer la série comme vue » coche tous les épisodes diffusés (listes
  // chargées saison par saison) ; « Série vue » la retire comme un film.
  // `watchedAt` optionnel : date de visionnage choisie via le sélecteur de
  // date plutôt que "maintenant" (voir le bouton calendrier dans .actions).
  async function toggleSeriesWatched(watchedAt?: number) {
    if (watched || !details?.seasons) {
      toggleWatched(libItem);
      return;
    }
    if (!requireMember()) {
      return;
    }
    setMarkingSeries(true);
    try {
      markSeriesWatched(libItem, await airedEpisodesUpTo(details.seasons, loadSeason), watchedAt);
    } finally {
      setMarkingSeries(false);
    }
  }

  // Déclenché par le sélecteur de date natif (bouton calendrier à côté de
  // "Vu") : marque directement le titre comme vu à la date choisie, plutôt
  // que de nécessiter un clic "Vu" séparé puis un changement de date.
  function handleWatchDateChange(e: ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    // Repart d'un champ vide : permet de resélectionner la même date plus
    // tard (un <input type="date"> ne redéclenche pas onChange sinon).
    e.target.value = "";
    if (!value) {
      return;
    }
    const watchedAt = new Date(`${value}T12:00:00`).getTime();
    if (Number.isNaN(watchedAt) || watchedAt > Date.now()) {
      return;
    }
    if (mediaType === "tv") {
      toggleSeriesWatched(watchedAt);
    } else {
      toggleWatched(libItem, watchedAt);
    }
  }

  function scrollToRecommendations() {
    recommendationsRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  function submitNewList() {
    const trimmed = newListName.trim();
    // Re-vérifié ici (déjà garanti par le early-return plus haut) : TypeScript
    // ne propage pas le rétrécissement de type d'une closure englobante dans
    // une déclaration de fonction imbriquée comme celle-ci.
    if (!trimmed || !mediaType || !id) {
      return;
    }
    const listId = createList(trimmed);
    if (listId) {
      addToList(listId, libItem);
      setNewListName("");
    }
  }

  function toggleExcluded() {
    // Écrit dans le compte comme les actions de la bibliothèque : réservé
    // aux membres connectés (voir MembersOnlyContext).
    if (requireMember() && mediaType && id) {
      toggleExcludedTitle(mediaType, id, date ? `${title} (${date.slice(0, 4)})` : title);
    }
  }

  // Feuille de partage native quand elle existe (mobile), sinon copie du
  // lien — même logique que le partage de profil / de liste.
  async function share() {
    const url = `${window.location.origin}/media/${mediaType}/${id}`;
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
      } catch {
        // Partage annulé par l'utilisateur : rien à faire.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
    } catch {
      window.prompt(t("detailPage.copyLinkPrompt"), url);
    }
  }

  const infoRows: { label: string; value: ReactNode }[] = [];
  if (directors.length > 0) {
    infoRows.push({
      label: mediaType === "movie" ? t("detailPage.directing") : t("detailPage.creation"),
      value: directors.map((d, i) => (
        <span key={d.id}>
          {i > 0 && ", "}
          <Link to={`/personne/${d.id}`} className={styles.infoLink}>
            {d.name}
          </Link>
        </span>
      )),
    });
  }
  if (originalTitle && originalTitle !== title) {
    infoRows.push({ label: t("detailPage.originalTitle"), value: originalTitle });
  }
  if (displayDate) {
    infoRows.push({
      label: mediaType === "movie" ? t("detailPage.releaseDate") : t("detailPage.firstAirDate"),
      value: formatFullDate(displayDate, locale) || displayDate,
    });
  }
  if (mediaType === "tv" && details.number_of_seasons) {
    infoRows.push({
      label: t("detailPage.seasons"),
      value: [
        t("detailPage.seasonsCount", { count: details.number_of_seasons }),
        details.number_of_episodes
          ? t("detailPage.episodesCount", { count: details.number_of_episodes })
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  // Série : durée, langue et pays passent dans l'eyebrow ou disparaissent
  // (maquette) au profit du statut de diffusion.
  const tvStatusKey = details.status ? TV_STATUS_KEYS[details.status] : undefined;
  if (mediaType === "tv" && tvStatusKey) {
    infoRows.push({ label: t("detailPage.status"), value: t(tvStatusKey) });
  }
  if (runtime && mediaType === "movie") {
    infoRows.push({
      label: t("detailPage.runtime"),
      value: formatRuntime(t, runtime),
    });
  }
  const language = languageName(details.original_language, localeTag);
  if (language && mediaType === "movie") {
    infoRows.push({ label: t("detailPage.language"), value: language });
  }
  if (
    mediaType === "movie" &&
    details.production_countries &&
    details.production_countries.length > 0
  ) {
    infoRows.push({
      label: t("detailPage.countries", { count: details.production_countries.length }),
      value: details.production_countries
        .map((c) => countryDisplayName(c.iso_3166_1, locale) || c.name)
        .join(", "),
    });
  }

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div
          className={styles.backdrop}
          style={
            details.backdrop_path
              ? { backgroundImage: `url(${backdropUrl(details.backdrop_path)})` }
              : undefined
          }
        />
        <div className={`${styles.halo} ${styles[`halo_${accentKey}`]}`} aria-hidden="true" />
        <div className={styles.heroInner}>
          {backLink(styles.back)}
          <div className={styles.posterWrap}>
            {details.poster_path ? (
              <img
                src={posterUrl(details.poster_path, "w342") ?? undefined}
                srcSet={posterSrcSet(details.poster_path)}
                sizes={DETAIL_POSTER_SIZES}
                alt={title}
                className={styles.poster}
                fetchPriority="high"
              />
            ) : (
              <div className={`${styles.poster} ${styles.posterEmpty} ${posterStyles[accentKey]}`}>
                {title}
              </div>
            )}
          </div>

          <div className={styles.heading}>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h1 className={styles.title}>{title}</h1>
          </div>

          <div className={styles.meta}>
            {details.genres && details.genres.length > 0 && (
              <ul className={styles.genres}>
                {details.genres.map((g) => (
                  <li key={g.id}>{g.name}</li>
                ))}
              </ul>
            )}
            {details.vote_average ? (
              <p className={styles.score}>
                <Icon name="star" filled />
                <b>
                  {details.vote_average.toLocaleString(localeTag, {
                    maximumFractionDigits: 1,
                    minimumFractionDigits: 1,
                  })}
                </b>
                <span className={styles.scoreOutOf}>/10</span>
                {details.vote_count ? (
                  <span className={styles.scoreVotes}>
                    ·{" "}
                    {t("detailPage.votesCount", {
                      count: details.vote_count,
                      formattedCount: details.vote_count.toLocaleString(localeTag),
                    })}
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>

          <div className={styles.details}>
            {theatricalMessage && (
              <p className={styles.statusPill}>
                <Icon name={theatricalStatus === "upcoming" ? "calendar" : "film"} />{" "}
                {theatricalMessage}
              </p>
            )}
            {episodeBadgeMessage && (
              <p className={styles.statusPill}>
                <Icon name={episodeBadge?.kind === "just_released" ? "sparkle" : "calendar"} />{" "}
                {episodeBadgeMessage}
              </p>
            )}
            <p className={styles.overview}>{details.overview || t("detailPage.noOverview")}</p>

            <div className={styles.actions}>
              {isUpcoming && (
                <button
                  type="button"
                  className={`${styles.actionBtn} ${notifying ? styles.wantOn : ""}`}
                  onClick={() => toggleReminder(libItem)}
                  aria-pressed={notifying}
                  title={t("detailPage.notifyTitle")}
                >
                  <Icon name="bell" />
                  <span className={styles.btnLabel}>
                    {notifying ? t("detailPage.notified") : t("detailPage.notifyMe")}
                  </span>
                </button>
              )}
              <button
                type="button"
                className={`${styles.actionBtn} ${inWatchlist ? styles.wantOn : ""}`}
                onClick={(e) => {
                  if (!inWatchlist) {
                    pop(e.currentTarget.firstElementChild);
                  }
                  toggleWatchlist(libItem);
                }}
                aria-pressed={inWatchlist}
              >
                <Icon name="star" filled={inWatchlist} />
                <span className={styles.btnLabel}>
                  {inWatchlist ? t("detailPage.wantToWatchOn") : t("detailPage.wantToWatchOff")}
                </span>
              </button>
              {/* Pas encore sorti (ciné ou plateforme) : le bouton "Vu" porterait à
                  confusion, donc masqué tant que rien n'a déjà été marqué vu. */}
              {(watched || !isUpcoming) && (
                <button
                  type="button"
                  className={`${styles.actionBtn} ${styles.watchedBtn} ${watched ? styles.watchedOn : ""}`}
                  onClick={(e) => {
                    if (!watched) {
                      pop(e.currentTarget.firstElementChild);
                    }
                    if (mediaType === "tv") {
                      toggleSeriesWatched();
                    } else {
                      toggleWatched(libItem);
                    }
                  }}
                  aria-pressed={watched}
                  disabled={markingSeries}
                >
                  <Icon name="check" strokeWidth={watched ? 3 : 2} />
                  <span className={styles.btnLabel}>
                    {mediaType === "tv"
                      ? watched
                        ? t("detailPage.seriesWatchedOn")
                        : t("detailPage.seriesWatchedOff")
                      : watched
                        ? t("detailPage.watchedOn")
                        : t("detailPage.watchedOff")}
                  </span>
                </button>
              )}
              {!watched && !isUpcoming && (
                <span className={styles.watchDateWrap}>
                  <span className={`${styles.actionBtn} ${styles.watchDateBtn}`} aria-hidden="true">
                    <Icon name="calendar" />
                  </span>
                  <input
                    type="date"
                    className={styles.watchDateInput}
                    max={new Date().toISOString().slice(0, 10)}
                    aria-label={t("detailPage.watchDateAriaLabel")}
                    title={t("detailPage.watchDateAriaLabel")}
                    disabled={markingSeries}
                    onChange={handleWatchDateChange}
                  />
                </span>
              )}
              <Dropdown
                label={
                  <>
                    <Icon name="list" />
                    {/* Mobile : « Listes » tout court (maquette), pour tenir
                        sur une ligne avec « Envie de voir » et « ⋯ ». */}
                    <span className={`${styles.btnLabel} ${styles.labelLong}`}>
                      {listCount > 0
                        ? t("detailPage.inLists", { count: listCount })
                        : t("detailPage.addToList")}
                    </span>
                    <span className={`${styles.btnLabel} ${styles.labelShort}`}>
                      {listCount > 0
                        ? t("detailPage.listsShortCount", { count: listCount })
                        : t("detailPage.listsShort")}
                    </span>
                  </>
                }
                pill
                active={listCount > 0}
                className={styles.listDropdown}
              >
                <div className={dropdownStyles.head}>{t("detailPage.addToListHeading")}</div>
                {customLists.length === 0 && (
                  <p className={styles.emptyHint}>{t("detailPage.noListsYet")}</p>
                )}
                {customLists.map((list) => {
                  const on = isInList(list.id, mediaType, id);
                  return (
                    <button
                      key={list.id}
                      type="button"
                      className={`${dropdownStyles.option} ${on ? dropdownStyles.optionOn : ""}`}
                      onClick={() =>
                        on ? removeFromList(list.id, mediaType, id) : addToList(list.id, libItem)
                      }
                    >
                      <span className={dropdownStyles.check}>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={3}
                          aria-hidden="true"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                      {list.name}
                    </button>
                  );
                })}
                <div className={styles.newListRow}>
                  <input
                    type="text"
                    aria-label={t("detailPage.createListLabel")}
                    placeholder={t("detailPage.createListPlaceholder")}
                    maxLength={40}
                    value={newListName}
                    onChange={(e) => setNewListName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submitNewList()}
                  />
                  <button type="button" onClick={submitNewList}>
                    {t("detailPage.create")}
                  </button>
                </div>
              </Dropdown>
              <TrailerButton videos={details.videos?.results} className={styles.trailerBtn} />
              <Dropdown
                label={<Icon name="more" size={20} />}
                ariaLabel={t("detailPage.moreActions")}
                caret={false}
                closeOnSelect
                align="right"
                pill
                className={styles.moreDropdown}
              >
                <button type="button" className={dropdownStyles.option} onClick={share}>
                  <Icon name="share" />
                  {t("detailPage.share")}
                </button>
                {recommendations.length > 0 && (
                  <button
                    type="button"
                    className={dropdownStyles.option}
                    onClick={scrollToRecommendations}
                  >
                    <Icon name="repeat" />
                    {t("detailPage.similar")}
                  </button>
                )}
                <button
                  type="button"
                  className={dropdownStyles.option}
                  onClick={toggleExcluded}
                  title={t("detailPage.excludeTitleHint")}
                >
                  <Icon name="ban" />
                  {excluded ? t("detailPage.reinclude") : t("detailPage.excludeTitle")}
                </button>
              </Dropdown>
            </div>

            {linkCopied && (
              <p className={styles.copied} role="status">
                <Icon name="check" strokeWidth={3} /> {t("detailPage.linkCopied")}
              </p>
            )}

            {excluded && (
              <div className={styles.excludedBanner}>
                <Icon name="ban" />
                <span>{t("detailPage.excludedBanner")}</span>
                <button type="button" onClick={toggleExcluded}>
                  {t("detailPage.reinclude")}
                </button>
              </div>
            )}

            <div className={styles.yourRating}>
              <p className={styles.yourRatingHead}>
                <span className="eyebrow">{t("detailPage.yourRatingHeading")}</span>
                {rating != null ? (
                  <>
                    <b className={styles.yourRatingValue}>{rating}/10</b>
                    <span>{t(STAR_LABEL_KEYS[rating - 1])}</span>
                  </>
                ) : (
                  <>
                    <span className={styles.yourRatingDash} aria-hidden="true" />
                    <span>
                      {t(watched ? "ratingStars.notRatedYet" : "detailPage.rateAfterWatched")}
                    </span>
                  </>
                )}
              </p>
              <RatingStars value={rating} onRate={rate} clearable hideValue disabled={!watched} />
            </div>
          </div>
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.main}>
          {mediaType === "tv" && details.seasons && details.seasons.length > 0 && (
            <EpisodeTracker
              item={libItem}
              seasons={details.seasons}
              episodesBySeason={episodesBySeason}
              loadSeason={loadSeason}
              episodeBadge={episodeBadge}
              nextEpisodeToAir={details.next_episode_to_air}
            />
          )}

          <WhereToWatch
            providers={providers}
            regionName={regionName}
            className={styles.whereToWatch}
          />

          {cast.length > 0 && (
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h2>{t("detailPage.mainCast")}</h2>
                {cast.length > mainCastCount && (
                  <button
                    type="button"
                    className={styles.textBtn}
                    onClick={() => setCastBatches(castExpanded ? 0 : 1)}
                    aria-expanded={castExpanded}
                  >
                    {castExpanded
                      ? t("detailPage.showLessCast")
                      : t("detailPage.showFullCast", { count: cast.length })}
                  </button>
                )}
              </div>
              <div className={styles.castGrid}>
                {visibleCast.map((member) => (
                  <PersonCard
                    key={member.credit_id || `${member.id}-${member.character}`}
                    id={member.id}
                    name={member.name}
                    profilePath={member.profile_path}
                    role={member.character}
                  />
                ))}
              </div>
              {castExpanded && castRemaining > 0 && (
                <div className={styles.castMore}>
                  <span className={styles.castMoreCount}>
                    {t("detailPage.castShown", { shown: visibleCast.length, total: cast.length })}
                  </span>
                  <button
                    type="button"
                    className={styles.castMoreBtn}
                    onClick={() => setCastBatches((batches) => batches + 1)}
                  >
                    {t("detailPage.showMoreCast", { count: Math.min(CAST_BATCH, castRemaining) })}
                  </button>
                </div>
              )}
            </section>
          )}

          {mediaType === "movie" && details.belongs_to_collection && (
            <CollectionSection
              collectionId={details.belongs_to_collection.id}
              currentMovieId={Number(id)}
            />
          )}
        </div>

        <aside className={styles.aside}>
          <FollowingActivity mediaType={mediaType} id={id} />
          {infoRows.length > 0 && (
            <section className={styles.infoCard}>
              <h2>{t("detailPage.infos")}</h2>
              <dl className={styles.infoList}>
                {infoRows.map((row) => (
                  <div key={row.label} className={styles.infoRow}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </aside>
      </div>

      {recommendations.length > 0 && (
        <section className={styles.section} ref={recommendationsRef}>
          <div className={styles.sectionHead}>
            <h2>{t("detailPage.ifYouLiked", { title })}</h2>
          </div>
          <div className={gridStyles.grid}>
            {recommendations.slice(0, 12).map((item) => (
              <MediaCard
                key={item.id}
                item={{ ...item, mediaType: item.media_type || mediaType }}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
