import { useTranslation } from "react-i18next";
import FavoriteProvidersSettings from "../../profile/components/FavoriteProvidersSettings.tsx";
import { SettingsGroup } from "../../profile/components/SettingsGroup.tsx";

export default function ProvidersPage() {
  const { t } = useTranslation();
  return (
    <SettingsGroup
      title={t("settings.sections.plateformes.title")}
      description={t("settingsPages.plateformes.lead")}
    >
      <FavoriteProvidersSettings />
    </SettingsGroup>
  );
}
