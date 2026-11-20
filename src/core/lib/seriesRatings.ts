// Notes d'une série, épisode par épisode, saison par saison et en entier —
// logique PURE (pas de React), partagée par LibraryContext (calcul de la note
// stockée) et la fiche série (affichage des moyennes), vérifiée par
// scripts/verify-series-ratings.ts.
//
// Règles :
//   - note d'une saison = moyenne simple des notes de ses épisodes ; sans
//     épisode noté, c'est la note donnée à la main à la saison (si elle existe).
//     La moyenne des épisodes prend toujours le dessus sur la note manuelle,
//     qui reste stockée et revient si toutes les notes d'épisodes sont retirées ;
//   - note de la série = moyenne des notes de ses saisons (chaque saison compte
//     pareil, quel que soit son nombre d'épisodes), y compris une saison notée
//     à la main sans épisode noté ; sans saison notée, c'est la note donnée à la
//     main à la série. Même priorité que pour la saison. Les épisodes spéciaux
//     (saison 0) ont leur propre note mais ne comptent pas dans celle de la série,
//     comme dans le total d'épisodes du suivi ;
//   - `rating` (la note lue partout ailleurs : profil, stats, top 5, fil
//     social...) vaut la note effective de la série arrondie à l'entier, pour
//     garder une note entière de 1 à 10 dans le reste de l'app. La moyenne
//     exacte (à une décimale) n'est affichée que sur la fiche série.

/** Champs de notation portés par l'entrée de bibliothèque d'une série. */
export interface SeriesRatingFields {
  rating?: number | null;
  /** Note donnée à la main à la série entière. Absente sur une entrée notée
   * avant les notes de saison/épisode : `rating` est alors la note manuelle. */
  manualRating?: number | null;
  /** Notes données à la main aux saisons, clé = numéro de saison ("1"). */
  seasonRatings?: Record<string, number>;
  /** Notes des épisodes, clé "saison-épisode" ("1-5"), comme `watchedEpisodes`. */
  episodeRatings?: Record<string, number>;
}

export interface SeasonRatingSummary {
  /** Note effective de la saison (moyenne exacte ou note manuelle). */
  value: number | null;
  /** Nombre d'épisodes notés ; 0 = note manuelle (ou aucune note). */
  ratedEpisodes: number;
  /** Note donnée à la main à la saison, même quand la moyenne la remplace. */
  manual: number | null;
}

export interface SeriesRatingSummary {
  /** Note effective de la série (moyenne exacte ou note manuelle). */
  value: number | null;
  /** Nombre de saisons notées (hors épisodes spéciaux) ; 0 = note manuelle. */
  ratedSeasons: number;
  /** Note donnée à la main à la série, même quand la moyenne la remplace. */
  manual: number | null;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

/** Note valide : entier de 1 à 10 (sinon `null`). */
export function cleanRating(value: unknown): number | null {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) {
    return null;
  }
  const rounded = Math.round(n);
  return rounded >= 1 && rounded <= 10 ? rounded : null;
}

/** Note donnée à la main à la série (voir `manualRating`). */
export function manualSeriesRating(item: SeriesRatingFields): number | null {
  return item.manualRating !== undefined ? item.manualRating : (item.rating ?? null);
}

export function seasonRating(item: SeriesRatingFields, seasonNumber: number): SeasonRatingSummary {
  const prefix = `${seasonNumber}-`;
  const episodes = Object.entries(item.episodeRatings ?? {})
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => value);
  const manual = item.seasonRatings?.[String(seasonNumber)] ?? null;
  return {
    value: average(episodes) ?? manual,
    ratedEpisodes: episodes.length,
    manual,
  };
}

export function seriesRating(item: SeriesRatingFields): SeriesRatingSummary {
  const seasons = new Set<number>();
  for (const key of Object.keys(item.episodeRatings ?? {})) {
    seasons.add(Number(key.split("-")[0]));
  }
  for (const key of Object.keys(item.seasonRatings ?? {})) {
    seasons.add(Number(key));
  }
  const values: number[] = [];
  for (const seasonNumber of seasons) {
    if (seasonNumber > 0) {
      const { value } = seasonRating(item, seasonNumber);
      if (value != null) {
        values.push(value);
      }
    }
  }
  const manual = manualSeriesRating(item);
  return { value: average(values) ?? manual, ratedSeasons: values.length, manual };
}

/** Note entière (1-10) d'une moyenne, arrondie depuis sa valeur affichée à une
 * décimale (7,45 s'affiche 7,5 et donne donc 8, pas 7). */
export function wholeRating(value: number): number {
  return Math.min(10, Math.max(1, Math.round(Math.round(value * 10) / 10)));
}

/** Recalcule `rating` (note effective arrondie) et fige `manualRating`, après
 * un changement de note d'épisode, de saison ou de la série. */
export function withSeriesRating<T extends SeriesRatingFields>(item: T): T {
  const { value, manual } = seriesRating(item);
  return { ...item, manualRating: manual, rating: value == null ? null : wholeRating(value) };
}

/** Moyenne affichée à une décimale au plus (« 7,5 » en français, « 7.5 » en anglais). */
export function formatRating(value: number, localeTag: string): string {
  return new Intl.NumberFormat(localeTag, { maximumFractionDigits: 1 }).format(value);
}
