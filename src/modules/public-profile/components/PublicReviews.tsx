import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { posterUrl } from "../../../core/api/tmdb.ts";
import { Icon } from "../../../shared/components/index.ts";
import { posterAccentFromGenres } from "../../../shared/lib/posterAccent.ts";
import posterStyles from "../../../shared/styles/posterAccents.module.css";
import type { LibraryItem } from "../../../core/types/library.ts";
import styles from "./PublicReviews.module.css";

interface Props {
  /** Titres vus qui portent un avis texte, déjà triés (plus récent d'abord). */
  items: LibraryItem[];
  ownerName: string;
}

// Onglet « Avis » du profil public : les avis texte laissés par le
// propriétaire sur ses titres vus (voir DetailPage, bloc « Votre avis »),
// avec sa note. Chaque ligne mène à la fiche du titre.
export default function PublicReviews({ items, ownerName }: Props) {
  const { t } = useTranslation();
  return (
    <ul className={styles.list}>
      {items.map((item) => {
        const src = posterUrl(item.posterPath, "w185");
        const year = item.date ? item.date.slice(0, 4) : null;
        return (
          <li key={`${item.mediaType}:${item.id}`} className={styles.card}>
            <Link
              to={`/media/${item.mediaType}/${item.id}`}
              className={`${styles.poster} ${posterStyles[posterAccentFromGenres(item.genreIds, `${item.mediaType}:${item.id}`)]}`}
              aria-hidden="true"
              tabIndex={-1}
            >
              {src && <img src={src} alt="" loading="lazy" />}
            </Link>
            <div className={styles.body}>
              <p className={styles.head}>
                <Link to={`/media/${item.mediaType}/${item.id}`} className={styles.title}>
                  {item.title}
                </Link>
                {year && <span className={styles.year}>{year}</span>}
                {item.rating != null && (
                  <span
                    className={styles.rating}
                    aria-label={t("publicProfile.ownerRating", {
                      rating: item.rating,
                      name: ownerName,
                    })}
                  >
                    <Icon name="star" size={13} filled />
                    {item.rating}/10
                  </span>
                )}
              </p>
              <p className={styles.text}>{item.reviewText}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
