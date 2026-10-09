import { useEffect, useId, useMemo, useState } from "react";
import type { FocusEvent } from "react";
import { useTranslation } from "react-i18next";
import { getCountries } from "../../../core/api/tmdb.ts";
import type { Country } from "../../../core/types/tmdb.ts";
import { regionName } from "../../../core/context/RegionContext.tsx";
import { useLocale } from "../../../core/context/LocaleContext.tsx";
import { clampNumericValue, isRangeInverted } from "../../lib/numericRangeFilter.ts";
import styles from "./AdvancedFilters.module.css";

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_MIN = 1900;
const YEAR_MAX = CURRENT_YEAR + 5;
const VOTE_MIN = 0;
const VOTE_MAX = 10;

export interface AdvancedFiltersState {
  yearMin: string;
  yearMax: string;
  voteAverageMin: string;
  voteAverageMax: string;
  voteCountMin: string;
  originCountry: string;
  runtimeMin: string;
  runtimeMax: string;
}

export const EMPTY_ADVANCED_FILTERS: AdvancedFiltersState = {
  yearMin: "",
  yearMax: "",
  voteAverageMin: "",
  voteAverageMax: "",
  voteCountMin: "",
  originCountry: "",
  runtimeMin: "",
  runtimeMax: "",
};

// Message explicite affiché (et appel API court-circuité côté pages) dès
// qu'une plage min/max saisie est incohérente, plutôt que de laisser la
// recherche retomber silencieusement sur "Aucun résultat".
// Fonction PURE (pas de useTranslation ici, voir ratingTier.ts) : renvoie
// une clé i18n (namespace "advancedFilters"), à résoudre via t() côté
// composant appelant.
export function getAdvancedFiltersRangeError(filters: AdvancedFiltersState): string | null {
  if (isRangeInverted(filters.yearMin, filters.yearMax)) {
    return "advancedFilters.yearRangeError";
  }
  if (isRangeInverted(filters.voteAverageMin, filters.voteAverageMax)) {
    return "advancedFilters.ratingRangeError";
  }
  if (isRangeInverted(filters.runtimeMin, filters.runtimeMax)) {
    return "advancedFilters.runtimeRangeError";
  }
  return null;
}

interface AdvancedFiltersProps {
  filters: AdvancedFiltersState;
  setFilters: (updater: (prev: AdvancedFiltersState) => AdvancedFiltersState) => void;
}

export type AdvancedFilterField = "year" | "rating" | "votes" | "runtime" | "country";

const ALL_FIELDS: AdvancedFilterField[] = ["year", "rating", "votes", "runtime", "country"];

interface AdvancedFilterFieldsProps extends AdvancedFiltersProps {
  /** "panel" : libellés à hauteur fixe et contrôles de 44 px, pour la grille
   * alignée du panneau de filtres de Découvrir (FilterPanel). */
  variant?: "compact" | "panel";
  /** Champs affichés (tous par défaut). Aléatoire n'a que l'année. */
  fields?: AdvancedFilterField[];
}

/** Champs des filtres avancés (année, note, votes, durée, pays), sans
 * bouton d'ouverture ni conteneur : rendus en fragment pour s'insérer dans
 * la grille du parent — AdvancedFilters ci-dessous, ou FilterPanel. */
export function AdvancedFilterFields({
  filters,
  setFilters,
  variant = "compact",
  fields = ALL_FIELDS,
}: AdvancedFilterFieldsProps) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [countries, setCountries] = useState<Country[]>([]);

  const withCountry = fields.includes("country");

  useEffect(() => {
    if (!withCountry) {
      return;
    }
    let cancelled = false;
    getCountries()
      .then((list) => !cancelled && setCountries(list))
      .catch(() => !cancelled && setCountries([]));
    return () => {
      cancelled = true;
    };
  }, [withCountry]);

  // Nom localisé (locale active) plutôt que le english_name figé renvoyé par
  // TMDB, avec repli sur ce dernier si Intl.DisplayNames est indisponible.
  const localizedCountries = useMemo(
    () =>
      countries
        .map((c) => ({ ...c, displayName: regionName(c.iso_3166_1, locale) || c.english_name }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, locale)),
    [countries, locale]
  );

  // Identifiants des libellés : chaque plage min/max est un groupe nommé par
  // son libellé (lu avant « Min » / « Max » au lecteur d'écran), les champs
  // seuls sont reliés à leur libellé par htmlFor.
  const idPrefix = useId();
  const ids = {
    year: `${idPrefix}-year`,
    rating: `${idPrefix}-rating`,
    votes: `${idPrefix}-votes`,
    runtime: `${idPrefix}-runtime`,
    country: `${idPrefix}-country`,
  };

  const fieldClass = variant === "panel" ? `${styles.field} ${styles.fieldPanel}` : styles.field;

  function update<K extends keyof AdvancedFiltersState>(key: K, value: AdvancedFiltersState[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  // Plafonne la valeur saisie une fois le champ quitté (plutôt qu'à chaque
  // frappe, ce qui empêcherait de taper un nombre à plusieurs chiffres dès
  // que sa valeur intermédiaire sort des bornes, ex. "2" < 1900).
  function clampOnBlur<K extends keyof AdvancedFiltersState>(key: K, min: number, max?: number) {
    return (e: FocusEvent<HTMLInputElement>) => {
      const clamped = clampNumericValue(e.target.value, min, max);
      if (clamped !== e.target.value) {
        update(key, clamped as AdvancedFiltersState[K]);
      }
    };
  }

  return (
    <>
      {fields.includes("year") && (
        <div className={fieldClass}>
          <label id={`${ids.year}-label`} htmlFor={ids.year}>
            {t("advancedFilters.releaseYear")}
          </label>
          <div className={styles.range} role="group" aria-labelledby={`${ids.year}-label`}>
            <input
              id={ids.year}
              aria-label={t("advancedFilters.min")}
              type="number"
              inputMode="numeric"
              placeholder={t("advancedFilters.min")}
              min={YEAR_MIN}
              max={YEAR_MAX}
              value={filters.yearMin}
              onChange={(e) => update("yearMin", e.target.value)}
              onBlur={clampOnBlur("yearMin", YEAR_MIN, YEAR_MAX)}
            />
            <span aria-hidden="true">–</span>
            <input
              aria-label={t("advancedFilters.max")}
              type="number"
              inputMode="numeric"
              placeholder={t("advancedFilters.max")}
              min={YEAR_MIN}
              max={YEAR_MAX}
              value={filters.yearMax}
              onChange={(e) => update("yearMax", e.target.value)}
              onBlur={clampOnBlur("yearMax", YEAR_MIN, YEAR_MAX)}
            />
          </div>
        </div>
      )}

      {fields.includes("rating") && (
        <div className={fieldClass}>
          <label id={`${ids.rating}-label`} htmlFor={ids.rating}>
            {t("advancedFilters.ratingOutOf10")}
          </label>
          <div className={styles.range} role="group" aria-labelledby={`${ids.rating}-label`}>
            <input
              id={ids.rating}
              aria-label={t("advancedFilters.min")}
              type="number"
              inputMode="decimal"
              placeholder={t("advancedFilters.min")}
              min={VOTE_MIN}
              max={VOTE_MAX}
              step={0.5}
              value={filters.voteAverageMin}
              onChange={(e) => update("voteAverageMin", e.target.value)}
              onBlur={clampOnBlur("voteAverageMin", VOTE_MIN, VOTE_MAX)}
            />
            <span aria-hidden="true">–</span>
            <input
              aria-label={t("advancedFilters.max")}
              type="number"
              inputMode="decimal"
              placeholder={t("advancedFilters.max")}
              min={VOTE_MIN}
              max={VOTE_MAX}
              step={0.5}
              value={filters.voteAverageMax}
              onChange={(e) => update("voteAverageMax", e.target.value)}
              onBlur={clampOnBlur("voteAverageMax", VOTE_MIN, VOTE_MAX)}
            />
          </div>
        </div>
      )}

      {fields.includes("votes") && (
        <div className={fieldClass}>
          <label htmlFor={ids.votes}>{t("advancedFilters.minVoteCount")}</label>
          <input
            id={ids.votes}
            type="number"
            inputMode="numeric"
            placeholder={t("advancedFilters.minVoteCountPlaceholder")}
            min={0}
            value={filters.voteCountMin}
            onChange={(e) => update("voteCountMin", e.target.value)}
            onBlur={clampOnBlur("voteCountMin", 0)}
          />
        </div>
      )}

      {fields.includes("runtime") && (
        <div className={fieldClass}>
          <label id={`${ids.runtime}-label`} htmlFor={ids.runtime}>
            {t("advancedFilters.runtimeMinutes")}
          </label>
          <div className={styles.range} role="group" aria-labelledby={`${ids.runtime}-label`}>
            <input
              id={ids.runtime}
              aria-label={t("advancedFilters.min")}
              type="number"
              inputMode="numeric"
              placeholder={t("advancedFilters.min")}
              min={0}
              value={filters.runtimeMin}
              onChange={(e) => update("runtimeMin", e.target.value)}
              onBlur={clampOnBlur("runtimeMin", 0)}
            />
            <span aria-hidden="true">–</span>
            <input
              aria-label={t("advancedFilters.max")}
              type="number"
              inputMode="numeric"
              placeholder={t("advancedFilters.max")}
              min={0}
              value={filters.runtimeMax}
              onChange={(e) => update("runtimeMax", e.target.value)}
              onBlur={clampOnBlur("runtimeMax", 0)}
            />
          </div>
        </div>
      )}

      {fields.includes("country") && (
        <div className={fieldClass}>
          <label htmlFor={ids.country}>{t("advancedFilters.originCountry")}</label>
          <select
            id={ids.country}
            value={filters.originCountry}
            onChange={(e) => update("originCountry", e.target.value)}
          >
            <option value="">{t("advancedFilters.allCountries")}</option>
            {localizedCountries.map((c) => (
              <option key={c.iso_3166_1} value={c.iso_3166_1}>
                {c.displayName}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}
