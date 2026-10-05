import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getLanguages } from "../../../core/api/tmdb.ts";
import { useFavoriteLanguages } from "../../../core/context/FavoriteLanguagesContext.tsx";
import { Icon } from "../../../shared/components/index.ts";
import type { Language } from "../../../core/types/tmdb.ts";
import { SettingsRow } from "./SettingsGroup.tsx";
import styles from "./SettingsPanel.module.css";

// Réglage "Mes langues" : cocher une fois les langues originales qu'on
// regarde le plus souvent, pour pré-remplir le filtre « Langue » de
// Nouveautés/Prochainement au lieu de resélectionner une langue à chaque
// visite — même principe que FavoriteProvidersSettings.
export default function FavoriteLanguagesSettings() {
  const { t } = useTranslation();
  const { favoriteLanguageCodes, toggleFavoriteLanguage } = useFavoriteLanguages();
  const [languages, setLanguages] = useState<Language[]>([]);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    getLanguages()
      .then((list) => {
        if (!cancelled) {
          setLanguages(list);
          setStatus("success");
        }
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmedQuery = query.trim().toLowerCase();
  const visibleLanguages = trimmedQuery
    ? languages.filter((l) => (l.name || l.english_name || "").toLowerCase().includes(trimmedQuery))
    : languages;

  return (
    <SettingsRow
      label={t("favoriteLanguagesSettings.title")}
      description={t("favoriteLanguagesSettings.description")}
    >
      <span className={styles.meta}>
        {t("favoriteLanguagesSettings.activeCount", { count: favoriteLanguageCodes.length })}
      </span>
      {status === "loading" && (
        <p className={`${styles.status} ${styles.providersLoading}`}>{t("common.loading")}</p>
      )}
      {status === "error" && (
        <p className={styles.error}>{t("favoriteLanguagesSettings.loadError")}</p>
      )}
      {status === "success" && (
        <>
          <label className={styles.search}>
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder={t("favoriteLanguagesSettings.searchPlaceholder")}
              aria-label={t("favoriteLanguagesSettings.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className={styles.genreGrid}>
            {visibleLanguages.map((l) => {
              const checked = favoriteLanguageCodes.includes(l.iso_639_1);
              return (
                <label
                  key={l.iso_639_1}
                  className={`${styles.provider} ${checked ? styles.providerOn : ""}`}
                >
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={checked}
                    onChange={() => toggleFavoriteLanguage(l.iso_639_1)}
                  />
                  <span>{l.name || l.english_name}</span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </SettingsRow>
  );
}
