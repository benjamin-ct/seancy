// Store externe pour la bibliothèque (vu / envie de voir), lu en dehors du
// Context React par les sélecteurs fins de useLibrarySelectors.ts.
//
// Pourquoi : LibraryContext expose un seul Context monolithique — n'importe
// quel composant qui appelle useLibrary() se re-rend à CHAQUE action sur la
// bibliothèque, même s'il ne lit que le statut d'un seul titre (Audit H9 du
// 2026-09-28 : cocher "Vu" sur un film re-rendait toutes les cartes de la
// grille). Ce module tient une copie à jour de `watched`/`watchlist` en
// dehors de React, mise à jour par LibraryProvider (voir setLibrarySnapshot),
// pour que useSyncExternalStore puisse n'avertir que les composants dont LA
// valeur précise a changé.
import { storageGet } from "../../shared/lib/storage.ts";
import { logWarn } from "../logger.ts";
import type { LibraryState } from "../types/library.ts";

export const LIBRARY_STORAGE_KEY = "seancy.library.v1";

export function loadInitialLibraryState(): LibraryState {
  try {
    const raw = storageGet(LIBRARY_STORAGE_KEY);
    if (!raw) {
      return { watched: {}, watchlist: {} };
    }
    const parsed = JSON.parse(raw);
    return {
      watched: parsed.watched || {},
      watchlist: parsed.watchlist || {},
    };
  } catch (err) {
    // Le contenu stocké n'est pas du JSON valide (écriture interrompue,
    // corruption...). On repart sur une bibliothèque vide MAIS on se garde
    // bien d'écraser tout de suite localStorage avec cet état vide — voir
    // LibraryContext, qui ne persiste qu'à partir du premier changement réel.
    logWarn("Seancy : lecture de la bibliothèque locale impossible, on repart à vide.", err);
    return { watched: {}, watchlist: {} };
  }
}

type Listener = () => void;

// Initialisé synchronement avec la même lecture localStorage que
// LibraryProvider, pour que les sélecteurs fins affichent la bonne valeur
// dès le premier rendu (pas de flash "non vu" avant que l'effet de synchro
// du Provider n'ait tourné).
let snapshot: LibraryState = loadInitialLibraryState();
const listeners = new Set<Listener>();

export function getLibrarySnapshot(): LibraryState {
  return snapshot;
}

// Appelé uniquement par LibraryProvider (useLayoutEffect, pour rester
// synchrone avant peinture) à chaque changement de son propre état : ce
// module ne fait que refléter cet état, il n'a pas sa propre logique.
export function setLibrarySnapshot(next: LibraryState): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeToLibrary(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
