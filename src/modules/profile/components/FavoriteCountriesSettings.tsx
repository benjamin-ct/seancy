import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCountries } from "../../../core/api/tmdb.ts";
import { regionName } from "../../../core/context/RegionContext.tsx";
import { useLocale } from "../../../core/context/LocaleContext.tsx";
import { useFavoriteCountries } from "../../../core/context/FavoriteCountriesContext.tsx";
import { Icon } from "../../../shared/components/index.ts";
import type { Country } from "../../../core/types/tmdb.ts";
import { SettingsRow } from "./SettingsGroup.tsx";
import styles from "./SettingsPanel.module.css";

// Réglage "Mes pays" : cocher une fois les pays de production qu'on
// regarde le plus souvent, pour pré-remplir le filtre « Pays » de
// Nouveautés/Prochainement au lieu de resélectionner un pays à chaque
// visite — même principe que FavoriteProvidersSettings.
export default function FavoriteCountriesSettings() {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const { favoriteCountryCodes, toggleFavoriteCountry } = useFavoriteCountries();
  const [countries, setCountries] = useState<Country[]>([]);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    getCountries()
      .then((list) => {
        if (!cancelled) {
          setCountries(list);
          setStatus("success");
        }
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, []);

  // Nom localisé (locale active) plutôt que le english_name figé renvoyé
  // par TMDB, avec repli sur ce dernier si Intl.DisplayNames est indisponible
  // (même principe que FilterPanel).
  const localizedCountries = useMemo(
    () =>
      countries
        .map((c) => ({ ...c, displayName: regionName(c.iso_3166_1, locale) || c.english_name }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, locale)),
    [countries, locale]
  );

  const trimmedQuery = query.trim().toLowerCase();
  const visibleCountries = trimmedQuery
    ? localizedCountries.filter((c) => c.displayName.toLowerCase().includes(trimmedQuery))
    : localizedCountries;

  return (
    <SettingsRow
      label={t("favoriteCountriesSettings.title")}
      description={t("favoriteCountriesSettings.description")}
    >
      <span className={styles.meta}>
        {t("favoriteCountriesSettings.activeCount", { count: favoriteCountryCodes.length })}
      </span>
      {status === "loading" && (
        <p className={`${styles.status} ${styles.providersLoading}`}>{t("common.loading")}</p>
      )}
      {status === "error" && (
        <p className={styles.error}>{t("favoriteCountriesSettings.loadError")}</p>
      )}
      {status === "success" && (
        <>
          <label className={styles.search}>
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder={t("favoriteCountriesSettings.searchPlaceholder")}
              aria-label={t("favoriteCountriesSettings.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className={styles.genreGrid}>
            {visibleCountries.map((c) => {
              const checked = favoriteCountryCodes.includes(c.iso_3166_1);
              return (
                <label
                  key={c.iso_3166_1}
                  className={`${styles.provider} ${checked ? styles.providerOn : ""}`}
                >
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={checked}
                    onChange={() => toggleFavoriteCountry(c.iso_3166_1)}
                  />
                  <span>{c.displayName}</span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </SettingsRow>
  );
}
