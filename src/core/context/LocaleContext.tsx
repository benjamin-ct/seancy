import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import i18n, {
  LOCALE_STORAGE_KEY,
  ensureLocaleLoaded,
  isSupportedLocale,
  loadInitialLocale,
  type Locale,
} from "../i18n/i18n.ts";
import { storageSet } from "../../shared/lib/storage.ts";

// Langue de l'interface, indépendante du réglage des plateformes de
// streaming (voir FavoriteProvidersContext, qui reste piloté par
// RegionContext/le pays) : les deux réglages ne doivent jamais se piloter
// l'un l'autre (cf. carte Trello "Internationalisation de l'application").
// Détection auto à la première visite (langue du navigateur), avec
// possibilité de override manuel persisté ensuite : la langue initiale est
// résolue dans i18n.ts (loadInitialLocale), avant le premier rendu.

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() =>
    isSupportedLocale(i18n.language) ? i18n.language : loadInitialLocale()
  );

  useEffect(() => {
    // Traductions chargées à la demande (voir i18n.ts) : on n'active la
    // langue qu'une fois prête, et seulement si elle est toujours choisie.
    let cancelled = false;
    void ensureLocaleLoaded(locale).then(() => {
      if (!cancelled) {
        i18n.changeLanguage(locale);
      }
    });
    document.documentElement.setAttribute("lang", locale);
    storageSet(LOCALE_STORAGE_KEY, locale);
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale }), [locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useLocale doit être utilisé dans un LocaleProvider");
  }
  return ctx;
}
