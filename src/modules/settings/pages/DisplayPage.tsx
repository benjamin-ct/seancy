import { useTranslation } from "react-i18next";
import LanguageSettings from "../../profile/components/LanguageSettings.tsx";
import RegionSettings from "../../profile/components/RegionSettings.tsx";
import ThemeSettings from "../../profile/components/ThemeSettings.tsx";
import { SettingsGroup } from "../../profile/components/SettingsGroup.tsx";

export default function DisplayPage() {
  const { t } = useTranslation();
  return (
    <SettingsGroup title={t("profile.display")} description={t("profile.displayLead")}>
      <LanguageSettings />
      <RegionSettings />
      <ThemeSettings />
    </SettingsGroup>
  );
}
