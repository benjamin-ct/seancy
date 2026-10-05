// Migration des clés localStorage de l'ancien nom de l'app (« bobine.* »)
// vers le nouveau (« seancy.* ») : bibliothèque, listes perso, réglages,
// marqueurs de synchro, abonnement push… Aucune donnée ne doit être perdue
// au renommage.
//
// Module à effet de bord, importé en tout premier dans main.tsx : les
// imports ES étant évalués dans l'ordre, la migration passe avant qu'un
// contexte ne lise son stockage. Idempotent et quasi gratuit une fois fait
// (plus aucune clé « bobine. » à parcourir). Si la nouvelle clé existe déjà
// (écrite entre-temps par la nouvelle version), elle fait foi et l'ancienne
// est simplement supprimée.
import { storageGet, storageRemove, storageSet } from "../../shared/lib/storage.ts";

const LEGACY_PREFIX = "bobine.";
const PREFIX = "seancy.";

try {
  const legacyKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(LEGACY_PREFIX)) {
      legacyKeys.push(key);
    }
  }
  // Clé par clé via le helper sûr : une clé qui échoue (quota dépassé...) ne
  // doit pas empêcher la migration des suivantes.
  for (const key of legacyKeys) {
    const newKey = PREFIX + key.slice(LEGACY_PREFIX.length);
    const value = storageGet(key);
    if (value !== null && storageGet(newKey) === null) {
      storageSet(newKey, value);
    }
    storageRemove(key);
  }
} catch {
  // localStorage indisponible (navigation privée stricte…) : rien à migrer.
}
