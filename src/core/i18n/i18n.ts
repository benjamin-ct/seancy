import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import fr from "./locales/fr.json";
import { storageGet, storageSet } from "../../shared/lib/storage.ts";

export const SUPPORTED_LOCALES = ["fr", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "fr";

// Seul le français (langue par défaut et de repli) est dans le bundle
// initial : les autres langues sont des chunks séparés, chargés par
// ensureLocaleLoaded avant d'être activées (audit H6).
const LOCALE_LOADERS: Partial<Record<Locale, () => Promise<unknown>>> = {
  en: () => import("./locales/en.json").then((m) => m.default),
};

// Choix manuel mémorisé (Profil → Langue), sinon langue du navigateur. Lu
// ici, de façon synchrone avant `init`, pour que i18next démarre dans la
// bonne langue : les premiers appels TMDB (qui lisent i18n.language, voir
// tmdbClient.ts) partent alors directement dans cette langue, au lieu d'être
// faits en français puis refaits (ou pas, selon la page) une fois la langue
// appliquée par LocaleProvider (audit H8).
export const LOCALE_STORAGE_KEY = "seancy.locale";

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

function detectBrowserLocale(): Locale {
  if (typeof navigator === "undefined") {
    return DEFAULT_LOCALE;
  }
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const candidate of candidates) {
    const base = candidate?.slice(0, 2).toLowerCase();
    if (base && isSupportedLocale(base)) {
      return base;
    }
  }
  return DEFAULT_LOCALE;
}

export function loadInitialLocale(): Locale {
  const stored = storageGet(LOCALE_STORAGE_KEY);
  if (stored && isSupportedLocale(stored)) {
    return stored;
  }
  return detectBrowserLocale();
}

const initialLocale = loadInitialLocale();
if (typeof document !== "undefined") {
  document.documentElement.lang = initialLocale;
}

// Si la langue initiale n'est pas le français, ses traductions arrivent
// avant le premier rendu (voir ensureLocaleLoaded dans main.tsx) ; d'ici là,
// les textes retombent sur le français.
i18next.use(initReactI18next).init({
  resources: {
    fr: { translation: fr },
  },
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  interpolation: { escapeValue: false },
});

// Remplace la langue initiale avant le premier rendu, quand celle enregistrée
// sur le compte diffère de celle de cet appareil (voir main.tsx). Les
// traductions doivent déjà être chargées (ensureLocaleLoaded).
export function applyInitialLocale(locale: Locale): void {
  void i18next.changeLanguage(locale);
  document.documentElement.lang = locale;
  storageSet(LOCALE_STORAGE_KEY, locale);
}

// Charge les traductions de `locale` si ce n'est pas déjà fait. En cas
// d'échec (hors ligne, chunk introuvable), l'interface reste en français.
export async function ensureLocaleLoaded(locale: Locale): Promise<void> {
  if (locale === DEFAULT_LOCALE || i18next.hasResourceBundle(locale, "translation")) {
    return;
  }
  const load = LOCALE_LOADERS[locale];
  if (!load) {
    return;
  }
  try {
    const translation = await load();
    i18next.addResourceBundle(locale, "translation", translation);
  } catch {
    // Repli silencieux sur fallbackLng.
  }
}

export default i18next;
