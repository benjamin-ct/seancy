import { useTranslation } from "react-i18next";
import { useAuth } from "../../core/context/AuthContext.tsx";
import { useFavoriteProviders } from "../../core/context/FavoriteProvidersContext.tsx";
import { useTheme } from "../../core/context/ThemeContext.tsx";

// Résumé d'état d'une ligne du sommaire (ex. « 3 plateformes actives »,
// « Profil privé ») pour les sections où une valeur dynamique simple est
// disponible sans coupler le sommaire à la logique interne de chaque sous-
// page. Les autres sections utilisent leur description statique
// (settings.sections.<id>.summary) directement dans le composant appelant.
export function useSettingsSummary(id: string): string | null {
  const { t } = useTranslation();
  const { shareSlug } = useAuth();
  const { favoriteProviderIds } = useFavoriteProviders();
  const { preference } = useTheme();

  if (id === "confidentialite") {
    return shareSlug ? t("profileShare.statusPublic") : t("profileShare.statusPrivate");
  }
  if (id === "plateformes") {
    return t("settings.summaryProviders", { count: favoriteProviderIds.length });
  }
  if (id === "affichage") {
    return t(`themeSettings.${preference}`);
  }
  return null;
}
