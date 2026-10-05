import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "./AuthContext.tsx";
import { logWarn } from "../logger.ts";
import { syncClientHeaders, useLiveSyncRevision } from "../sync/liveSync.ts";
import {
  storageGet,
  storageGetJSON,
  storageSet,
  storageSetJSON,
} from "../../shared/lib/storage.ts";

// Langues originales préférées sur le compte (ex. "fr", "en"), pré-réglées
// une fois pour filtrer Nouveautés/Prochainement en un clic plutôt que de
// resélectionner une langue unique à chaque visite — même principe que
// FavoriteProvidersContext (voir ce fichier pour le détail de la
// synchronisation et son commentaire).
const STORAGE_KEY = "seancy.favoriteLanguages.v1";
const SYNC_DEBOUNCE_MS = 1200;
const SYNCED_FOR_KEY = "seancy.favoriteLanguages.syncedFor";

interface FavoriteLanguagesContextValue {
  favoriteLanguageCodes: string[];
  toggleFavoriteLanguage: (code: string) => void;
  isFavoriteLanguage: (code: string) => boolean;
}

const FavoriteLanguagesContext = createContext<FavoriteLanguagesContextValue | null>(null);

function loadInitialCodes(): string[] {
  const parsed = storageGetJSON<unknown>(STORAGE_KEY, []);
  return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
}

export function FavoriteLanguagesProvider({ children }: { children: ReactNode }) {
  const { status: authStatus, email } = useAuth();
  const [favoriteLanguageCodes, setFavoriteLanguageCodes] = useState<string[]>(loadInitialCodes);
  const isFirstRender = useRef(true);
  const syncingRef = useRef(false);
  const syncRevision = useLiveSyncRevision("favorite-languages");
  const lastSyncedJsonRef = useRef<string | null>(null);
  const currentCodesRef = useRef(favoriteLanguageCodes);
  currentCodesRef.current = favoriteLanguageCodes;

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    storageSetJSON(STORAGE_KEY, favoriteLanguageCodes);
  }, [favoriteLanguageCodes]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !email) {
      return;
    }
    if (
      syncRevision > 0 &&
      lastSyncedJsonRef.current !== null &&
      JSON.stringify(currentCodesRef.current) !== lastSyncedJsonRef.current
    ) {
      syncingRef.current = false;
      return;
    }
    let cancelled = false;
    syncingRef.current = true;

    fetch("/api/favorite-languages")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("sync failed"))))
      .then((remote: { languageCodes?: string[] }) => {
        if (cancelled) {
          return;
        }
        const remoteCodes = remote.languageCodes || [];
        const alreadySyncedFor = storageGet(SYNCED_FOR_KEY);
        if (alreadySyncedFor === email) {
          lastSyncedJsonRef.current = JSON.stringify(remoteCodes);
          setFavoriteLanguageCodes(remoteCodes);
          return null;
        }
        const merged = [...new Set([...favoriteLanguageCodes, ...remoteCodes])];
        setFavoriteLanguageCodes(merged);
        storageSet(SYNCED_FOR_KEY, email);
        return fetch("/api/favorite-languages", {
          method: "PUT",
          headers: { "content-type": "application/json", ...syncClientHeaders() },
          body: JSON.stringify({ languageCodes: merged, merge: true }),
        });
      })
      .catch((err) => logWarn("Seancy : synchronisation des langues favorites impossible.", err))
      .finally(() => {
        if (!cancelled) {
          syncingRef.current = false;
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, email, syncRevision]);

  useEffect(() => {
    if (authStatus !== "authenticated" || syncingRef.current) {
      return;
    }
    const serialized = JSON.stringify(favoriteLanguageCodes);
    if (serialized === lastSyncedJsonRef.current) {
      return;
    }
    const timeoutId = setTimeout(() => {
      fetch("/api/favorite-languages", {
        method: "PUT",
        headers: { "content-type": "application/json", ...syncClientHeaders() },
        body: JSON.stringify({ languageCodes: favoriteLanguageCodes }),
      })
        .then((res) => {
          if (res.ok) {
            lastSyncedJsonRef.current = serialized;
          }
        })
        .catch((err) =>
          logWarn(
            "Seancy : synchronisation des langues favorites impossible, nouvelle tentative au prochain changement.",
            err
          )
        );
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [favoriteLanguageCodes, authStatus]);

  const toggleFavoriteLanguage = useCallback((code: string) => {
    setFavoriteLanguageCodes((prev) =>
      prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]
    );
  }, []);

  const isFavoriteLanguage = useCallback(
    (code: string) => favoriteLanguageCodes.includes(code),
    [favoriteLanguageCodes]
  );

  const value = useMemo(
    () => ({ favoriteLanguageCodes, toggleFavoriteLanguage, isFavoriteLanguage }),
    [favoriteLanguageCodes, toggleFavoriteLanguage, isFavoriteLanguage]
  );

  return (
    <FavoriteLanguagesContext.Provider value={value}>{children}</FavoriteLanguagesContext.Provider>
  );
}

export function useFavoriteLanguages(): FavoriteLanguagesContextValue {
  const ctx = useContext(FavoriteLanguagesContext);
  if (!ctx) {
    throw new Error("useFavoriteLanguages doit être utilisé dans un FavoriteLanguagesProvider");
  }
  return ctx;
}
