// Boutons d'une page placés dans l'en-tête de l'espace admin sur téléphone
// (chercher, réglages, nouveau…) ; sur ordinateur, l'emplacement est caché et
// la page garde ses propres boutons.
import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HeaderSlot } from "./headerSlot.ts";

export default function HeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlot);
  return slot ? createPortal(children, slot) : null;
}
