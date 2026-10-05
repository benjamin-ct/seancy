import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { posterUrl } from "../../../core/api/tmdb.ts";
import { useLibrary } from "../../../core/context/LibraryContext.tsx";
import { Icon, MediaCard } from "../../../shared/components/index.ts";
import { libraryItemToMediaItem } from "../../../shared/lib/libraryItem.ts";
import { posterAccentFromGenres } from "../../../shared/lib/posterAccent.ts";
import posterStyles from "../../../shared/styles/posterAccents.module.css";
import cardStyles from "../../../shared/components/MediaCard/MediaCard.module.css";
import type { LibraryItem } from "../../../core/types/library.ts";
import styles from "./PublicTopPicks.module.css";

interface Props {
  items: LibraryItem[];
  ownerName: string;
  genreNames: Record<number, string>;
}

const RANK_CLASS = ["rank1", "rank2", "rank3", "rankOutline", "rankOutline"];

function makeKey(item: LibraryItem): string {
  return `${item.mediaType}:${item.id}`;
}

// Pastilles Envie / Vu d'une ligne mobile, empilées : comme sur les
// MediaCard, elles agissent sur la liste du visiteur.
function Pastilles({ item }: { item: LibraryItem }) {
  const { t } = useTranslation();
  const { isWatched, isInWatchlist, toggleWatched, toggleWatchlist } = useLibrary();
  const watched = isWatched(item.mediaType, item.id);
  const inWatchlist = isInWatchlist(item.mediaType, item.id);
  // Pas encore sorti (ciné ou plateforme) : le bouton "Vu" porterait à
  // confusion, donc masqué tant que rien n'a déjà été marqué vu (voir
  // MediaCard.tsx, même logique sur les cartes).
  const isUpcoming = Boolean(item.date && new Date(item.date) > new Date());
  const libItem = {
    id: item.id,
    mediaType: item.mediaType,
    title: item.title,
    posterPath: item.posterPath,
    date: item.date,
    genreIds: item.genreIds,
  };
  return (
    <div className={styles.pastilles}>
      <button
        type="button"
        className={`${cardStyles.pastille} ${inWatchlist ? cardStyles.pastilleWant : ""}`}
        onClick={() => toggleWatchlist(libItem)}
        aria-pressed={inWatchlist}
        aria-label={t("mediaCard.wantToWatch")}
        title={t("mediaCard.wantToWatch")}
      >
        <Icon name="star" size={16} strokeWidth={inWatchlist ? 2 : 1.5} filled={inWatchlist} />
      </button>
      {(watched || !isUpcoming) && (
        <button
          type="button"
          className={`${cardStyles.pastille} ${watched ? cardStyles.pastilleWatched : ""}`}
          onClick={() => toggleWatched(libItem)}
          aria-pressed={watched}
          aria-label={t("mediaCard.markAsWatched")}
          title={t("mediaCard.markAsWatched")}
        >
          <Icon name="check" size={16} strokeWidth={watched ? 3 : 1.5} />
        </button>
      )}
    </div>
  );
}

// Top 5 choisi par le propriétaire (voir TopPicksPanel dans Ma liste), en
// lecture seule : une ligne de 5 affiches précédées de grands chiffres sur
// desktop (or, argent, bronze pleins puis 4 et 5 en contour), une liste
// verticale lisible sur mobile.
export default function PublicTopPicks({ items, ownerName, genreNames }: Props) {
  const { t } = useTranslation();
  const genreOf = (item: LibraryItem) =>
    (item.genreIds ?? []).map((id) => genreNames[id]).find(Boolean);

  return (
    <section className={styles.section} aria-labelledby="public-top-title">
      <div className={styles.head}>
        <h2 id="public-top-title" className={styles.title}>
          {t("publicProfile.topTitle", { name: ownerName })}
        </h2>
        <p className={styles.subtitle}>{t("publicProfile.topSubtitle")}</p>
      </div>

      <ol className={styles.row}>
        {items.map((item, index) => (
          <li key={makeKey(item)} className={styles.slot}>
            <span
              className={`${styles.rank} ${styles[RANK_CLASS[index]]}`}
              aria-label={t("mediaCard.rank", { rank: index + 1 })}
            >
              {index + 1}
            </span>
            <MediaCard
              item={libraryItemToMediaItem(item)}
              ownerRating={item.rating}
              yearGenre
              genreName={genreOf(item)}
            />
          </li>
        ))}
      </ol>

      <ol className={styles.list}>
        {items.map((item, index) => {
          const key = makeKey(item);
          const src = posterUrl(item.posterPath, "w92");
          const sub = [
            item.mediaType === "movie" ? t("mediaCard.movie") : t("mediaCard.series"),
            item.date?.slice(0, 4),
            genreOf(item),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={key} className={styles.line}>
              <span className={`${styles.lineRank} ${styles[RANK_CLASS[index]]}`} aria-hidden>
                {index + 1}
              </span>
              <Link to={`/media/${item.mediaType}/${item.id}`} className={styles.lineLink}>
                <span className={styles.thumb}>
                  {src ? (
                    <img src={src} alt="" loading="lazy" />
                  ) : (
                    <span className={posterStyles[posterAccentFromGenres(item.genreIds, key)]} />
                  )}
                </span>
                <span className={styles.lineBody}>
                  <span className={styles.lineTitle}>{item.title}</span>
                  <span className={styles.lineSub}>{sub}</span>
                  {item.rating != null && (
                    <span className={styles.lineRating}>
                      <Icon name="star" size={12} filled />{" "}
                      {t("publicProfile.ownerRating", { rating: item.rating, name: ownerName })}
                    </span>
                  )}
                </span>
              </Link>
              <Pastilles item={item} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
