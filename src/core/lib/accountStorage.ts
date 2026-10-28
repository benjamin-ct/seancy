// Données du compte gardées sur l'appareil (localStorage) : bibliothèque,
// listes perso, réglages de filtrage et marqueurs "déjà synchronisé pour
// <email>". Elles ne doivent plus rester dans le navigateur une fois
// l'utilisateur déconnecté : ces actions sont réservées aux membres
// connectés, et le serveur fait foi à la prochaine connexion.
//
// Restent volontairement sur l'appareil : le thème, la langue et le pays
// (réglages d'affichage appliqués aussi hors connexion), ainsi que
// l'abonnement push de l'appareil (seancy.push.*), nécessaire pour le
// détacher du compte côté serveur (voir core/sync/pushAccountLink.ts).
import { storageGet, storageRemove } from "../../shared/lib/storage.ts";

const ACCOUNT_DATA_KEYS = [
  "seancy.library.v1",
  "seancy.customLists.v1",
  "seancy.watchlistOrder.v1",
  "seancy.excludedTitles.v1",
  "seancy.excludedTitles.labels.v1",
  "seancy.excludedGenres.v1",
  "seancy.favoriteProviders.v1",
  "seancy.topPicks.v1",
];

const SYNCED_FOR_KEYS = [
  "seancy.library.syncedFor",
  "seancy.customLists.syncedFor",
  "seancy.excludedGenres.syncedFor",
  "seancy.favoriteProviders.syncedFor",
  "seancy.locale.syncedFor",
  "seancy.region.syncedFor",
];

// Vrai si cet appareil a déjà été synchronisé avec un compte : sert à
// repérer une session perdue (expirée, cookie effacé) sans passer par le
// bouton de déconnexion.
export function hasAccountDataOnDevice(): boolean {
  return SYNCED_FOR_KEYS.some((key) => storageGet(key) !== null);
}

export function clearAccountDataFromDevice(): void {
  for (const key of [...ACCOUNT_DATA_KEYS, ...SYNCED_FOR_KEYS]) {
    storageRemove(key);
  }
}
