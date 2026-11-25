import { posterUrl, posterSrcSet, formatFullDate } from "../../../core/api/tmdb.ts";
import { useLocale } from "../../../core/context/LocaleContext.tsx";
import type { MediaPreview } from "../../../shared/lib/mediaPreviewCache.ts";
import { posterAccentFromSeed } from "../../../shared/lib/posterAccent.ts";
import type { MediaType } from "../../../core/types/tmdb.ts";
import gridStyles from "../../../shared/styles/mediaGrid.module.css";
import posterStyles from "../../../shared/styles/posterAccents.module.css";
import skeletonStyles from "../../../shared/styles/skeleton.module.css";
import pageStyles from "../DetailPage.module.css";
import styles from "./DetailSkeleton.module.css";

const CAST_PLACEHOLDER_COUNT = 6;

interface DetailSkeletonProps {
  mediaType: MediaType;
  id: string;
  preview: MediaPreview | null;
}

// Largeur affichée de l'affiche de la fiche (voir DetailPage.module.css).
// Partagée avec DetailPage : même srcset et même sizes, donc le navigateur
// choisit le même fichier et la fiche réutilise l'image du squelette.
export const DETAIL_POSTER_SIZES = "(max-width: 720px) 120px, 280px";

// Remplace l'ancien écran "Chargement…" plein écran : préaffiche affiche
// / titre / date si on les connaît déjà (voir mediaPreviewCache — venant de
// la grille ou de la recherche d'où on arrive), et affiche des blocs
// grisés à la place du reste le temps que l'appel /movie ou /tv réponde.
export default function DetailSkeleton({ mediaType, id, preview }: DetailSkeletonProps) {
  // Les genres (qui pilotent normalement la clé d'accent, voir
  // posterAccentFromGenres côté DetailPage) ne sont connus qu'une fois
  // /movie ou /tv répondu — on retombe ici sur le même hash déterministe
  // que posterAccentFromGenres utilise déjà en repli, pour que le cadre
  // hero ne reste pas plat/sans couleur pendant le chargement.
  const accentKey = posterAccentFromSeed(`${mediaType}:${id}`);
  const { locale } = useLocale();
  return (
    <>
      <div className={`${pageStyles.hero} ${styles.hero} ${posterStyles[accentKey]}`}>
        <div className={pageStyles.heroOverlay} />
        <div className={pageStyles.heroInner}>
          <div className={pageStyles.posterWrap}>
            {preview?.posterPath ? (
              <div className={pageStyles.posterFrame}>
                <img
                  src={posterUrl(preview.posterPath, "w342") ?? undefined}
                  srcSet={posterSrcSet(preview.posterPath)}
                  sizes={DETAIL_POSTER_SIZES}
                  alt={preview.title}
                  className={pageStyles.poster}
                  fetchPriority="high"
                />
              </div>
            ) : (
              <div className={`${pageStyles.posterFrame} ${skeletonStyles.block}`} />
            )}
          </div>
          <div className={pageStyles.info}>
            {preview?.title ? (
              <h1 className={pageStyles.title}>
                {preview.title}{" "}
                {preview.date && (
                  <span className={pageStyles.year}>
                    ({formatFullDate(preview.date, locale) || preview.date.slice(0, 4)})
                  </span>
                )}
              </h1>
            ) : (
              <div className={`${skeletonStyles.block} ${styles.barTitle}`} />
            )}
            <div className={`${skeletonStyles.block} ${styles.barMeta}`} />
            <div className={`${skeletonStyles.block} ${styles.barLine}`} />
            <div className={`${skeletonStyles.block} ${styles.barLine}`} />
            <div className={`${skeletonStyles.block} ${styles.barLineShort}`} />
            <div className={styles.actionsSkeleton}>
              <div className={`${skeletonStyles.block} ${styles.pill}`} />
              <div className={`${skeletonStyles.block} ${styles.pill}`} />
            </div>
          </div>
        </div>
      </div>

      <section className={pageStyles.section}>
        <div className={`${skeletonStyles.block} ${styles.sectionTitle}`} />
        <div className={styles.providersSkeleton}>
          <div className={`${skeletonStyles.block} ${styles.providerLogo}`} />
          <div className={`${skeletonStyles.block} ${styles.providerLogo}`} />
          <div className={`${skeletonStyles.block} ${styles.providerLogo}`} />
        </div>
      </section>

      <section className={pageStyles.section}>
        <div className={`${skeletonStyles.block} ${styles.sectionTitle}`} />
        <div className={gridStyles.personGrid}>
          {Array.from({ length: CAST_PLACEHOLDER_COUNT }, (_, i) => (
            <div key={i} className={styles.personSkeleton}>
              <div className={`${skeletonStyles.block} ${styles.avatar}`} />
              <div className={`${skeletonStyles.block} ${styles.barLine}`} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
