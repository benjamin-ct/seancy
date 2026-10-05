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

// Plateformes de streaming que la personne a réellement (Netflix, Disney+...),
// cochées une fois pour filtrer Découvrir/Nouveautés/Aléatoire en un clic
// plutôt que de chercher dans les ~100 entrées du menu déroulant à chaque
// visite. Stockage local par défaut (compte anonyme) ; synchronisé par
// compte pour un utilisateur connecté (voir l'effet de synchronisation plus
// bas), ce stockage local servant alors de cache/repli hors connexion —
// même principe que LibraryContext.
const STORAGE_KEY = "seancy.favoriteProviders.v1";
const SYNC_DEBOUNCE_MS = 1200;
// Mémorise, par email, si on a déjà fait la fusion initiale local ↔ serveur
// sur CET appareil (voir l'effet de synchronisation plus bas).
const SYNCED_FOR_KEY = "seancy.favoriteProviders.syncedFor";

interface FavoriteProvidersContextValue {
  favoriteProviderIds: number[];
  toggleFavoriteProvider: (id: number) => void;
  isFavoriteProvider: (id: number) => boolean;
}

const FavoriteProvidersContext = createContext<FavoriteProvidersContextValue | null>(null);

function loadInitialIds(): number[] {
  const parsed = storageGetJSON<unknown>(STORAGE_KEY, []);
  return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isFinite(id)) : [];
}

export function FavoriteProvidersProvider({ children }: { children: ReactNode }) {
  const { status: authStatus, email } = useAuth();
  const [favoriteProviderIds, setFavoriteProviderIds] = useState<number[]>(loadInitialIds);
  const isFirstRender = useRef(true);
  // Le pull de synchronisation modifie l'état via setFavoriteProviderIds :
  // on met cette ref à true pendant l'opération pour que l'effet de push
  // (plus bas) ne renvoie pas aussitôt au serveur les données qu'on vient
  // de recevoir.
  const syncingRef = useRef(false);
  // Synchro temps réel (voir core/sync/liveSync.ts) : incrémenté quand un
  // autre appareil du compte modifie ce réglage, pour rejouer le pull
  // ci-dessous. `lastSyncedJsonRef` = dernière valeur connue comme identique
  // côté serveur : évite de renvoyer en écho ce qu'on vient d'en recevoir,
  // et d'écraser par un pull un changement local pas encore envoyé.
  const syncRevision = useLiveSyncRevision("favorite-providers");
  const lastSyncedJsonRef = useRef<string | null>(null);
  const currentIdsRef = useRef(favoriteProviderIds);
  currentIdsRef.current = favoriteProviderIds;

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    storageSetJSON(STORAGE_KEY, favoriteProviderIds);
  }, [favoriteProviderIds]);

  // Synchronisation avec le compte : au moment où l'utilisateur devient
  // authentifié (connexion, ou session déjà active au chargement de la
  // page), on récupère les plateformes favorites du serveur.
  //  - Première fois sur cet appareil pour ce compte : fusion (union) avec
  //    les plateformes locales existantes (rien n'est perdu), puis renvoi
  //    du résultat fusionné au serveur.
  //  - Les fois suivantes : le serveur fait autorité (il reflète le
  //    dernier appareil ayant synchronisé), on remplace l'état local.
  useEffect(() => {
    if (authStatus !== "authenticated" || !email) {
      return;
    }
    if (
      syncRevision > 0 &&
      lastSyncedJsonRef.current !== null &&
      JSON.stringify(currentIdsRef.current) !== lastSyncedJsonRef.current
    ) {
      // Changement local en attente d'envoi : il partira au prochain push
      // (et sera à son tour diffusé aux autres appareils). Un pull
      // précédent annulé en vol ne doit pas laisser ce push bloqué.
      syncingRef.current = false;
      return;
    }
    let cancelled = false;
    syncingRef.current = true;

    fetch("/api/favorite-providers")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("sync failed"))))
      .then((remote: { providerIds?: number[] }) => {
        if (cancelled) {
          return;
        }
        const remoteIds = remote.providerIds || [];
        const alreadySyncedFor = storageGet(SYNCED_FOR_KEY);
        if (alreadySyncedFor === email) {
          lastSyncedJsonRef.current = JSON.stringify(remoteIds);
          setFavoriteProviderIds(remoteIds);
          return null;
        }
        const merged = [...new Set([...favoriteProviderIds, ...remoteIds])];
        setFavoriteProviderIds(merged);
        storageSet(SYNCED_FOR_KEY, email);
        // `merge: true` : `remoteIds` peut déjà être périmé si un autre
        // appareil vient de synchroniser entre le GET ci-dessus et ce PUT —
        // le serveur fait l'union avec ce qu'il a réellement plutôt que de
        // remplacer à l'aveugle (voir replaceFavoriteProvidersForUser).
        return fetch("/api/favorite-providers", {
          method: "PUT",
          headers: { "content-type": "application/json", ...syncClientHeaders() },
          body: JSON.stringify({ providerIds: merged, merge: true }),
        });
      })
      .catch((err) =>
        logWarn("Seancy : synchronisation des plateformes favorites impossible.", err)
      )
      .finally(() => {
        if (!cancelled) {
          syncingRef.current = false;
        }
      });

    return () => {
      cancelled = true;
    };
    // On ne veut relancer la synchro que quand le statut d'auth ou le
    // compte change, pas à chaque changement de `favoriteProviderIds`
    // (sinon boucle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, email, syncRevision]);

  // Envoie l'état complet au serveur à chaque changement, avec anti-rebond
  // (même principe que LibraryContext) — pas de synchronisation
  // incrémentale ici, ce réglage ne comporte jamais assez d'entrées pour
  // qu'un diff apporte quoi que ce soit.
  useEffect(() => {
    if (authStatus !== "authenticated" || syncingRef.current) {
      return;
    }
    const serialized = JSON.stringify(favoriteProviderIds);
    if (serialized === lastSyncedJsonRef.current) {
      return;
    }
    const timeoutId = setTimeout(() => {
      fetch("/api/favorite-providers", {
        method: "PUT",
        headers: { "content-type": "application/json", ...syncClientHeaders() },
        body: JSON.stringify({ providerIds: favoriteProviderIds }),
      })
        .then((res) => {
          if (res.ok) {
            lastSyncedJsonRef.current = serialized;
          }
        })
        .catch((err) =>
          logWarn(
            "Seancy : synchronisation des plateformes favorites impossible, nouvelle tentative au prochain changement.",
            err
          )
        );
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [favoriteProviderIds, authStatus]);

  const toggleFavoriteProvider = useCallback((id: number) => {
    setFavoriteProviderIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const isFavoriteProvider = useCallback(
    (id: number) => favoriteProviderIds.includes(id),
    [favoriteProviderIds]
  );

  const value = useMemo(
    () => ({ favoriteProviderIds, toggleFavoriteProvider, isFavoriteProvider }),
    [favoriteProviderIds, toggleFavoriteProvider, isFavoriteProvider]
  );

  return (
    <FavoriteProvidersContext.Provider value={value}>{children}</FavoriteProvidersContext.Provider>
  );
}

export function useFavoriteProviders(): FavoriteProvidersContextValue {
  const ctx = useContext(FavoriteProvidersContext);
  if (!ctx) {
    throw new Error("useFavoriteProviders doit être utilisé dans un FavoriteProvidersProvider");
  }
  return ctx;
}
