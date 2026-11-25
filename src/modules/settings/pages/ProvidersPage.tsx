import { useTranslation } from "react-i18next";
import FavoriteProvidersSettings from "../../profile/components/FavoriteProvidersSettings.tsx";
import { SettingsGroup } from "../../profile/components/SettingsGroup.tsx";

// Titre de groupe repris de favoriteProvidersSettings.title/description :
// seule sous-page sans titre au-dessus du panneau blanc (toutes les autres en
// ont un), ce qui désalignait son panneau par rapport aux autres sous-pages
// (retour de review, PR #307) — FavoriteProvidersSettings ne porte plus son
// propre label sur sa ligne unique pour éviter le doublon (voir SettingsRow).
export default function ProvidersPage() {
  const { t } = useTranslation();
  return (
    <SettingsGroup
      title={t("favoriteProvidersSettings.title")}
      description={t("favoriteProvidersSettings.description")}
    >
      <FavoriteProvidersSettings />
    </SettingsGroup>
  );
}
