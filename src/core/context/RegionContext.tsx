import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_REGION, getTheatricalStatusIndex, type TheatricalIndex } from "../api/tmdb.ts";
import { isLikelyAutomatedClient } from "../botDetection.ts";
import { DEFAULT_LOCALE, type Locale } from "../i18n/i18n.ts";
import { useLocale } from "./LocaleContext.tsx";
import { storageGet, storageSet } from "../../shared/lib/storage.ts";

interface RegionContextValue {
  region: string;
  regionName: string | null;
  getTheatricalStatus: (movieId: number) => "upcoming" | "in_theaters" | null;
  setRegion: (region: string) => void;
}

const RegionContext = createContext<RegionContextValue | null>(null);

// Choix manuel de région, indépendant de la détection /api/region : une fois
// posé (localStorage hors connexion, compte via RegionAccountSync sinon —
// voir ce fichier pour le principe général déjà appliqué à la langue), la
// géolocalisation IP ne doit plus jamais l'écraser au chargement suivant —
// elle ne sert que de repli tant qu'aucun choix explicite n'existe (VPN/
// déplacement : le profil reste sur la région de base de l'utilisateur).
const STORAGE_KEY = "seancy.region";

export function isValidRegionCode(value: string): boolean {
  return /^[A-Z]{2}$/.test(value);
}

export function loadStoredRegion(): string | null {
  const stored = storageGet(STORAGE_KEY);
  return stored && isValidRegionCode(stored) ? stored : null;
}

function persistRegion(region: string): void {
  storageSet(STORAGE_KEY, region);
}

// Nom du pays dans la locale active (ex. "FR" -> "France"/"France", "US" ->
// "États-Unis"/"United States"), via l'API native du navigateur — pas
// d'appel réseau supplémentaire, pas de liste à maintenir. Une instance
// Intl.DisplayNames par locale, réutilisée plutôt que recréée à chaque appel.
const regionDisplayNamesByLocale = new Map<Locale, Intl.DisplayNames>();

function getRegionDisplayNames(locale: Locale): Intl.DisplayNames | null {
  if (typeof Intl.DisplayNames !== "function") {
    return null;
  }
  let instance = regionDisplayNamesByLocale.get(locale);
  if (!instance) {
    instance = new Intl.DisplayNames([locale], { type: "region" });
    regionDisplayNamesByLocale.set(locale, instance);
  }
  return instance;
}

export function regionName(
  code: string | null | undefined,
  locale: Locale = DEFAULT_LOCALE
): string | null {
  if (!code) {
    return null;
  }
  try {
    return getRegionDisplayNames(locale)?.of(code) || code;
  } catch {
    return code;
  }
}

// Région déduite de l'IP par le Worker (/api/region), ou null si
// indisponible (hors ligne, dev local sans Worker).
export function fetchRegion(): Promise<string | null> {
  return fetch("/api/region")
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { country?: string } | null) => data?.country || null)
    .catch(() => null);
}

// Détecte le pays du visiteur via /api/region (déduit par Cloudflare au
// niveau du edge, voir worker/index.ts — aucune permission navigateur,
// aucun service tiers). Utilisé pour adapter "Où regarder" et la liste des
// plateformes disponibles à la région réelle de la personne, plutôt que de
// supposer la France pour tout le monde.
export function RegionProvider({
  children,
  initialRegion,
  regionRequest,
}: {
  children: ReactNode;
  // Résolue en amont du montage (voir main.tsx) pour éviter tout rendu
  // transitoire avec DEFAULT_REGION avant que /api/region ne réponde — sans
  // ça, chaque page dont le fetch dépend de la région (Discover, Nouveautés,
  // À venir, Au hasard...) démarre avec des résultats FR par défaut puis se
  // rafraîchit intégralement une fois la vraie région connue, ce qui donne
  // l'impression que l'appli clignote/se recharge au premier affichage.
  initialRegion?: string;
  // Requête /api/region déjà lancée par main.tsx (null si une région est
  // mémorisée) : reprise telle quelle plutôt que refaite.
  regionRequest?: Promise<string | null> | null;
}) {
  const { locale } = useLocale();
  const [region, setRegionState] = useState(initialRegion ?? DEFAULT_REGION);
  // Index "au cinéma"/"bientôt" (voir getTheatricalStatusIndex) consulté
  // par MediaCard pour la pastille de grille, sans appel réseau par carte.
  // Vide tant que le premier chargement n'est pas terminé.
  const [theatricalIndex, setTheatricalIndex] = useState<TheatricalIndex>(new Map());

  useEffect(() => {
    // Ne consulte /api/region que tant qu'aucune région n'a déjà été
    // choisie manuellement sur cet appareil — sinon la géolocalisation IP
    // écraserait un choix explicite à chaque chargement (cas VPN/
    // déplacement que ce choix manuel sert justement à éviter).
    if (loadStoredRegion()) {
      return;
    }
    let cancelled = false;
    // Sans résultat (null), on garde l'état initial (DEFAULT_REGION) — ex.
    // en dev local où /api/region n'existe pas (Vite seul, pas de Worker).
    void (regionRequest ?? fetchRegion()).then((country) => {
      if (!cancelled && country) {
        setRegionState(country);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Choix manuel (réglages du profil) : persisté localement tout de suite,
  // et synchronisé sur le compte par RegionAccountSync si connecté — voir
  // ce composant pour le détail (même principe que setLocale/LocaleContext).
  const setRegion = useCallback((next: string) => {
    persistRegion(next);
    setRegionState(next);
  }, []);

  useEffect(() => {
    // Purement décoratif (pastille "au cinéma"/"bientôt" sur les cartes,
    // voir MediaCard) : jamais nécessaire au contenu/SEO d'une page, donc le
    // seul appel de ce fichier qu'on peut se permettre de sauter pour un
    // client détecté comme automatisé — voir botDetection.ts. C'était
    // aussi, de loin, l'endpoint le plus appelé dans le ticket Trello
    // "Milliers de calls workers" (/api/theatrical-index, ~450 invocations
    // sur la période analysée), déclenché sur CHAQUE route de l'app puisque
    // RegionProvider enveloppe toute l'application dans main.tsx.
    if (isLikelyAutomatedClient(navigator)) {
      return;
    }
    let cancelled = false;
    getTheatricalStatusIndex(region)
      .then((index) => {
        if (!cancelled) {
          setTheatricalIndex(index);
        }
      })
      .catch(() => {
        // Repli silencieux : les cartes affichent alors simplement l'absence
        // de pastille "au cinéma", pas une erreur bloquante.
      });
    return () => {
      cancelled = true;
    };
  }, [region]);

  const getTheatricalStatus = useCallback(
    (movieId: number) => theatricalIndex.get(movieId) || null,
    [theatricalIndex]
  );

  const value = useMemo(
    () => ({ region, regionName: regionName(region, locale), getTheatricalStatus, setRegion }),
    [region, locale, getTheatricalStatus, setRegion]
  );

  return <RegionContext.Provider value={value}>{children}</RegionContext.Provider>;
}

export function useRegion(): RegionContextValue {
  const ctx = useContext(RegionContext);
  if (!ctx) {
    throw new Error("useRegion doit être utilisé dans un RegionProvider");
  }
  return ctx;
}
