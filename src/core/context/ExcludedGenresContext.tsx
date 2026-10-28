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
import {
  storageGet,
  storageGetJSON,
  storageSet,
  storageSetJSON,
} from "../../shared/lib/storage.ts";
import { syncClientHeaders, useLiveSyncRevision } from "../sync/liveSync.ts";

// Genres que la personne ne veut jamais voir suggérés (Horreur,
// Documentaire...), cochés une fois pour filtrer Découvrir/Nouveautés/
// Prochainement/Aléatoire et les recommandations d'une fiche. Stockage
// local par défaut (compte anonyme) ; synchronisé par compte pour un
// utilisateur connecté (voir l'effet de synchronisation plus bas), ce
// stockage local servant alors de cache/repli hors connexion — même
// principe que LibraryContext.
const STORAGE_KEY = "seancy.excludedGenres.v1";
const SYNC_DEBOUNCE_MS = 1200;
// Mémorise, par email, si on a déjà fait la fusion initiale local ↔ serveur
// sur CET appareil (voir l'effet de synchronisation plus bas).
const SYNCED_FOR_KEY = "seancy.excludedGenres.syncedFor";

interface ExcludedGenresContextValue {
  excludedGenreIds: number[];
  toggleExcludedGenre: (id: number) => void;
  isExcludedGenre: (id: number) => boolean;
}

const ExcludedGenresContext = createContext<ExcludedGenresContextValue | null>(null);

function loadInitialIds(): number[] {
  const parsed = storageGetJSON<unknown>(STORAGE_KEY, []);
  return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isFinite(id)) : [];
}

export function ExcludedGenresProvider({ children }: { children: ReactNode }) {
  const { status: authStatus, email } = useAuth();
  const [excludedGenreIds, setExcludedGenreIds] = useState<number[]>(loadInitialIds);
  const isFirstRender = useRef(true);
  // Le pull de synchronisation modifie l'état via setExcludedGenreIds : on
  // met cette ref à true pendant l'opération pour que l'effet de push
  // (plus bas) ne renvoie pas aussitôt au serveur les données qu'on vient
  // de recevoir.
  const syncingRef = useRef(false);
  // Synchro temps réel (voir core/sync/liveSync.ts) : incrémenté quand un
  // autre appareil du compte modifie ce réglage, pour rejouer le pull
  // ci-dessous. `lastSyncedJsonRef` = dernière valeur connue comme identique
  // côté serveur : évite de renvoyer en écho ce qu'on vient d'en recevoir,
  // et d'écraser par un pull un changement local pas encore envoyé.
  const syncRevision = useLiveSyncRevision("excluded-genres");
  const lastSyncedJsonRef = useRef<string | null>(null);
  const currentIdsRef = useRef(excludedGenreIds);
  currentIdsRef.current = excludedGenreIds;

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    storageSetJSON(STORAGE_KEY, excludedGenreIds);
  }, [excludedGenreIds]);

  // Synchronisation avec le compte : au moment où l'utilisateur devient
  // authentifié (connexion, ou session déjà active au chargement de la
  // page), on récupère les genres exclus du serveur.
  //  - Première fois sur cet appareil pour ce compte : fusion (union) avec
  //    les genres locaux existants (rien n'est perdu), puis renvoi du
  //    résultat fusionné au serveur.
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

    fetch("/api/excluded-genres")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("sync failed"))))
      .then((remote: { genreIds?: number[] }) => {
        if (cancelled) {
          return;
        }
        const remoteIds = remote.genreIds || [];
        const alreadySyncedFor = storageGet(SYNCED_FOR_KEY);
        if (alreadySyncedFor === email) {
          lastSyncedJsonRef.current = JSON.stringify(remoteIds);
          setExcludedGenreIds(remoteIds);
          return null;
        }
        const merged = [...new Set([...excludedGenreIds, ...remoteIds])];
        setExcludedGenreIds(merged);
        storageSet(SYNCED_FOR_KEY, email);
        // `merge: true` : `remoteIds` peut déjà être périmé si un autre
        // appareil vient de synchroniser entre le GET ci-dessus et ce PUT —
        // le serveur fait l'union avec ce qu'il a réellement plutôt que de
        // remplacer à l'aveugle (voir replaceExcludedGenresForUser).
        return fetch("/api/excluded-genres", {
          method: "PUT",
          headers: { "content-type": "application/json", ...syncClientHeaders() },
          body: JSON.stringify({ genreIds: merged, merge: true }),
        });
      })
      .catch((err) => logWarn("Seancy : synchronisation des genres exclus impossible.", err))
      .finally(() => {
        if (!cancelled) {
          syncingRef.current = false;
        }
      });

    return () => {
      cancelled = true;
    };
    // On ne veut relancer la synchro que quand le statut d'auth ou le
    // compte change, pas à chaque changement de `excludedGenreIds` (sinon
    // boucle).
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
    const serialized = JSON.stringify(excludedGenreIds);
    if (serialized === lastSyncedJsonRef.current) {
      return;
    }
    const timeoutId = setTimeout(() => {
      fetch("/api/excluded-genres", {
        method: "PUT",
        headers: { "content-type": "application/json", ...syncClientHeaders() },
        body: JSON.stringify({ genreIds: excludedGenreIds }),
      })
        .then((res) => {
          if (res.ok) {
            lastSyncedJsonRef.current = serialized;
          }
        })
        .catch((err) =>
          logWarn(
            "Seancy : synchronisation des genres exclus impossible, nouvelle tentative au prochain changement.",
            err
          )
        );
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [excludedGenreIds, authStatus]);

  const toggleExcludedGenre = useCallback((id: number) => {
    setExcludedGenreIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const isExcludedGenre = useCallback(
    (id: number) => excludedGenreIds.includes(id),
    [excludedGenreIds]
  );

  const value = useMemo(
    () => ({ excludedGenreIds, toggleExcludedGenre, isExcludedGenre }),
    [excludedGenreIds, toggleExcludedGenre, isExcludedGenre]
  );

  return <ExcludedGenresContext.Provider value={value}>{children}</ExcludedGenresContext.Provider>;
}

export function useExcludedGenres(): ExcludedGenresContextValue {
  const ctx = useContext(ExcludedGenresContext);
  if (!ctx) {
    throw new Error("useExcludedGenres doit être utilisé dans un ExcludedGenresProvider");
  }
  return ctx;
}
