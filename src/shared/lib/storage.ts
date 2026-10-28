// Point d'accès unique à `localStorage` (audit F7) : avant, 47 accès
// dispersés dans 15 fichiers, certains sans `try/catch` — ça plante en
// navigation privée stricte (Safari/Firefox) ou quand le quota est plein.
// Ici, toute exception est avalée et journalée (logWarn en lecture, logError
// en écriture/suppression puisqu'une écriture qui échoue perd des données),
// jamais propagée à l'appelant.
import { logError, logWarn } from "../../core/logger.ts";

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    logWarn(`Seancy : lecture de "${key}" dans le stockage local impossible.`, err);
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    logError(`Seancy : écriture de "${key}" dans le stockage local impossible.`, err);
  }
}

export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (err) {
    logError(`Seancy : suppression de "${key}" dans le stockage local impossible.`, err);
  }
}

/** Lit une valeur JSON ; `fallback` au moindre souci (absente, JSON invalide, stockage indisponible). */
export function storageGetJSON<T>(key: string, fallback: T): T {
  const raw = storageGet(key);
  if (raw === null) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logWarn(`Seancy : contenu JSON invalide pour "${key}" dans le stockage local.`, err);
    return fallback;
  }
}

export function storageSetJSON(key: string, value: unknown): void {
  storageSet(key, JSON.stringify(value));
}
