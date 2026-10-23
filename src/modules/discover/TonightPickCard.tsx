import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { backdropUrl, posterSrcSet, posterUrl } from "../../core/api/tmdb.ts";
import { useLibrary } from "../../core/context/LibraryContext.tsx";
import { Icon } from "../../shared/components/index.ts";
import { posterAccentFromGenres } from "../../shared/lib/posterAccent.ts";
import { usePosterThumbhash } from "../../shared/lib/thumbhash.ts";
import type { MediaSummary, MediaType } from "../../core/types/tmdb.ts";
import posterStyles from "../../shared/styles/posterAccents.module.css";
import skeletonStyles from "../../shared/styles/skeleton.module.css";
import styles from "./TonightPick.module.css";

interface TonightPickCardProps {
  mediaType: MediaType;
  item: MediaSummary;
  /** Passés à part : la fiche TMDB complète (suggestions IA) ne porte que
   * `genres`, les résultats de discover (tirage populaire) que `genre_ids`. */
  genreIds: number[];
  genreName?: string;
  onSkip: () => void;
}

/** Carte « Pour vous ce soir » (en tête de Découvrir, nouvelle DA) : grand
 * bloc avec spot doré sur desktop, carte compacte (~130 px) sur mobile.
 * Commune aux suggestions IA (comptes connectés) et au tirage populaire
 * côté client (visiteurs, repli) — voir TonightPick. */
export default function TonightPickCard({
  mediaType,
  item,
  genreIds,
  genreName,
  onSkip,
}: TonightPickCardProps) {
  const { t } = useTranslation();
  const { isInWatchlist, toggleWatchlist } = useLibrary();
  const {
    hasThumbhash,
    loaded: posterLoaded,
    backgroundStyle: posterThumbhashStyle,
    imgRef: posterImgRef,
    onLoad: handlePosterLoad,
    onError: handlePosterError,
  } = usePosterThumbhash(item.poster_thumbhash);

  const title = item.title || item.name || t("common.unknownTitle");
  const date = item.release_date || item.first_air_date;
  const meta = [date?.slice(0, 4), genreName].filter(Boolean).join(" · ");
  const inWatchlist = isInWatchlist(mediaType, item.id);
  const accentKey = posterAccentFromGenres(genreIds, `${mediaType}:${item.id}`);
  // w780 suffit : le fond n'est affiché qu'à 35 % d'opacité (audit M9).
  const backdrop = backdropUrl(item.backdrop_path, "w780");
  const detailUrl = `/media/${mediaType}/${item.id}`;

  return (
    <section className={styles.hero} aria-labelledby="tonight-title">
      <button
        type="button"
        className={styles.skipIcon}
        onClick={onSkip}
        aria-label={t("tonightPick.another")}
        title={t("tonightPick.another")}
      >
        <Icon name="refresh" size={16} />
      </button>
      {backdrop && (
        <div className={styles.backdrop} style={{ backgroundImage: `url(${backdrop})` }} />
      )}
      <Link
        to={detailUrl}
        className={styles.poster}
        style={posterThumbhashStyle}
        tabIndex={-1}
        aria-hidden="true"
      >
        {item.poster_path ? (
          <img
            ref={posterImgRef}
            src={posterUrl(item.poster_path) ?? undefined}
            srcSet={posterSrcSet(item.poster_path)}
            sizes="(max-width: 860px) 87px, 180px"
            alt=""
            fetchPriority="high"
            className={
              hasThumbhash ? (posterLoaded ? styles.posterLoaded : styles.posterLoading) : undefined
            }
            onLoad={handlePosterLoad}
            onError={handlePosterError}
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
          {item.vote_average ? (
            <span className={styles.rating}>
              {meta ? " · " : ""}
              <Icon name="star" filled size={13} /> {item.vote_average.toFixed(1)}
            </span>
          ) : null}
        </p>
        {item.overview && <p className={styles.overview}>{item.overview}</p>}
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
                id: item.id,
                mediaType,
                title,
                posterPath: item.poster_path ?? null,
                date,
                genreIds,
              })
            }
          >
            <Icon name="star" filled={inWatchlist} /> {t("mediaCard.wantToWatch")}
          </button>
          <button type="button" className={styles.secondary} onClick={onSkip}>
            <Icon name="refresh" /> {t("tonightPick.another")}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Même bloc, sans titre à afficher : génération en cours (`busy`, affiche
 * en pulsation) ou plus rien à proposer aujourd'hui. */
export function TonightPickMessage({
  title,
  children,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section
      className={`${styles.hero} ${busy ? styles.messageBusy : styles.messageTextOnly}`}
      aria-labelledby="tonight-title"
      aria-busy={busy}
      aria-live="polite"
    >
      {busy && <div className={`${styles.poster} ${skeletonStyles.block}`} aria-hidden="true" />}
      <div className={styles.body}>
        <p className={styles.eyebrow}>
          <Icon name="sparkle" /> {t("tonightPick.eyebrow")}
        </p>
        <h2 id="tonight-title" className={styles.messageTitle}>
          {title}
        </h2>
        <p className={styles.messageText}>{children}</p>
      </div>
    </section>
  );
}
