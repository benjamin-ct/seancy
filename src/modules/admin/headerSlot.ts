// Emplacement des boutons d'une page dans l'en-tête de l'espace admin sur
// téléphone (à droite du titre, comme le panneau de Paddock Live) : posé par
// AdminApp, rempli par HeaderActions.
import { createContext } from "react";

export const HeaderSlot = createContext<HTMLElement | null>(null);
