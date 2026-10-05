import { useEffect, useRef, type ReactNode } from "react";
import { useAuth } from "./AuthContext.tsx";
import { isValidRegionCode, useRegion } from "./RegionContext.tsx";
import { logWarn } from "../logger.ts";
import { syncClientHeaders, useLiveSyncRevision } from "../sync/liveSync.ts";
import { storageSet } from "../../shared/lib/storage.ts";

// Synchronise la région choisie manuellement avec le compte, sur le même
// principe que LocaleAccountSync (voir ce fichier pour le détail général) :
// composant séparé plutôt qu'intégré à RegionProvider, pour la même raison
// (RegionProvider est un ancêtre d'AuthProvider, qui ne peut donc pas en
// dépendre en retour sans dépendance circulaire). Valeur unique comme la
// langue : pas de fusion, le serveur fait autorité dès qu'une valeur y est
// enregistrée ; sinon la valeur locale actuelle (choix manuel ou repli
// /api/region déjà résolu) est poussée comme valeur initiale du compte.
const SYNCED_FOR_KEY = "seancy.region.syncedFor";

export function RegionAccountSync({ children }: { children: ReactNode }): ReactNode {
  const { status, email } = useAuth();
  const { region, setRegion } = useRegion();
  const syncingRef = useRef(false);
  // Synchro temps réel (voir core/sync/liveSync.ts) : rejoue le pull
  // ci-dessous quand un autre appareil du compte change ce réglage.
  // `lastSyncedRef` évite de renvoyer en écho la valeur qu'on vient de recevoir.
  const syncRevision = useLiveSyncRevision("region");
  const lastSyncedRef = useRef<string | null>(null);
  const regionRef = useRef(region);
  regionRef.current = region;

  useEffect(() => {
    if (status !== "authenticated" || !email) {
      return;
    }
    let cancelled = false;
    syncingRef.current = true;

    fetch("/api/profile/region")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("region fetch failed"))))
      .then((remote: { region?: string | null }) => {
        if (cancelled) {
          return;
        }
        if (remote.region && isValidRegionCode(remote.region)) {
          lastSyncedRef.current = remote.region;
          setRegion(remote.region);
          storageSet(SYNCED_FOR_KEY, email);
          return;
        }
        // Aucune région enregistrée côté compte pour l'instant : cet
        // appareil pousse sa valeur actuelle (choix manuel ou géolocalisation
        // déjà résolue) comme valeur initiale.
        storageSet(SYNCED_FOR_KEY, email);
        return fetch("/api/profile/region", {
          method: "PUT",
          headers: { "content-type": "application/json", ...syncClientHeaders() },
          body: JSON.stringify({ region: regionRef.current }),
        }).then(() => undefined);
      })
      .catch((err) => logWarn("Seancy : synchronisation de la région impossible.", err))
      .finally(() => {
        if (!cancelled) {
          syncingRef.current = false;
        }
      });

    return () => {
      cancelled = true;
    };
    // On ne veut relancer la synchro que quand le statut d'auth ou le
    // compte change, pas à chaque changement de `region` (sinon boucle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, email, syncRevision]);

  useEffect(() => {
    if (status !== "authenticated" || syncingRef.current || region === lastSyncedRef.current) {
      return;
    }
    fetch("/api/profile/region", {
      method: "PUT",
      headers: { "content-type": "application/json", ...syncClientHeaders() },
      body: JSON.stringify({ region }),
    })
      .then((res) => {
        if (res.ok) {
          lastSyncedRef.current = region;
        }
      })
      .catch((err) =>
        logWarn(
          "Seancy : synchronisation de la région impossible, nouvelle tentative au prochain changement.",
          err
        )
      );
  }, [region, status]);

  return children;
}
