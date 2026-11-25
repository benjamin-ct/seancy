import PublicProfileSettings, {
  ListInviteRestrictionSettings,
} from "../../profile/components/PublicProfileSettings.tsx";

// Confidentialité : partage du profil public, puis qui peut nous ajouter à
// une liste commune (ticket « Ma liste commune »).
export default function PrivacyPage() {
  return (
    <>
      <PublicProfileSettings />
      <ListInviteRestrictionSettings />
    </>
  );
}
