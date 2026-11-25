import { useTranslation } from "react-i18next";
import FavoriteLanguagesSettings from "../../profile/components/FavoriteLanguagesSettings.tsx";
import FavoriteCountriesSettings from "../../profile/components/FavoriteCountriesSettings.tsx";
import ExcludedGenresSettings from "../../profile/components/ExcludedGenresSettings.tsx";
import ExcludedTitlesSettings from "../../profile/components/ExcludedTitlesSettings.tsx";
import { SettingsGroup } from "../../profile/components/SettingsGroup.tsx";

export default function RecommendationsPage() {
  const { t } = useTranslation();
  return (
    <SettingsGroup
      title={t("profile.recommendations")}
      description={t("profile.recommendationsLead")}
    >
      <FavoriteLanguagesSettings />
      <FavoriteCountriesSettings />
      <ExcludedGenresSettings />
      <ExcludedTitlesSettings />
    </SettingsGroup>
  );
}
