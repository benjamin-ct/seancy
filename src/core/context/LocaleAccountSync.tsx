import { useEffect, useRef, type ReactNode } from "react";
import { useAuth } from "./AuthContext.tsx";
import { isSupportedLocale } from "../i18n/i18n.ts";
import { useLocale } from "./LocaleContext.tsx";
import { logWarn } from "../logger.ts";
import { syncClientHeaders, useLiveSyncRevision } from "../sync/liveSync.ts";
import { storageSet } from "../../shared/lib/storage.ts";

// Synchronise la langue avec le compte, sur le même principe que
// FavoriteProvidersContext (voir ce fichier pour le détail du principe
// général) : composant séparé plutôt qu'intégré à LocaleProvider, car
// AuthContext dépend déjà de useLocale() (langue du mail "lien de
// connexion") — LocaleProvider ne peut donc pas dépendre en retour de
// useAuth() sans créer une dépendance circulaire entre les deux providers.
// Contrairement aux plateformes favorites (une liste, fusionnable), la
// langue est une valeur unique : pas de fusion, le serveur fait autorité
// dès qu'une valeur y est enregistrée ; sinon la valeur locale actuelle est
// poussée comme valeur initiale du compte.
const SYNCED_FOR_KEY = "seancy.locale.syncedFor";

export function LocaleAccountSync({ children }: { children: ReactNode }): ReactNode {
  const { status, email } = useAuth();
  const { locale, setLocale } = useLocale();
  const syncingRef = useRef(false);
  // Synchro temps réel (voir core/sync/liveSync.ts) : rejoue le pull
  // ci-dessous quand un autre appareil du compte change ce réglage.
  // `lastSyncedRef` évite de renvoyer en écho la valeur qu'on vient de recevoir.
  const syncRevision = useLiveSyncRevision("locale");
  const lastSyncedRef = useRef<string | null>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;

  useEffect(() => {
    if (status !== "authenticated" || !email) {
      return;
    }
    let cancelled = false;
    syncingRef.current = true;

    fetch("/api/locale")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("locale fetch failed"))))
      .then((remote: { locale?: string | null }) => {
        if (cancelled) {
          return;
        }
        if (remote.locale && isSupportedLocale(remote.locale)) {
          lastSyncedRef.current = remote.locale;
          setLocale(remote.locale);
          storageSet(SYNCED_FOR_KEY, email);
          return;
        }
        // Aucune préférence enregistrée côté compte pour l'instant : cet
        // appareil pousse sa valeur actuelle comme valeur initiale.
        storageSet(SYNCED_FOR_KEY, email);
        return fetch("/api/locale", {
          method: "PUT",
          headers: { "content-type": "application/json", ...syncClientHeaders() },
          body: JSON.stringify({ locale: localeRef.current }),
        }).then(() => undefined);
      })
      .catch((err) => logWarn("Seancy : synchronisation de la langue impossible.", err))
      .finally(() => {
        if (!cancelled) {
          syncingRef.current = false;
        }
      });

    return () => {
      cancelled = true;
    };
    // On ne veut relancer la synchro que quand le statut d'auth ou le
    // compte change, pas à chaque changement de `locale` (sinon boucle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, email, syncRevision]);

  useEffect(() => {
    if (status !== "authenticated" || syncingRef.current || locale === lastSyncedRef.current) {
      return;
    }
    fetch("/api/locale", {
      method: "PUT",
      headers: { "content-type": "application/json", ...syncClientHeaders() },
      body: JSON.stringify({ locale }),
    })
      .then((res) => {
        if (res.ok) {
          lastSyncedRef.current = locale;
        }
      })
      .catch((err) =>
        logWarn(
          "Seancy : synchronisation de la langue impossible, nouvelle tentative au prochain changement.",
          err
        )
      );
  }, [locale, status]);

  return children;
}
