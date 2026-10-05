import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Dropdown from "../Dropdown/Dropdown.tsx";
import Icon from "../Icon/Icon.tsx";
import SlidingIndicator from "../SlidingIndicator/SlidingIndicator.tsx";
import { useFocusTrap } from "../../hooks/useFocusTrap.ts";
import {
  AdvancedFilterFields,
  EMPTY_ADVANCED_FILTERS,
  getAdvancedFiltersRangeError,
  type AdvancedFilterField,
  type AdvancedFiltersState,
} from "../AdvancedFilters/AdvancedFilters.tsx";
import { regionName } from "../../../core/context/RegionContext.tsx";
import { getCountries, getLanguages } from "../../../core/api/tmdb.ts";
import { useLocale } from "../../../core/context/LocaleContext.tsx";
import {
  SORT_FIELDS,
  type DiscoverSortField,
  type SortDirection,
  type WatchProviderOption,
} from "../../../core/api/tmdb.ts";
import type { Country, Genre, Language, MediaType } from "../../../core/types/tmdb.ts";
import dropdownStyles from "../Dropdown/Dropdown.module.css";
import styles from "./FilterPanel.module.css";

export const DEFAULT_SORT_FIELD: DiscoverSortField = "popularity";
export const DEFAULT_SORT_DIRECTION: SortDirection = "desc";

// Même largeur de colonne que la NavBar : sous ce seuil, le panneau devient
// une feuille modale (voir FilterPanel.module.css).
const MOBILE_QUERY = "(max-width: 860px)";

const CHECK_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

interface FilterPanelProps {
  mediaType: MediaType;
  setMediaType: (v: MediaType) => void;
  genres: Genre[];
  genreIds: number[];
  setGenreIds: (ids: number[]) => void;
  providers: WatchProviderOption[];
  providerIds: string[];
  setProviderIds: (ids: string[]) => void;
  favoriteProviderIds: number[];
  useMyPlatforms: boolean;
  setUseMyPlatforms: (v: boolean) => void;
  // Tri et filtres avancés : Découvrir uniquement. Nouveautés et
  // Prochainement ont leur propre ordre et une fenêtre de dates.
  sortField?: DiscoverSortField;
  setSortField?: (v: DiscoverSortField) => void;
  sortDirection?: SortDirection;
  setSortDirection?: (v: SortDirection) => void;
  advanced?: AdvancedFiltersState;
  setAdvanced?: (updater: (prev: AdvancedFiltersState) => AdvancedFiltersState) => void;
  /** Champs avancés affichés (tous par défaut). Aléatoire : l'année seule. */
  advancedFields?: AdvancedFilterField[];
  /** Interrupteurs propres à la page (Aléatoire : « Sans les déjà vus »),
   * rendus comme « Mes plateformes » et listés en puce quand ils sont
   * activés. */
  switches?: PanelSwitch[];
  /** Pays de production / langue originale (Nouveautés, Prochainement). */
  countryLanguage?: CountryLanguageState;
  /** Puces de période (« 7 jours », « 30 jours », « 3 mois »), à côté de la
   * bascule Films/Séries ; « Filtres » passe alors sur la ligne suivante. */
  periods?: PeriodOptions;
  /** Troisième choix « Les deux » dans la bascule Films/Séries (Aléatoire).
   * Quand il est actif, ni Films ni Séries ne sont marqués. */
  allTypes?: AllTypesOption;
}

interface AllTypesOption {
  active: boolean;
  onSelect: () => void;
}

interface CountryLanguageState {
  /** Plusieurs pays/langues sélectionnables à la fois, pré-remplis depuis les
   * préférences du compte (FavoriteCountriesContext/FavoriteLanguagesContext)
   * puis modifiables ponctuellement sans écraser ces préférences — même
   * principe que `useMyPlatforms`, qui ne modifie jamais
   * `favoriteProviderIds`. L'API TMDB discover n'accepte qu'un seul pays/
   * qu'une seule langue par requête : seule la première valeur sélectionnée
   * est transmise à `discover()` côté appelant (voir NewReleasesPage/
   * ComingSoonPage), les suivantes ne font qu'élargir le pré-réglage affiché. */
  countries: string[];
  setCountries: (v: string[]) => void;
  languages: string[];
  setLanguages: (v: string[]) => void;
  /** Pays/langues favoris du compte, et bascule « Mes pays »/« Mes langues »
   * — même principe que `useMyPlatforms` : force `countries`/`languages` sur
   * ce pré-réglage et désactive le menu déroulant correspondant tant qu'elle
   * est active. */
  favoriteCountryCodes: string[];
  useMyCountries: boolean;
  setUseMyCountries: (v: boolean) => void;
  favoriteLanguageCodes: string[];
  useMyLanguages: boolean;
  setUseMyLanguages: (v: boolean) => void;
}

interface PeriodOptions {
  label: string;
  options: { value: number; label: string }[];
  value: number;
  onChange: (v: number) => void;
}

interface PanelSwitch {
  key: string;
  label: string;
  text: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

interface ActiveFilter {
  key: string;
  label: string;
  remove: () => void;
}

// "1990–2000", "≥ 1990" ou "≤ 2000" selon les bornes renseignées.
function rangeText(min: string, max: string, unit = ""): string {
  const suffix = unit ? ` ${unit}` : "";
  if (min && max) {
    return `${min}–${max}${suffix}`;
  }
  return min ? `≥ ${min}${suffix}` : `≤ ${max}${suffix}`;
}

/** Filtres de Découvrir (nouvelle DA) : bascule Films/Séries, bouton
 * « Filtres » avec compteur, puces des filtres actifs supprimables une à une
 * et « Réinitialiser ». Le panneau est une grille de 4 colonnes alignées sur
 * desktop et une feuille modale sur mobile — un seul rendu, la différence
 * est entièrement en CSS. Remplace FilterBar + AdvancedFilters sur cette
 * page, ainsi que sur Nouveautés et Prochainement (sans tri ni filtres
 * avancés, avec pays/langue et puces de période). */
export default function FilterPanel({
  mediaType,
  setMediaType,
  genres,
  genreIds,
  setGenreIds,
  providers,
  providerIds,
  setProviderIds,
  favoriteProviderIds,
  useMyPlatforms,
  setUseMyPlatforms,
  sortField,
  setSortField,
  sortDirection,
  setSortDirection,
  advanced,
  setAdvanced,
  advancedFields,
  switches = [],
  countryLanguage,
  periods,
  allTypes,
}: FilterPanelProps) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  // Feuille modale (mobile) plutôt que panneau dans le flux (desktop).
  const [isSheet, setIsSheet] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const hasFavorites = favoriteProviderIds.length > 0;
  const hasFavoriteCountries = (countryLanguage?.favoriteCountryCodes.length ?? 0) > 0;
  const hasFavoriteLanguages = (countryLanguage?.favoriteLanguageCodes.length ?? 0) > 0;
  const rangeError = advanced ? getAdvancedFiltersRangeError(advanced) : null;
  const hasSort = !!(sortField && sortDirection && setSortField && setSortDirection);
  const [countries, setCountries] = useState<Country[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const withCountryLanguage = !!countryLanguage;

  useEffect(() => {
    if (!withCountryLanguage) {
      return;
    }
    let cancelled = false;
    getCountries()
      .then((list) => !cancelled && setCountries(list))
      .catch(() => !cancelled && setCountries([]));
    getLanguages()
      .then((list) => !cancelled && setLanguages(list))
      .catch(() => !cancelled && setLanguages([]));
    return () => {
      cancelled = true;
    };
  }, [withCountryLanguage]);

  // Nom localisé (locale active) plutôt que le english_name figé renvoyé
  // par TMDB, avec repli sur ce dernier si Intl.DisplayNames est indisponible.
  const localizedCountries = useMemo(
    () =>
      countries
        .map((c) => ({ ...c, displayName: regionName(c.iso_3166_1, locale) || c.english_name }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, locale)),
    [countries, locale]
  );

  // Feuille modale mobile : Échap la ferme et le fond ne défile plus
  // derrière. Sur desktop, le panneau reste dans le flux (pas de verrou).
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    const sheet = window.matchMedia(MOBILE_QUERY).matches;
    setIsSheet(sheet);
    const previousOverflow = document.body.style.overflow;
    if (sheet) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (sheet) {
        document.body.style.overflow = previousOverflow;
      }
    };
  }, [open]);

  // Feuille mobile : focus dans la feuille, Tab qui y reste, puis retour au
  // bouton Filtres à la fermeture (audit H14). Sur desktop, le panneau suit
  // le bouton dans l'ordre de tabulation : pas de piège.
  useFocusTrap(panelRef, open && isSheet);

  function toggleGenre(id: number) {
    setGenreIds(genreIds.includes(id) ? genreIds.filter((g) => g !== id) : [...genreIds, id]);
  }

  function toggleProvider(id: string) {
    setProviderIds(
      providerIds.includes(id) ? providerIds.filter((p) => p !== id) : [...providerIds, id]
    );
  }

  function toggleCountry(code: string) {
    if (!countryLanguage) {
      return;
    }
    const { countries, setCountries } = countryLanguage;
    setCountries(
      countries.includes(code) ? countries.filter((c) => c !== code) : [...countries, code]
    );
  }

  function toggleLanguage(code: string) {
    if (!countryLanguage) {
      return;
    }
    const { languages, setLanguages } = countryLanguage;
    setLanguages(
      languages.includes(code) ? languages.filter((l) => l !== code) : [...languages, code]
    );
  }

  function clearAdvanced(...keys: (keyof AdvancedFiltersState)[]) {
    setAdvanced?.((prev) => {
      const next = { ...prev };
      keys.forEach((k) => (next[k] = ""));
      return next;
    });
  }

  function resetAll() {
    setGenreIds([]);
    setProviderIds([]);
    setUseMyPlatforms(false);
    setSortField?.(DEFAULT_SORT_FIELD);
    setSortDirection?.(DEFAULT_SORT_DIRECTION);
    setAdvanced?.(() => EMPTY_ADVANCED_FILTERS);
    countryLanguage?.setCountries([]);
    countryLanguage?.setLanguages([]);
    countryLanguage?.setUseMyCountries(false);
    countryLanguage?.setUseMyLanguages(false);
    switches.forEach((s) => s.onChange(false));
  }

  const chip = (label: string, value: string) => t("filterPanel.chip", { label, value });
  const sortLabelKey = SORT_FIELDS.find((s) => s.value === sortField)?.labelKey;
  const sortLabel = sortLabelKey ? t(sortLabelKey) : sortField;

  const active: ActiveFilter[] = [
    ...genreIds.map((id) => ({
      key: `genre-${id}`,
      label: genres.find((g) => g.id === id)?.name || t("filterBar.genresCount", { count: 1 }),
      remove: () => setGenreIds(genreIds.filter((g) => g !== id)),
    })),
    ...(useMyPlatforms
      ? [
          {
            key: "my-platforms",
            label: t("filterPanel.onlyMyPlatforms"),
            remove: () => setUseMyPlatforms(false),
          },
        ]
      : providerIds.map((id) => ({
          key: `provider-${id}`,
          label: providers.find((p) => String(p.id) === id)?.name || id,
          remove: () => setProviderIds(providerIds.filter((p) => p !== id)),
        }))),
    ...(hasSort && (sortField !== DEFAULT_SORT_FIELD || sortDirection !== DEFAULT_SORT_DIRECTION)
      ? [
          {
            key: "sort",
            label: chip(
              t("filterPanel.sort"),
              `${sortLabel} ${sortDirection === "desc" ? "↓" : "↑"}`
            ),
            remove: () => {
              setSortField?.(DEFAULT_SORT_FIELD);
              setSortDirection?.(DEFAULT_SORT_DIRECTION);
            },
          },
        ]
      : []),
    ...(advanced && (advanced.yearMin || advanced.yearMax)
      ? [
          {
            key: "year",
            label: chip(t("filterPanel.year"), rangeText(advanced.yearMin, advanced.yearMax)),
            remove: () => clearAdvanced("yearMin", "yearMax"),
          },
        ]
      : []),
    ...(advanced && (advanced.voteAverageMin || advanced.voteAverageMax)
      ? [
          {
            key: "rating",
            label: chip(
              t("filterPanel.rating"),
              rangeText(advanced.voteAverageMin, advanced.voteAverageMax)
            ),
            remove: () => clearAdvanced("voteAverageMin", "voteAverageMax"),
          },
        ]
      : []),
    ...(advanced && advanced.voteCountMin
      ? [
          {
            key: "votes",
            label: chip(t("filterPanel.votes"), rangeText(advanced.voteCountMin, "")),
            remove: () => clearAdvanced("voteCountMin"),
          },
        ]
      : []),
    ...(advanced && (advanced.runtimeMin || advanced.runtimeMax)
      ? [
          {
            key: "runtime",
            label: chip(
              t("filterPanel.runtime"),
              rangeText(advanced.runtimeMin, advanced.runtimeMax, t("filterPanel.minutes"))
            ),
            remove: () => clearAdvanced("runtimeMin", "runtimeMax"),
          },
        ]
      : []),
    ...(advanced && advanced.originCountry
      ? [
          {
            key: "country",
            label: chip(
              t("filterPanel.country"),
              regionName(advanced.originCountry, locale) || advanced.originCountry
            ),
            remove: () => clearAdvanced("originCountry"),
          },
        ]
      : []),
    ...(countryLanguage?.useMyCountries
      ? [
          {
            key: "my-countries",
            label: t("filterPanel.onlyMyCountries"),
            remove: () => countryLanguage.setUseMyCountries(false),
          },
        ]
      : (countryLanguage?.countries || []).map((code) => ({
          key: `origin-country-${code}`,
          label: chip(t("filterPanel.country"), regionName(code, locale) || code),
          remove: () => toggleCountry(code),
        }))),
    ...(countryLanguage?.useMyLanguages
      ? [
          {
            key: "my-languages",
            label: t("filterPanel.onlyMyLanguages"),
            remove: () => countryLanguage.setUseMyLanguages(false),
          },
        ]
      : (countryLanguage?.languages || []).map((code) => ({
          key: `language-${code}`,
          label: chip(
            t("filterPanel.language"),
            languages.find((l) => l.iso_639_1 === code)?.name ||
              languages.find((l) => l.iso_639_1 === code)?.english_name ||
              code
          ),
          remove: () => toggleLanguage(code),
        }))),
    ...switches
      .filter((s) => s.checked)
      .map((s) => ({ key: s.key, label: s.text, remove: () => s.onChange(false) })),
  ];

  const genreLabel =
    genreIds.length === 0
      ? t("filterBar.allGenres")
      : genreIds.length === 1
        ? genres.find((g) => g.id === genreIds[0])?.name || t("filterBar.genresCount", { count: 1 })
        : t("filterBar.genresCount", { count: genreIds.length });

  const providerLabel =
    providerIds.length === 0
      ? t("filterBar.allPlatforms")
      : providerIds.length === 1
        ? providers.find((p) => String(p.id) === providerIds[0])?.name ||
          t("filterPanel.platformsCount", { count: 1 })
        : t("filterPanel.platformsCount", { count: providerIds.length });

  const movieActive = !allTypes?.active && mediaType === "movie";
  const tvActive = !allTypes?.active && mediaType === "tv";
  const segmented = (
    <div className={styles.segmented} role="group" aria-label={t("filterBar.typeAriaLabel")}>
      <SlidingIndicator activeKey={allTypes?.active ? "all" : mediaType} />
      <button
        type="button"
        className={movieActive ? styles.segActive : ""}
        aria-pressed={movieActive}
        onClick={() => setMediaType("movie")}
      >
        {t("filterBar.movies")}
      </button>
      <button
        type="button"
        className={tvActive ? styles.segActive : ""}
        aria-pressed={tvActive}
        onClick={() => setMediaType("tv")}
      >
        {t("filterBar.series")}
      </button>
      {allTypes && (
        <button
          type="button"
          className={allTypes.active ? styles.segActive : ""}
          aria-pressed={allTypes.active}
          onClick={allTypes.onSelect}
        >
          {t("filterBar.allTypes")}
        </button>
      )}
    </div>
  );

  const filtersButton = (
    <button
      type="button"
      className={`${styles.filtersBtn} ${open ? styles.filtersBtnOpen : ""}`}
      onClick={() => setOpen((o) => !o)}
      aria-expanded={open}
      aria-controls={panelId}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path d="M4 6h16M7 12h10M10 18h4" />
      </svg>
      <span className={styles.filtersLabel}>{t("filterPanel.filters")}</span>
      {active.length > 0 && (
        <span
          className={styles.count}
          aria-label={t("filterPanel.activeCount", { count: active.length })}
        >
          {active.length}
        </span>
      )}
    </button>
  );

  const activeChips = (
    <ul className={styles.chips} aria-label={t("filterPanel.activeFilters")}>
      {active.map((f) => (
        <li key={f.key}>
          <button
            type="button"
            className={styles.chip}
            onClick={f.remove}
            aria-label={t("filterPanel.removeFilter", { label: f.label })}
          >
            {f.label}
            <Icon name="close" size={14} />
          </button>
        </li>
      ))}
      <li>
        <button type="button" className={styles.reset} onClick={resetAll}>
          {t("filterPanel.reset")}
        </button>
      </li>
    </ul>
  );

  return (
    <div className={styles.wrap}>
      {/* Films/Séries (et période), puis « Filtres » calé à droite, sur une
          ligne ; les puces des filtres actifs sur la suivante. */}
      <div className={styles.toolbar}>
        <div className={`${styles.toolbarRow} ${allTypes ? styles.toolbarRowCompact : ""}`}>
          {segmented}
          {periods && (
            <div className={styles.periods} role="group" aria-label={periods.label}>
              <SlidingIndicator activeKey={periods.value} />
              {periods.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`${styles.period} ${periods.value === o.value ? styles.periodActive : ""}`}
                  aria-pressed={periods.value === o.value}
                  onClick={() => periods.onChange(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {filtersButton}
        </div>
        {active.length > 0 && <div className={styles.toolbarRow}>{activeChips}</div>}
      </div>

      {open && (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            ref={panelRef}
            id={panelId}
            className={styles.panel}
            role="dialog"
            aria-modal={isSheet || undefined}
            aria-label={t("filterPanel.filters")}
          >
            <div className={styles.sheetHead}>
              <h2>{t("filterPanel.filters")}</h2>
              <button
                type="button"
                className={styles.close}
                onClick={() => setOpen(false)}
                aria-label={t("filterPanel.close")}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <div className={styles.grid}>
              <div className={styles.field}>
                <span className={styles.label}>{t("filterPanel.genres")}</span>
                <Dropdown
                  className={styles.control}
                  label={<span className={styles.controlLabel}>{genreLabel}</span>}
                  active={genreIds.length > 0}
                >
                  <div className={dropdownStyles.head}>{t("filterBar.filterByGenre")}</div>
                  {genres.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className={`${dropdownStyles.option} ${genreIds.includes(g.id) ? dropdownStyles.optionOn : ""}`}
                      role="menuitemcheckbox"
                      aria-checked={genreIds.includes(g.id)}
                      onClick={() => toggleGenre(g.id)}
                    >
                      <span className={dropdownStyles.check}>{CHECK_SVG}</span> {g.name}
                    </button>
                  ))}
                </Dropdown>
              </div>

              <div className={styles.field}>
                <span className={styles.label}>{t("filterPanel.platforms")}</span>
                <Dropdown
                  className={styles.control}
                  label={<span className={styles.controlLabel}>{providerLabel}</span>}
                  active={!useMyPlatforms && providerIds.length > 0}
                  disabled={useMyPlatforms}
                >
                  <div className={dropdownStyles.head}>{t("filterPanel.filterByPlatform")}</div>
                  {providers.map((p) => {
                    const id = String(p.id);
                    const on = providerIds.includes(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`${dropdownStyles.option} ${on ? dropdownStyles.optionOn : ""}`}
                        role="menuitemcheckbox"
                        aria-checked={on}
                        onClick={() => toggleProvider(id)}
                      >
                        <span className={dropdownStyles.check}>{CHECK_SVG}</span> {p.name}
                      </button>
                    );
                  })}
                </Dropdown>
              </div>

              <div className={styles.field}>
                <span className={styles.label} id={`${panelId}-mine`}>
                  {t("filterPanel.myPlatforms")}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useMyPlatforms}
                  aria-labelledby={`${panelId}-mine`}
                  className={styles.switchRow}
                  disabled={!hasFavorites}
                  title={hasFavorites ? undefined : t("filterPanel.noFavoritePlatforms")}
                  onClick={() => setUseMyPlatforms(!useMyPlatforms)}
                >
                  <span className={styles.switchText}>
                    {hasFavorites
                      ? t("filterPanel.onlyMyPlatforms")
                      : t("filterPanel.noFavoritePlatforms")}
                  </span>
                  <span
                    className={`${styles.switch} ${useMyPlatforms ? styles.switchOn : ""}`}
                    aria-hidden="true"
                  />
                </button>
              </div>

              {hasSort && (
                <div className={styles.field}>
                  <span className={styles.label}>{t("filterPanel.sort")}</span>
                  <Dropdown
                    className={styles.control}
                    label={
                      <span className={styles.controlLabel}>
                        {sortLabel} {sortDirection === "desc" ? "↓" : "↑"}
                      </span>
                    }
                    align="right"
                  >
                    <div className={dropdownStyles.head}>{t("filterBar.sortBy")}</div>
                    {SORT_FIELDS.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        className={`${dropdownStyles.option} ${sortField === s.value ? dropdownStyles.optionOn : ""}`}
                        role="menuitemradio"
                        aria-checked={sortField === s.value}
                        onClick={() => setSortField(s.value)}
                      >
                        <span className={dropdownStyles.radio} /> {t(s.labelKey)}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={dropdownStyles.option}
                      onClick={() => setSortDirection(sortDirection === "desc" ? "asc" : "desc")}
                    >
                      {sortDirection === "desc"
                        ? t("filterBar.sortDescending")
                        : t("filterBar.sortAscending")}{" "}
                      {t("filterBar.sortToggleHint")}
                    </button>
                  </Dropdown>
                </div>
              )}

              {countryLanguage && (
                <>
                  <div className={styles.field}>
                    <span className={styles.label}>{t("filterPanel.country")}</span>
                    <Dropdown
                      className={styles.control}
                      label={
                        <span className={styles.controlLabel}>
                          {countryLanguage.countries.length === 0
                            ? t("countryLanguageFilter.allCountries")
                            : countryLanguage.countries.length === 1
                              ? regionName(countryLanguage.countries[0], locale) ||
                                countryLanguage.countries[0]
                              : t("filterPanel.countriesCount", {
                                  count: countryLanguage.countries.length,
                                })}
                        </span>
                      }
                      active={
                        !countryLanguage.useMyCountries && countryLanguage.countries.length > 0
                      }
                      disabled={countryLanguage.useMyCountries}
                    >
                      <div className={dropdownStyles.head}>{t("filterPanel.country")}</div>
                      {localizedCountries.map((c) => (
                        <button
                          key={c.iso_3166_1}
                          type="button"
                          className={`${dropdownStyles.option} ${countryLanguage.countries.includes(c.iso_3166_1) ? dropdownStyles.optionOn : ""}`}
                          role="menuitemcheckbox"
                          aria-checked={countryLanguage.countries.includes(c.iso_3166_1)}
                          onClick={() => toggleCountry(c.iso_3166_1)}
                        >
                          <span className={dropdownStyles.check}>{CHECK_SVG}</span> {c.displayName}
                        </button>
                      ))}
                    </Dropdown>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.label} id={`${panelId}-mine-countries`}>
                      {t("filterPanel.myCountries")}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={countryLanguage.useMyCountries}
                      aria-labelledby={`${panelId}-mine-countries`}
                      className={styles.switchRow}
                      disabled={!hasFavoriteCountries}
                      title={
                        hasFavoriteCountries ? undefined : t("filterPanel.noFavoriteCountries")
                      }
                      onClick={() =>
                        countryLanguage.setUseMyCountries(!countryLanguage.useMyCountries)
                      }
                    >
                      <span className={styles.switchText}>
                        {hasFavoriteCountries
                          ? t("filterPanel.onlyMyCountries")
                          : t("filterPanel.noFavoriteCountries")}
                      </span>
                      <span
                        className={`${styles.switch} ${countryLanguage.useMyCountries ? styles.switchOn : ""}`}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.label}>{t("filterPanel.language")}</span>
                    <Dropdown
                      className={styles.control}
                      label={
                        <span className={styles.controlLabel}>
                          {countryLanguage.languages.length === 0
                            ? t("countryLanguageFilter.allLanguages")
                            : countryLanguage.languages.length === 1
                              ? languages.find((l) => l.iso_639_1 === countryLanguage.languages[0])
                                  ?.name ||
                                languages.find((l) => l.iso_639_1 === countryLanguage.languages[0])
                                  ?.english_name ||
                                countryLanguage.languages[0]
                              : t("filterPanel.languagesCount", {
                                  count: countryLanguage.languages.length,
                                })}
                        </span>
                      }
                      active={
                        !countryLanguage.useMyLanguages && countryLanguage.languages.length > 0
                      }
                      disabled={countryLanguage.useMyLanguages}
                    >
                      <div className={dropdownStyles.head}>{t("filterPanel.language")}</div>
                      {languages.map((l) => (
                        <button
                          key={l.iso_639_1}
                          type="button"
                          className={`${dropdownStyles.option} ${countryLanguage.languages.includes(l.iso_639_1) ? dropdownStyles.optionOn : ""}`}
                          role="menuitemcheckbox"
                          aria-checked={countryLanguage.languages.includes(l.iso_639_1)}
                          onClick={() => toggleLanguage(l.iso_639_1)}
                        >
                          <span className={dropdownStyles.check}>{CHECK_SVG}</span>{" "}
                          {l.name || l.english_name}
                        </button>
                      ))}
                    </Dropdown>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.label} id={`${panelId}-mine-languages`}>
                      {t("filterPanel.myLanguages")}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={countryLanguage.useMyLanguages}
                      aria-labelledby={`${panelId}-mine-languages`}
                      className={styles.switchRow}
                      disabled={!hasFavoriteLanguages}
                      title={
                        hasFavoriteLanguages ? undefined : t("filterPanel.noFavoriteLanguages")
                      }
                      onClick={() =>
                        countryLanguage.setUseMyLanguages(!countryLanguage.useMyLanguages)
                      }
                    >
                      <span className={styles.switchText}>
                        {hasFavoriteLanguages
                          ? t("filterPanel.onlyMyLanguages")
                          : t("filterPanel.noFavoriteLanguages")}
                      </span>
                      <span
                        className={`${styles.switch} ${countryLanguage.useMyLanguages ? styles.switchOn : ""}`}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                </>
              )}

              {advanced && setAdvanced && (
                <AdvancedFilterFields
                  filters={advanced}
                  setFilters={setAdvanced}
                  variant="panel"
                  fields={advancedFields}
                />
              )}

              {switches.map((s) => (
                <div key={s.key} className={styles.field}>
                  <span className={styles.label} id={`${panelId}-${s.key}`}>
                    {s.label}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={s.checked}
                    aria-labelledby={`${panelId}-${s.key}`}
                    className={styles.switchRow}
                    onClick={() => s.onChange(!s.checked)}
                  >
                    <span className={styles.switchText}>{s.text}</span>
                    <span
                      className={`${styles.switch} ${s.checked ? styles.switchOn : ""}`}
                      aria-hidden="true"
                    />
                  </button>
                </div>
              ))}

              {rangeError && (
                <p className={styles.rangeError} role="alert">
                  <Icon name="alert" /> {t(rangeError)}
                </p>
              )}
            </div>

            <div className={styles.sheetFoot}>
              <button
                type="button"
                className={styles.footReset}
                onClick={resetAll}
                disabled={active.length === 0}
              >
                {t("filterPanel.reset")}
              </button>
              <button type="button" className={styles.apply} onClick={() => setOpen(false)}>
                {t("filterPanel.showResults")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
