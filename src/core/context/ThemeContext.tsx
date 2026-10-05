import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { storageGet, storageSet } from "../../shared/lib/storage.ts";

// NOUVEAU (repris de la maquette HTML, le Projet A n'avait qu'un thème
// sombre fixe avant migration) : choix clair/sombre/auto, persisté et
// appliqué via `data-theme` sur <html> (voir src/styles/variables.css,
// qui définit les deux jeux de tokens). En mode "auto", le thème appliqué
// suit en direct la préférence système (`prefers-color-scheme`), y compris
// si elle change pendant que l'app est ouverte (review sur la carte Trello).
export type Theme = "dark" | "light";
export type ThemePreference = Theme | "auto";

const STORAGE_KEY = "seancy.theme";

// Couleurs de l'en-tête (voir --header-bg dans variables.css) dupliquées ici en dur :
// on ne peut pas lire une custom property CSS pour alimenter un <meta>, et
// ce sont les mêmes valeurs que le loader statique d'index.html.
const THEME_COLOR: Record<Theme, string> = {
  dark: "#0c1a30",
  light: "#fbf9f5",
};

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPreference(): Theme {
  return typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function loadInitialPreference(): ThemePreference {
  const stored = storageGet(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "auto") {
    return stored;
  }
  return "auto";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(loadInitialPreference);
  const [systemTheme, setSystemTheme] = useState<Theme>(systemPreference);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = () => setSystemTheme(query.matches ? "light" : "dark");
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  const theme: Theme = preference === "auto" ? systemTheme : preference;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    // iOS Safari ignore souvent un setAttribute("content", ...) sur la meta
    // existante (couleur de barre de statut jamais rafraîchie sans recharger
    // la page) : on supprime l'ancien noeud et on en insère un nouveau, ce
    // qui force le navigateur à relire la valeur.
    document.querySelector('meta[name="theme-color"]')?.remove();
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", THEME_COLOR[theme]);
    document.head.appendChild(meta);

    // En PWA installée sur iOS, la zone sous la barre de statut translucide
    // n'est repeinte qu'au scroll, jamais spontanément à un changement de
    // CSS. Un scroll synthétique a été tenté ici (rounds 6 à 10) mais s'est
    // révélé non fiable sur device réel ; retiré (voir carte Trello "Le
    // haut de l'écran n'est pas de la bonne couleur") — limitation WebKit
    // documentée (https://developer.apple.com/forums/thread/739154), pas
    // contournable en JS sans un vrai geste de scroll utilisateur.
  }, [theme]);

  useEffect(() => {
    storageSet(STORAGE_KEY, preference);
  }, [preference]);

  const value = useMemo(() => ({ theme, preference, setPreference }), [theme, preference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme doit être utilisé dans un ThemeProvider");
  }
  return ctx;
}
