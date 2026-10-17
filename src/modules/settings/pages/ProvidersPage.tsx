import FavoriteProvidersSettings from "../../profile/components/FavoriteProvidersSettings.tsx";
import { SettingsGroup } from "../../profile/components/SettingsGroup.tsx";

// Pas de titre/texte d'intro ici : favoriteProvidersSettings.title/description
// (FavoriteProvidersSettings) jouent déjà ce rôle sur son unique ligne — un
// second titre ferait doublon avec le sommaire.
export default function ProvidersPage() {
  return (
    <SettingsGroup>
      <FavoriteProvidersSettings />
    </SettingsGroup>
  );
}
