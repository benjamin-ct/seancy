import { memo, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  posterUrl,
  posterSrcSet,
  logoUrl,
  getWatchProviders,
  formatFullDate,
} from "../../../core/api/tmdb.ts";
import { useNearViewport } from "../../hooks/useNearViewport.ts";
import { useLibrary } from "../../../core/context/LibraryContext.tsx";
import { useIsWatched, useIsInWatchlist } from "../../../core/context/useLibrarySelectors.ts";
import { useRegion } from "../../../core/context/RegionContext.tsx";
import { useLocale } from "../../../core/context/LocaleContext.tsx";
import { posterAccentFromGenres } from "../../lib/posterAccent.ts";
import { setMediaPreview } from "../../lib/mediaPreviewCache.ts";
import { pop } from "../../lib/motion.ts";
import type {
  MediaItem,
  RegionWatchProviders,
  WatchProviderEntry,
} from "../../../core/types/tmdb.ts";
import Icon, { type IconName } from "../Icon/Icon.tsx";
import posterStyles from "../../styles/posterAccents.module.css";
import styles from "./MediaCard.module.css";

interface MediaCardProps {
  item: MediaItem;
  /** Opt-in, seule Nouveautés l'active (contenus déjà sortis). Contrairement
   * à la pastille théâtrale (indexée une fois pour toute la grille, voir
   * getTheatricalStatusIndex), TMDB n'a pas d'équivalent en masse pour
   * "quelles plateformes pour ces N titres" — un appel par carte est ici
   * incontournable. Le scope opt-in limite où ce coût est payé. */
  showProviderBadge?: boolean;
  /** Opt-in, seul le Top 5 du profil partagé l'utilise : rang affiché en
   * médaillon en haut à gauche de l'affiche (le badge Film/Série se décale
   * à sa droite). */
  rank?: number;
  /** Opt-in (Découvrir, nouvelle DA) : sous le titre, « année · genre » au
   * lieu de la date complète. Le nom du genre est résolu par la page, qui a
   * déjà la liste des genres TMDB (une chaîne plutôt qu'un tableau pour ne
   * pas casser le memo). */
  yearGenre?: boolean;
  genreName?: string;
  /** Opt-in (profil et liste publics) : note du propriétaire de la page, en
   * pastille dorée en haut à droite de l'affiche. Les pastilles Envie / Vu,
   * elles, restent celles du visiteur. */
  ownerRating?: number | null;
  /** Opt-in (liste publique, tri « Ordre de X ») : numéro « 01 », « 02 »…
   * à la place du badge Film / Série. */
  position?: number;
}

// Largeur affichée des affiches de la grille (voir mediaGrid.module.css : 2,
// 4 puis 6 colonnes) : sert au navigateur à choisir w185 ou w342 dans le
// srcset (audit M9).
const CARD_POSTER_SIZES = "(max-width: 720px) 50vw, (max-width: 1080px) 25vw, 170px";

// `memo` : les grilles (Découvrir, Nouveautés, Ma liste...) affichent des
// dizaines de cartes dont les props (`item`) restent stables d'un rendu à
// l'autre — évite de re-rendre toute la grille quand seul un état non lié
// au grid change dans le composant parent (ouverture d'un filtre...).
function MediaCard({
  item,
  showProviderBadge = false,
  rank,
  yearGenre = false,
  genreName,
  ownerRating,
  position,
}: MediaCardProps) {
  const { t } = useTranslation();
  const { toggleWatched, toggleWatchlist } = useLibrary();
  const { getTheatricalStatus, region } = useRegion();
  const { locale } = useLocale();
  const theatricalBadges: Record<string, string> = {
    in_theaters: t("mediaCard.inTheaters"),
    upcoming: t("mediaCard.upcomingTheatrical"),
  };
  const theatricalIcons: Record<string, IconName> = { in_theaters: "film", upcoming: "calendar" };
  const mediaType = item.mediaType;
  const title = item.title || item.name || t("common.unknownTitle");
  // item.region_release_date (résolu côté Worker, voir discover() avec
  // includeRegionReleaseDate) est la date de sortie ciné région-consciente ;
  // item.release_date est la date "primaire" globale de TMDB, pas fiable
  // pour la région active (voir worker/index.ts,
  // enrichDiscoverResultsWithRegionDate). `null` (enrichi, rien trouvé pour
  // cette région) retombe correctement sur item.release_date via `||`.
  const date = item.region_release_date || item.release_date || item.first_air_date;
  const watched = useIsWatched(mediaType, item.id);
  const inWatchlist = useIsInWatchlist(mediaType, item.id);

  // Alimente le cache de préview (voir mediaPreviewCache) pour que la fiche
  // (DetailPage) puisse préafficher affiche/titre/date pendant son propre
  // chargement, plutôt qu'un écran vide — ce sont les mêmes infos que
  // celles déjà affichées ici.
  useEffect(() => {
    setMediaPreview(mediaType, item.id, { title, posterPath: item.poster_path ?? null, date });
  }, [mediaType, item.id, title, item.poster_path, date]);

  // Statut "au cinéma" (France) : uniquement pour les films (les séries
  // n'ont pas de notion de sortie en salle). L'appartenance à l'index
  // (now_playing/upcoming) dit seulement "ce film a une distribution en
  // salle" — TMDB inclut dans now_playing une fenêtre qui peut déborder
  // sur des sorties très proches mais pas encore effectives, donc le
  // libellé final est tranché par la vraie date de sortie.
  const inTheatricalIndex = mediaType === "movie" ? getTheatricalStatus(item.id) : null;
  const todayIso = new Date().toISOString().slice(0, 10);
  const theatricalStatus =
    inTheatricalIndex && date ? (date <= todayIso ? "in_theaters" : "upcoming") : inTheatricalIndex;
  // Pas encore sorti (ciné ou plateforme) : le bouton "Vu" porterait à
  // confusion, donc masqué tant que rien n'a déjà été marqué vu (voir
  // DetailPage.tsx, même logique sur la fiche).
  const isUpcoming = Boolean(date && date > todayIso);

  // Charger le badge (plateforme ou prochaine sortie) seulement quand la
  // carte approche du viewport : une grille de Nouveautés/Prochainement
  // affiche ~20 cartes d'un coup, et sans ça les ~20 appels par carte
  // partent tous en parallèle dès le montage, y compris pour les cartes
  // hors écran — pic qui épuise le quota de la clé TMDB partagée.
  const posterRef = useRef<HTMLDivElement>(null);
  const isNearViewport = useNearViewport(posterRef, showProviderBadge);

  const [provider, setProvider] = useState<WatchProviderEntry | null>(null);
  // Distingue "pas encore vérifié" de "vérifié, rien trouvé".
  const [providerStatus, setProviderStatus] = useState<"idle" | "loading" | "done">("idle");
  useEffect(() => {
    if (!showProviderBadge || !isNearViewport) {
      return;
    }
    // Abonnement en priorité (le plus pertinent pour "où le regarder"),
    // sinon location/achat ; rien si le titre n'est encore distribué nulle
    // part (fréquent sur Prochainement) — pas de badge affiché.
    const pickBadge = (data: RegionWatchProviders | null | undefined) =>
      data?.flatrate?.[0] || data?.rent?.[0] || data?.buy?.[0] || null;
    // Déjà résolu côté Worker (discover() appelé avec includeProviderBadge,
    // voir NewReleasesPage) : `undefined` distingue "pas demandé" (fallback
    // ci-dessous) de "demandé, rien trouvé" (`null`), qui doit rester sans
    // appel réseau.
    if (item.watch_providers !== undefined) {
      setProvider(pickBadge(item.watch_providers));
      setProviderStatus("done");
      return;
    }
    let cancelled = false;
    setProviderStatus("loading");
    getWatchProviders(mediaType, item.id, region)
      .then((data) => {
        if (cancelled) {
          return;
        }
        setProvider(pickBadge(data));
        setProviderStatus("done");
      })
      .catch(() => {
        if (!cancelled) {
          setProviderStatus("done");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showProviderBadge, isNearViewport, mediaType, item.id, item.watch_providers, region]);

  // Sur Nouveautés, un titre sans badge cinéma ET sans plateforme connue
  // est ambigu : on le dit explicitement plutôt que de laisser un badge
  // muet passer pour un oubli.
  const hasTheatricalBadge = Boolean(theatricalStatus && theatricalBadges[theatricalStatus]);
  const showUnknownStatus =
    showProviderBadge && providerStatus === "done" && !provider && !hasTheatricalBadge;

  const displayDate = yearGenre
    ? [date?.slice(0, 4), genreName].filter(Boolean).join(" · ") || "—"
    : formatFullDate(date, locale) || (date ? date.slice(0, 4) : "—");

  const libItem = {
    id: item.id,
    mediaType,
    title,
    posterPath: item.poster_path ?? null,
    date,
    genreIds: item.genre_ids || [],
  };

  const accentKey = posterAccentFromGenres(item.genre_ids, `${mediaType}:${item.id}`);

  return (
    <div className={styles.card}>
      <Link to={`/media/${mediaType}/${item.id}`} className={styles.link}>
        <div className={styles.poster} ref={posterRef}>
          {item.poster_path ? (
            <img
              src={posterUrl(item.poster_path) ?? undefined}
              srcSet={posterSrcSet(item.poster_path)}
              sizes={CARD_POSTER_SIZES}
              // Décorative : le titre est déjà lu dans le lien, juste dessous.
              alt=""
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className={`${styles.noPoster} ${posterStyles[accentKey]}`} aria-hidden="true">
              {title}
            </div>
          )}
          {rank != null && (
            <span
              className={`${styles.rank} ${rank <= 3 ? styles[`rank${rank}`] : ""}`}
              aria-label={t("mediaCard.rank", { rank })}
            >
              {rank}
            </span>
          )}
          {position != null ? (
            <span className={styles.type} aria-label={t("mediaCard.position", { position })}>
              {String(position).padStart(2, "0")}
            </span>
          ) : (
            <span className={styles.type}>
              {mediaType === "movie" ? t("mediaCard.movie") : t("mediaCard.series")}
            </span>
          )}
          {ownerRating != null && (
            <span
              className={styles.ownerRating}
              aria-label={t("mediaCard.ownerRating", { rating: ownerRating })}
            >
              <Icon name="star" size={11} filled /> {ownerRating}
            </span>
          )}
          {hasTheatricalBadge && theatricalStatus && (
            <span className={styles.theatrical}>
              <Icon name={theatricalIcons[theatricalStatus]} /> {theatricalBadges[theatricalStatus]}
            </span>
          )}
          {showUnknownStatus && (
            <span className={`${styles.theatrical} ${styles.theatricalUnknown}`}>
              <Icon name="help" /> {t("mediaCard.unknownReleaseStatus")}
            </span>
          )}
          {provider?.logo_path && (
            <span className={styles.provider} title={provider.provider_name}>
              <img
                src={logoUrl(provider.logo_path, "w45") ?? undefined}
                alt={provider.provider_name}
                loading="lazy"
                decoding="async"
              />
            </span>
          )}
        </div>
        <div className={styles.info}>
          <p className={styles.title} title={title}>
            {title}
          </p>
          <p className={styles.year}>{displayDate}</p>
        </div>
      </Link>
      {/* Pastilles Envie / Vu : toujours visibles, posées sur l'affiche mais
          hors du <Link> (pas de bouton imbriqué dans un lien). */}
      <div className={styles.pastilles}>
        <button
          type="button"
          className={`${styles.pastille} ${inWatchlist ? styles.pastilleWant : ""}`}
          onClick={(e) => {
            if (!inWatchlist) {
              pop(e.currentTarget.firstElementChild);
            }
            toggleWatchlist(libItem);
          }}
          aria-pressed={inWatchlist}
          aria-label={t("mediaCard.wantToWatchNamed", { title })}
          title={t("mediaCard.wantToWatch")}
        >
          <Icon name="star" size={16} strokeWidth={inWatchlist ? 2 : 1.5} filled={inWatchlist} />
        </button>
        {(watched || !isUpcoming) && (
          <button
            type="button"
            className={`${styles.pastille} ${watched ? styles.pastilleWatched : ""}`}
            onClick={(e) => {
              if (!watched) {
                pop(e.currentTarget.firstElementChild);
              }
              toggleWatched(libItem);
            }}
            aria-pressed={watched}
            aria-label={t("mediaCard.markAsWatchedNamed", { title })}
            title={t("mediaCard.markAsWatched")}
          >
            <Icon name="check" size={16} strokeWidth={watched ? 3 : 1.5} />
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(MediaCard);
