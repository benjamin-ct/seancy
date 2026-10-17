import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getWatchProvidersList, logoUrl } from "../../../core/api/tmdb.ts";
import { withGlobalProviders } from "../../../core/api/globalProviders.ts";
import { useRegion } from "../../../core/context/RegionContext.tsx";
import { useFavoriteProviders } from "../../../core/context/FavoriteProvidersContext.tsx";
import { Icon } from "../../../shared/components/index.ts";
import type { WatchProviderOption } from "../../../core/api/tmdb.ts";
import { SettingsRow } from "./SettingsGroup.tsx";
import styles from "./SettingsPanel.module.css";

// Réglage "Mes plateformes" : cocher une fois les quelques services qu'on a
// vraiment, pour ensuite filtrer Découvrir/Nouveautés/Aléatoire en un clic
// (chip "🎯 Mes plateformes" dans FilterBar) plutôt que de chercher dans le
// menu déroulant d'~100 entrées à chaque visite.
export default function FavoriteProvidersSettings() {
  const { t } = useTranslation();
  const { region } = useRegion();
  const { favoriteProviderIds, toggleFavoriteProvider } = useFavoriteProviders();
  const [providers, setProviders] = useState<WatchProviderOption[]>([]);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [query, setQuery] = useState("");

  // `status` n'est délibérément PAS une dépendance : ce `setStatus("loading")`
  // synchrone changerait `status` et redéclencherait l'effet immédiatement
  // (avant même que la requête réseau n'aboutisse), ce qui exécute le
  // cleanup ci-dessous et met `cancelled = true` sur la promesse en cours —
  // le composant reste alors bloqué sur "Chargement…" pour toujours, la
  // requête d'origine se terminant plus tard sur un `cancelled` déjà vrai.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    Promise.all([getWatchProvidersList("movie", region), getWatchProvidersList("tv", region)])
      .then(([movieList, tvList]) => {
        if (cancelled) {
          return;
        }
        const merged = new Map<number, WatchProviderOption>();
        for (const p of [...movieList, ...tvList]) {
          if (!merged.has(p.id)) {
            merged.set(p.id, p);
          }
        }
        const regional = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
        setProviders(withGlobalProviders(regional));
        setStatus("success");
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, [region]);

  const trimmedQuery = query.trim().toLowerCase();
  const visibleProviders = trimmedQuery
    ? providers.filter((p) => p.name.toLowerCase().includes(trimmedQuery))
    : providers;

  return (
    <SettingsRow
      label={t("favoriteProvidersSettings.title")}
      description={t("favoriteProvidersSettings.description")}
      wide
    >
      <span className={styles.meta}>
        {t("favoriteProvidersSettings.activeCount", { count: favoriteProviderIds.length })}
      </span>
      {status === "loading" && (
        <p className={`${styles.status} ${styles.providersLoading}`}>{t("common.loading")}</p>
      )}
      {status === "error" && (
        <p className={styles.error}>{t("favoriteProvidersSettings.loadError")}</p>
      )}
      {status === "success" && (
        <>
          <label className={styles.search}>
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder={t("favoriteProvidersSettings.searchPlaceholder")}
              aria-label={t("favoriteProvidersSettings.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className={styles.providerGrid}>
            {visibleProviders.map((p) => {
              const checked = favoriteProviderIds.includes(p.id);
              const logo = logoUrl(p.logoPath, "w92");
              return (
                <label
                  key={p.id}
                  className={`${styles.provider} ${checked ? styles.providerOn : ""}`}
                >
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={checked}
                    onChange={() => toggleFavoriteProvider(p.id)}
                  />
                  <span className={styles.providerLogo} aria-hidden="true">
                    {logo ? <img src={logo} alt="" loading="lazy" /> : p.name.charAt(0)}
                  </span>
                  <span>{p.name}</span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </SettingsRow>
  );
}
