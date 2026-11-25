import { useTranslation } from "react-i18next";
import { Icon } from "../../shared/components/index.ts";
import skeletonStyles from "../../shared/styles/skeleton.module.css";
import styles from "./TonightPick.module.css";

/** Squelette « Pour vous ce soir » pendant le tout premier chargement
 * (statut d'auth, ou première réponse du Worker pas encore arrivée) :
 * même forme que la carte réelle (TonightPickCard — poster + lignes de
 * texte), en shimmer, pour rester cohérent avec les autres squelettes de
 * l'app (DetailSkeleton, MediaCardSkeleton...) plutôt qu'un bloc plat qui
 * pulse en opacité. */
export default function TonightPickSkeleton() {
  const { t } = useTranslation();
  return (
    <section className={styles.hero} aria-hidden="true">
      <div className={`${styles.poster} ${skeletonStyles.block}`} />
      <div className={styles.body}>
        <p className={styles.eyebrow}>
          <Icon name="sparkle" /> {t("tonightPick.eyebrow")}
        </p>
        <div className={`${skeletonStyles.block} ${styles.skeletonTitle}`} />
        <div className={`${skeletonStyles.block} ${styles.skeletonMeta}`} />
        <div className={`${skeletonStyles.block} ${styles.skeletonLine}`} />
      </div>
    </section>
  );
}
