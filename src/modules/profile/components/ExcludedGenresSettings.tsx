import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getGenres } from "../../../core/api/tmdb.ts";
import { useExcludedGenres } from "../../../core/context/ExcludedGenresContext.tsx";
import type { Genre } from "../../../core/types/tmdb.ts";
import { Icon } from "../../../shared/components/index.ts";
import { SettingsRow } from "./SettingsGroup.tsx";
import styles from "./SettingsPanel.module.css";

// Réglage "Genres à exclure" : les genres qu'on ne veut jamais voir
// suggérés, pour filtrer Découvrir/Nouveautés/Prochainement/Aléatoire et
// les recommandations d'une fiche. Nouvelle DA 8/10 : rangés comme "Mes
// plateformes", en grille de cases à cocher (2 colonnes sur desktop, 1 sur
// mobile) avec recherche ; genre exclu = case cochée, ligne corail et nom
// barré. Sur mobile, la colonne unique est trop longue : la grille devient
// un bloc scrollable (voir .genreGrid dans SettingsPanel.module.css).
export default function ExcludedGenresSettings() {
  const { t } = useTranslation();
  const { excludedGenreIds, toggleExcludedGenre } = useExcludedGenres();
  const [genres, setGenres] = useState<Genre[]>([]);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([getGenres("movie"), getGenres("tv")])
      .then(([movieGenres, tvGenres]) => {
        if (cancelled) {
          return;
        }
        const merged = new Map<number, Genre>();
        for (const g of [...(movieGenres.genres || []), ...(tvGenres.genres || [])]) {
          if (!merged.has(g.id)) {
            merged.set(g.id, g);
          }
        }
        setGenres([...merged.values()].sort((a, b) => a.name.localeCompare(b.name)));
        setStatus("success");
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmedQuery = query.trim().toLowerCase();
  const visibleGenres = trimmedQuery
    ? genres.filter((g) => g.name.toLowerCase().includes(trimmedQuery))
    : genres;

  return (
    <SettingsRow
      label={t("excludedGenres.summary")}
      description={t("excludedGenres.description")}
      wide
    >
      <span className={styles.meta}>
        {t("excludedGenres.meta", { count: excludedGenreIds.length })} ·{" "}
        {t("excludedGenres.toggleHint")}
      </span>
      {status === "loading" && (
        <p className={`${styles.status} ${styles.genresLoading}`}>{t("excludedGenres.loading")}</p>
      )}
      {status === "error" && <p className={styles.error}>{t("excludedGenres.error")}</p>}
      {status === "success" && (
        <>
          <label className={styles.search}>
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder={t("excludedGenres.searchPlaceholder")}
              aria-label={t("excludedGenres.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {visibleGenres.length === 0 && (
            <p className={styles.emptyHint}>{t("excludedGenres.noMatch")}</p>
          )}
          <div className={styles.genreGrid}>
            {visibleGenres.map((g) => {
              const excluded = excludedGenreIds.includes(g.id);
              return (
                <label
                  key={g.id}
                  className={`${styles.provider} ${excluded ? styles.genreExcluded : ""}`}
                >
                  <input
                    type="checkbox"
                    className={`${styles.checkbox} ${styles.genreCheckbox}`}
                    checked={excluded}
                    onChange={() => toggleExcludedGenre(g.id)}
                  />
                  <span>{g.name}</span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </SettingsRow>
  );
}
