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

// Pays de production préférés sur le compte (ex. "FR", "US"), pré-réglés une
// fois pour filtrer Nouveautés/Prochainement en un clic plutôt que de
// resélectionner un pays unique à chaque visite — même principe que
// FavoriteProvidersContext (voir ce fichier pour le détail de la
// synchronisation et son commentaire).
const STORAGE_KEY = "seancy.favoriteCountries.v1";
const SYNC_DEBOUNCE_MS = 1200;
const SYNCED_FOR_KEY = "seancy.favoriteCountries.syncedFor";

interface FavoriteCountriesContextValue {
  favoriteCountryCodes: string[];
  toggleFavoriteCountry: (code: string) => void;
  isFavoriteCountry: (code: string) => boolean;
}

const FavoriteCountriesContext = createContext<FavoriteCountriesContextValue | null>(null);

function loadInitialCodes(): string[] {
  const parsed = storageGetJSON<unknown>(STORAGE_KEY, []);
  return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
}

export function FavoriteCountriesProvider({ children }: { children: ReactNode }) {
  const { status: authStatus, email } = useAuth();
  const [favoriteCountryCodes, setFavoriteCountryCodes] = useState<string[]>(loadInitialCodes);
  const isFirstRender = useRef(true);
  const syncingRef = useRef(false);
  const syncRevision = useLiveSyncRevision("favorite-countries");
  const lastSyncedJsonRef = useRef<string | null>(null);
  const currentCodesRef = useRef(favoriteCountryCodes);
  currentCodesRef.current = favoriteCountryCodes;

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    storageSetJSON(STORAGE_KEY, favoriteCountryCodes);
  }, [favoriteCountryCodes]);

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

    fetch("/api/favorite-countries")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("sync failed"))))
      .then((remote: { countryCodes?: string[] }) => {
        if (cancelled) {
          return;
        }
        const remoteCodes = remote.countryCodes || [];
        const alreadySyncedFor = storageGet(SYNCED_FOR_KEY);
        if (alreadySyncedFor === email) {
          lastSyncedJsonRef.current = JSON.stringify(remoteCodes);
          setFavoriteCountryCodes(remoteCodes);
          return null;
        }
        const merged = [...new Set([...favoriteCountryCodes, ...remoteCodes])];
        setFavoriteCountryCodes(merged);
        storageSet(SYNCED_FOR_KEY, email);
        return fetch("/api/favorite-countries", {
          method: "PUT",
          headers: { "content-type": "application/json", ...syncClientHeaders() },
          body: JSON.stringify({ countryCodes: merged, merge: true }),
        });
      })
      .catch((err) => logWarn("Seancy : synchronisation des pays favoris impossible.", err))
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
    const serialized = JSON.stringify(favoriteCountryCodes);
    if (serialized === lastSyncedJsonRef.current) {
      return;
    }
    const timeoutId = setTimeout(() => {
      fetch("/api/favorite-countries", {
        method: "PUT",
        headers: { "content-type": "application/json", ...syncClientHeaders() },
        body: JSON.stringify({ countryCodes: favoriteCountryCodes }),
      })
        .then((res) => {
          if (res.ok) {
            lastSyncedJsonRef.current = serialized;
          }
        })
        .catch((err) =>
          logWarn(
            "Seancy : synchronisation des pays favoris impossible, nouvelle tentative au prochain changement.",
            err
          )
        );
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [favoriteCountryCodes, authStatus]);

  const toggleFavoriteCountry = useCallback((code: string) => {
    setFavoriteCountryCodes((prev) =>
      prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]
    );
  }, []);

  const isFavoriteCountry = useCallback(
    (code: string) => favoriteCountryCodes.includes(code),
    [favoriteCountryCodes]
  );

  const value = useMemo(
    () => ({ favoriteCountryCodes, toggleFavoriteCountry, isFavoriteCountry }),
    [favoriteCountryCodes, toggleFavoriteCountry, isFavoriteCountry]
  );

  return (
    <FavoriteCountriesContext.Provider value={value}>{children}</FavoriteCountriesContext.Provider>
  );
}

export function useFavoriteCountries(): FavoriteCountriesContextValue {
  const ctx = useContext(FavoriteCountriesContext);
  if (!ctx) {
    throw new Error("useFavoriteCountries doit être utilisé dans un FavoriteCountriesProvider");
  }
  return ctx;
}
