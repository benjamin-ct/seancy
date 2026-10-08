import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "./AuthContext.tsx";
import { useMembersOnly } from "./MembersOnlyContext.tsx";
import { getDetails } from "../api/tmdb.ts";
import { logWarn } from "../logger.ts";
import { syncClientHeaders, useLiveSyncEvent } from "../sync/liveSync.ts";
import {
  LIBRARY_STORAGE_KEY,
  loadInitialLibraryState,
  setLibrarySnapshot,
} from "./libraryStore.ts";
import {
  storageGet,
  storageGetJSON,
  storageSet,
  storageSetJSON,
} from "../../shared/lib/storage.ts";
import type {
  CustomList,
  CustomListMap,
  DirectorRef,
  EpisodeRef,
  LibraryItem,
  LibraryItemInput,
  LibraryItemMap,
  LibraryState,
} from "../types/library.ts";
import type { MediaType } from "../types/tmdb.ts";

// Mémorise, par email, si on a déjà fait la fusion initiale local ↔ serveur
// sur CET appareil (voir l'effet de synchronisation plus bas).
const SYNCED_FOR_KEY = "seancy.library.syncedFor";
const SYNC_DEBOUNCE_MS = 1200;
// Listes personnalisées ("Soirée avec X", "Halloween"...) — synchronisées par
// compte comme watched/watchlist ci-dessus (voir l'effet de synchronisation
// plus bas), avec ce stockage local comme cache/repli hors connexion.
const CUSTOM_LISTS_STORAGE_KEY = "seancy.customLists.v1";
// Mémorise, par email, si on a déjà fait la fusion initiale local ↔ serveur
// des listes perso sur CET appareil — même rôle que SYNCED_FOR_KEY pour
// watched/watchlist, mais distinct : les deux synchronisations sont
// indépendantes (une première connexion peut fusionner l'une sans l'autre si
// une seule des deux requêtes échoue).
const CUSTOM_LISTS_SYNCED_FOR_KEY = "seancy.customLists.syncedFor";
// NOUVEAU (repris de la maquette HTML) : ordre manuel de "Envie de voir"
// (glisser-déposer). Stockage local uniquement — un ordre d'affichage n'a
// pas vocation à être synchronisé entre appareils au même titre que le
// contenu de la liste elle-même.
const WATCHLIST_ORDER_STORAGE_KEY = "seancy.watchlistOrder.v1";

// Delta diffusé par le serveur après un /api/library/sync d'un autre appareil
// (voir worker/sync.ts, publishToUser dans handleLibrarySync).
interface RemoteLibraryDelta {
  upserts: Array<{
    mediaType: MediaType;
    tmdbId: number;
    status: "watched" | "watchlist";
    item: LibraryItem;
  }>;
  deletes: Array<{ mediaType: MediaType; id: number }>;
}

type PendingOp =
  | {
      action: "upsert";
      mediaType: MediaType;
      id: number;
      status: "watched" | "watchlist";
      item: LibraryItem;
    }
  | { action: "delete"; mediaType: MediaType; id: number };

interface LibraryContextValue {
  watched: LibraryItem[];
  watchlist: LibraryItem[];
  watchedIds: Set<string>;
  /** `watchedAt` optionnel (ms epoch) : date réelle de visionnage si différente
   * d'aujourd'hui — voir DetailPage, sélecteur de date de visionnage. */
  toggleWatched: (item: LibraryItemInput, watchedAt?: number) => void;
  toggleWatchlist: (item: LibraryItemInput) => void;
  isWatched: (mediaType: MediaType, id: number | string) => boolean;
  isInWatchlist: (mediaType: MediaType, id: number | string) => boolean;
  getRating: (mediaType: MediaType, id: number | string) => number | null;
  rateWatched: (mediaType: MediaType, id: number | string, rating: number | null) => void;
  setRuntime: (mediaType: MediaType, id: number | string, runtimeMinutes: number) => void;
  setDirectors: (mediaType: MediaType, id: number | string, directors: DirectorRef[]) => void;
  getWatchedEpisodes: (mediaType: MediaType, id: number | string) => Set<string>;
  isEpisodeWatched: (
    mediaType: MediaType,
    id: number | string,
    season: number,
    episode: number
  ) => boolean;
  toggleEpisodeWatched: (item: LibraryItemInput, season: number, episode: number) => void;
  /** Coche/décoche plusieurs épisodes d'un coup (saison entière, « Vu jusqu'ici »).
   * `watchedAt` optionnel (ms epoch, uniquement pris en compte quand `watched`
   * est vrai) : voir `toggleWatched`. */
  setEpisodesWatched: (
    item: LibraryItemInput,
    episodes: EpisodeRef[],
    watched: boolean,
    watchedAt?: number
  ) => void;
  /** « Marquer la série comme vue » : passe la série en "vu" et coche `episodes`.
   * `watchedAt` optionnel : voir `toggleWatched`. */
  markSeriesWatched: (item: LibraryItemInput, episodes: EpisodeRef[], watchedAt?: number) => void;
  /** Glisser-déposer dans "Envie de voir" (tri manuel) — voir modules/my-list. */
  reorderWatchlist: (fromKey: string, toKey: string, insertAfter: boolean) => void;
  customLists: CustomList[];
  createList: (name: string) => string | null;
  renameList: (listId: string, name: string) => void;
  deleteList: (listId: string) => void;
  addToList: (listId: string, item: LibraryItemInput) => void;
  removeFromList: (listId: string, mediaType: MediaType, id: number | string) => void;
  isInList: (listId: string, mediaType: MediaType, id: number | string) => boolean;
  getListItems: (listId: string) => LibraryItem[];
  /** Glisser-déposer dans une liste perso (tri manuel) — voir modules/my-list. */
  reorderList: (listId: string, fromKey: string, toKey: string, insertAfter: boolean) => void;
}

// Actions des cartes (MediaCard, rangées de listes) séparées du reste :
// leur valeur ne dépend pas de l'état de la bibliothèque, donc une carte
// qui ne lit que ça (plus les sélecteurs fins de useLibrarySelectors.ts)
// ne se re-rend plus à chaque action sur la bibliothèque — useLibrary(),
// recalculé à chaque changement d'état, re-rendait toute la grille.
interface LibraryActionsContextValue {
  toggleWatched: LibraryContextValue["toggleWatched"];
  toggleWatchlist: LibraryContextValue["toggleWatchlist"];
}

const LibraryActionsContext = createContext<LibraryActionsContextValue | null>(null);

const LibraryContext = createContext<LibraryContextValue | null>(null);

function makeKey(mediaType: MediaType, id: number | string): string {
  return `${mediaType}:${id}`;
}

// Ancien format de stockage (avant la correction du bug #32 : liste vide
// malgré des titres ajoutés) — une liste perso ne gardait que les clés,
// résolues à l'affichage depuis watched/watchlist. `itemKeys` peut encore
// traîner dans le JSON existant en localStorage ; voir l'effet de migration
// plus bas, qui la consomme puis la fait disparaître.
interface LegacyCustomListShape {
  id?: string;
  name?: string;
  items?: LibraryItem[];
  itemKeys?: string[];
  createdAt?: number;
}

function loadInitialCustomLists(): CustomListMap {
  try {
    const raw = storageGet(CUSTOM_LISTS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const normalized: CustomListMap = {};
    for (const [id, list] of Object.entries(parsed as Record<string, LegacyCustomListShape>)) {
      const hasLegacyKeys = Array.isArray(list.itemKeys) && list.itemKeys.length > 0;
      normalized[id] = {
        id: list.id || id,
        name: list.name || "",
        items: Array.isArray(list.items) ? list.items : [],
        createdAt: list.createdAt || Date.now(),
        // Conservé uniquement le temps que l'effet de migration (voir plus
        // bas) le lise une fois puis le retire au premier setCustomLists —
        // absent du type CustomList, donc jamais lu ailleurs.
        ...(hasLegacyKeys ? { itemKeys: list.itemKeys } : {}),
      } as CustomList;
    }
    return normalized;
  } catch (err) {
    logWarn("Seancy : lecture des listes personnalisées impossible, on repart à vide.", err);
    return {};
  }
}

function loadInitialWatchlistOrder(): string[] {
  const parsed = storageGetJSON<unknown>(WATCHLIST_ORDER_STORAGE_KEY, []);
  return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
}

function makeListId(): string {
  return `list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeEpisodeKey(season: number, episode: number): string {
  return `${season}-${episode}`;
}

// Un titre a au plus une entrée (soit "watched", soit "watchlist" — voir
// toggleWatched/toggleWatchlist) : c'est là que vit `watchedEpisodes` s'il
// existe, quelle que soit la liste concernée.
function findShowEntry(
  state: LibraryState,
  mediaType: MediaType,
  id: number | string
): LibraryItem | null {
  const key = makeKey(mediaType, id);
  return state.watched[key] || state.watchlist[key] || null;
}

// Fusionne deux bibliothèques (locale + serveur) : pour chaque titre présent
// des deux côtés, on garde la version la plus récente (updatedAt) ; sinon on
// garde celle qui existe. Utilisé uniquement lors de la toute première
// synchronisation sur un appareil (voir l'effet ci-dessous) — au-delà, le
// serveur fait autorité pour éviter de faire réapparaître des titres
// supprimés ailleurs.
function mergeLists(local: LibraryItemMap, remote: LibraryItemMap): LibraryItemMap {
  const merged: LibraryItemMap = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const a = local[key];
    const b = remote[key];
    if (a && b) {
      merged[key] = (a.updatedAt || a.addedAt || 0) >= (b.updatedAt || b.addedAt || 0) ? a : b;
    } else {
      merged[key] = a || b;
    }
  }
  return merged;
}

// Fusionne deux jeux de listes perso (locale + serveur), utilisé uniquement
// lors de la toute première synchronisation sur un appareil — au-delà, le
// serveur fait autorité (même logique que mergeLists ci-dessus). Les ids sont
// générés aléatoirement par appareil (voir makeListId) : une même liste créée
// avant la connexion sur deux appareils différents produit deux ids
// distincts, donc une simple union suffit dans l'immense majorité des cas.
// Dans le cas rare d'un id partagé (le serveur reflète déjà cet appareil),
// on garde la version avec le plus d'items plutôt que de risquer d'en perdre.
function mergeCustomLists(local: CustomListMap, remote: CustomListMap): CustomListMap {
  const merged: CustomListMap = {};
  for (const id of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const a = local[id];
    const b = remote[id];
    if (a && b) {
      merged[id] = a.items.length >= b.items.length ? a : b;
    } else {
      merged[id] = a || b;
    }
  }
  return merged;
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { status: authStatus, email } = useAuth();
  const { requireMember } = useMembersOnly();
  const [state, setState] = useState<LibraryState>(loadInitialLibraryState);
  // Évite d'écraser le localStorage dès le premier rendu : on ne persiste
  // qu'à partir du moment où l'état change réellement suite à une action de
  // l'utilisateur (toggle, import...).
  const isFirstRender = useRef(true);
  // Le pull de synchronisation modifie `state` via setState : on met cette
  // ref à true pendant l'opération pour que l'effet de push (plus bas) ne
  // renvoie pas aussitôt au serveur les données qu'on vient de recevoir.
  const syncingRef = useRef(false);
  // File des changements pas encore envoyés au serveur : clé "mediaType:id"
  // -> opération finale à appliquer (upsert avec l'item complet, ou delete).
  const pendingOpsRef = useRef(new Map<string, PendingOp>());
  const [customLists, setCustomLists] = useState<CustomListMap>(loadInitialCustomLists);
  const isFirstCustomListsRender = useRef(true);
  // File des listes perso pas encore envoyées au serveur depuis le dernier
  // envoi (audit M4, « synchro incrémentale ») : clé = listId, valeur = objet
  // {action} dédié (pas juste la chaîne "upsert"/"delete") pour que l'effet
  // de push ci-dessous puisse détecter par égalité de référence qu'une liste
  // a été modifiée À NOUVEAU pendant qu'un envoi de son état précédent était
  // en vol, et ne pas effacer cette marque plus récente — même principe que
  // `pendingOpsRef` pour la bibliothèque. Avant l'audit M4, chaque changement
  // renvoyait TOUTES les listes du compte (voir l'historique git) ; chaque
  // liste n'envoie désormais que son propre état.
  const pendingCustomListOpsRef = useRef(new Map<string, { action: "upsert" | "delete" }>());
  const markCustomListDirty = useCallback((listId: string, action: "upsert" | "delete") => {
    pendingCustomListOpsRef.current.set(listId, { action });
  }, []);
  // Tant que le pull initial (fusion) n'est pas allé à son terme, l'effet de
  // push ci-dessous reste inactif : sans ça, il pourrait renvoyer au serveur
  // l'état LOCAL seul (pas encore fusionné avec le serveur) pendant la
  // fenêtre où le pull est en vol, et écraser des listes distantes que la
  // fusion n'a pas encore eu la chance de rapatrier.
  const customListsSyncSettledRef = useRef(false);
  const [watchlistOrder, setWatchlistOrder] = useState<string[]>(loadInitialWatchlistOrder);
  const isFirstWatchlistOrderRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    storageSetJSON(LIBRARY_STORAGE_KEY, state);
  }, [state]);

  // Reflète `state` dans le store externe (voir libraryStore.ts) pour les
  // sélecteurs fins (useIsWatched...), en layout effect pour rester
  // synchrone avant peinture — un effet passif classique laisserait un
  // MediaCard afficher brièvement l'ancien statut après un clic.
  useLayoutEffect(() => {
    setLibrarySnapshot(state);
  }, [state]);

  useEffect(() => {
    if (isFirstCustomListsRender.current) {
      isFirstCustomListsRender.current = false;
      return;
    }
    storageSetJSON(CUSTOM_LISTS_STORAGE_KEY, customLists);
  }, [customLists]);

  useEffect(() => {
    if (isFirstWatchlistOrderRender.current) {
      isFirstWatchlistOrderRender.current = false;
      return;
    }
    storageSetJSON(WATCHLIST_ORDER_STORAGE_KEY, watchlistOrder);
  }, [watchlistOrder]);

  // Migration one-shot des listes perso créées avant la correction du bug
  // #32 ("« X » est vide" malgré des titres ajoutés) : l'ancien format ne
  // stockait qu'une clé par titre, résolue à l'affichage depuis
  // watched/watchlist — un titre ajouté à une liste sans jamais être marqué
  // "vu" ni "envie de voir" (le coeur du bug) n'avait donc aucune donnée
  // récupérable localement. On tente ici de la reconstituer depuis TMDB
  // (titre, affiche, genres) avant de perdre définitivement ces clés.
  const didMigrateLegacyListsRef = useRef(false);
  useEffect(() => {
    if (didMigrateLegacyListsRef.current) {
      return;
    }
    didMigrateLegacyListsRef.current = true;

    const legacyLists = Object.values(customLists).filter((list) =>
      Array.isArray((list as { itemKeys?: string[] }).itemKeys)
    );
    if (legacyLists.length === 0) {
      return;
    }

    let cancelled = false;
    (async () => {
      for (const legacy of legacyLists) {
        const itemKeys = (legacy as { itemKeys?: string[] }).itemKeys || [];
        const existingKeys = new Set(legacy.items.map((item) => makeKey(item.mediaType, item.id)));
        const recovered: LibraryItem[] = [];
        for (const key of itemKeys) {
          if (existingKeys.has(key)) {
            continue;
          }
          const [mediaType, rawId] = key.split(":");
          const known = state.watched[key] || state.watchlist[key];
          if (known) {
            recovered.push(known);
            continue;
          }
          try {
            const details = await getDetails(mediaType as MediaType, rawId);
            const now = Date.now();
            recovered.push({
              id: Number(rawId),
              mediaType: mediaType as MediaType,
              title: details.title || details.name || t("common.unknownTitle"),
              posterPath: details.poster_path ?? null,
              date: details.release_date || details.first_air_date,
              genreIds: details.genres?.map((g) => g.id) || [],
              addedAt: now,
              updatedAt: now,
            });
          } catch (err) {
            // Titre introuvable côté TMDB (supprimé du catalogue...) : on
            // laisse tomber cette entrée plutôt que de bloquer la migration
            // des autres listes/titres.
            logWarn(`Seancy : migration impossible pour "${key}".`, err);
          }
        }
        if (cancelled) {
          return;
        }
        setCustomLists((prev) => {
          const current = prev[legacy.id] as (CustomList & { itemKeys?: string[] }) | undefined;
          if (!current) {
            return prev;
          }
          const { itemKeys: _itemKeys, ...rest } = current;
          return {
            ...prev,
            [legacy.id]: { ...rest, items: [...current.items, ...recovered] },
          };
        });
        markCustomListDirty(legacy.id, "upsert");
      }
    })();

    return () => {
      cancelled = true;
    };
    // Migration one-shot au montage uniquement (voir le ref ci-dessus) :
    // volontairement pas de dépendances au-delà du premier rendu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Synchronisation avec le compte : au moment où l'utilisateur devient
  // authentifié (connexion, ou session déjà active au chargement de la
  // page), on récupère la bibliothèque du serveur.
  //  - Première fois sur cet appareil pour ce compte : on fusionne avec les
  //    données locales existantes (rien n'est perdu) puis on renvoie le
  //    résultat fusionné au serveur.
  //  - Les fois suivantes : le serveur fait autorité (il reflète le dernier
  //    appareil ayant synchronisé), on remplace l'état local.
  useEffect(() => {
    if (authStatus !== "authenticated" || !email) {
      return;
    }
    let cancelled = false;
    syncingRef.current = true;

    fetch("/api/library")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("sync failed"))))
      .then((remote: LibraryState) => {
        if (cancelled) {
          return;
        }
        const alreadySyncedFor = storageGet(SYNCED_FOR_KEY);
        if (alreadySyncedFor === email) {
          setState({ watched: remote.watched || {}, watchlist: remote.watchlist || {} });
          pendingOpsRef.current.clear();
          return null;
        }
        // Première synchro sur cet appareil pour ce compte : fusion.
        const merged: LibraryState = {
          watched: mergeLists(state.watched, remote.watched || {}),
          watchlist: mergeLists(state.watchlist, remote.watchlist || {}),
        };
        setState(merged);
        pendingOpsRef.current.clear(); // le PUT complet ci-dessous couvre déjà tout `merged`
        storageSet(SYNCED_FOR_KEY, email);
        return fetch("/api/library", {
          method: "PUT",
          headers: { "content-type": "application/json", ...syncClientHeaders() },
          body: JSON.stringify(merged),
        });
      })
      .catch((err) => logWarn("Seancy : synchronisation de la bibliothèque impossible.", err))
      .finally(() => {
        if (!cancelled) {
          syncingRef.current = false;
        }
      });

    return () => {
      cancelled = true;
    };
    // On ne veut relancer la synchro que quand le statut d'auth ou le
    // compte change, pas à chaque changement de `state` (sinon boucle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, email]);

  // Envoie au serveur uniquement ce qui a changé depuis le dernier envoi
  // (voir pendingOpsRef), avec un léger anti-rebond pour regrouper les
  // actions rapprochées (ex. "tout marquer vu" sur une saison) en un seul
  // appel plutôt qu'un par item.
  useEffect(() => {
    if (authStatus !== "authenticated" || syncingRef.current) {
      return;
    }
    const timeoutId = setTimeout(() => {
      if (pendingOpsRef.current.size === 0) {
        return;
      }
      const opsSnapshot = new Map(pendingOpsRef.current);
      const upserts: Array<{
        mediaType: MediaType;
        id: number;
        status: string;
        item: LibraryItem;
      }> = [];
      const deletes: Array<{ mediaType: MediaType; id: number }> = [];
      for (const op of opsSnapshot.values()) {
        if (op.action === "upsert") {
          upserts.push({ mediaType: op.mediaType, id: op.id, status: op.status, item: op.item });
        } else {
          deletes.push({ mediaType: op.mediaType, id: op.id });
        }
      }
      fetch("/api/library/sync", {
        method: "POST",
        headers: { "content-type": "application/json", ...syncClientHeaders() },
        body: JSON.stringify({ upserts, deletes }),
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error("sync failed");
          }
          // Ne retire que ce qui vient d'être envoyé ET n'a pas été modifié
          // entre-temps (comparaison par référence) : une nouvelle action
          // survenue pendant que la requête était en vol ne doit pas être
          // perdue, elle reste en file pour le prochain envoi.
          for (const [key, op] of opsSnapshot) {
            if (pendingOpsRef.current.get(key) === op) {
              pendingOpsRef.current.delete(key);
            }
          }
        })
        .catch((err) =>
          logWarn(
            "Seancy : synchronisation incrémentale impossible, nouvelle tentative au prochain changement.",
            err
          )
        );
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [state, authStatus]);

  // Synchronisation des listes perso avec le compte — même principe que la
  // synchronisation watched/watchlist ci-dessus (fusion à la première
  // connexion sur un appareil, serveur autoritaire ensuite), mais sur son
  // propre indicateur "déjà synchronisé" : les deux synchros sont
  // indépendantes l'une de l'autre.
  useEffect(() => {
    if (authStatus !== "authenticated" || !email) {
      return;
    }
    let cancelled = false;
    customListsSyncSettledRef.current = false;

    fetch("/api/custom-lists")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("sync failed"))))
      .then((remote: CustomListMap) => {
        if (cancelled) {
          return;
        }
        const alreadySyncedFor = storageGet(CUSTOM_LISTS_SYNCED_FOR_KEY);
        if (alreadySyncedFor === email) {
          // Le serveur fait autorité : on remplace l'état local. Aucune
          // liste n'est "sale" après ça : rien à renvoyer, on vient de le
          // recevoir.
          setCustomLists(remote || {});
          return null;
        }
        // Première synchro sur cet appareil pour ce compte : fusion.
        const merged = mergeCustomLists(customLists, remote || {});
        setCustomLists(merged);
        storageSet(CUSTOM_LISTS_SYNCED_FOR_KEY, email);
        return fetch("/api/custom-lists", {
          method: "PUT",
          headers: { "content-type": "application/json", ...syncClientHeaders() },
          body: JSON.stringify(merged),
        });
      })
      .catch((err) =>
        logWarn("Seancy : synchronisation des listes personnalisées impossible.", err)
      )
      .finally(() => {
        if (!cancelled) {
          customListsSyncSettledRef.current = true;
        }
      });

    return () => {
      cancelled = true;
    };
    // On ne veut relancer la synchro que quand le statut d'auth ou le
    // compte change, pas à chaque changement de `customLists` (sinon boucle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, email]);

  // Envoie au serveur uniquement les listes perso modifiées depuis le
  // dernier envoi (audit M4, voir pendingCustomListOpsRef), avec le même
  // anti-rebond que l'effet équivalent pour `state` ci-dessus — pour
  // regrouper les modifications rapprochées (ex. plusieurs glisser-déposer
  // de suite) en un seul envoi par liste plutôt qu'un par étape.
  useEffect(() => {
    if (authStatus !== "authenticated" || !customListsSyncSettledRef.current) {
      return;
    }
    if (pendingCustomListOpsRef.current.size === 0) {
      return;
    }
    const timeoutId = setTimeout(() => {
      const opsSnapshot = new Map(pendingCustomListOpsRef.current);
      const requests = Array.from(opsSnapshot, ([listId, op]) => {
        const request =
          op.action === "delete"
            ? fetch(`/api/custom-lists/${encodeURIComponent(listId)}`, {
                method: "DELETE",
                headers: syncClientHeaders(),
              })
            : fetch(`/api/custom-lists/${encodeURIComponent(listId)}`, {
                method: "PUT",
                headers: { "content-type": "application/json", ...syncClientHeaders() },
                // Lu au moment de l'envoi (pas au moment du toggle) : si la
                // liste a encore changé depuis la mise en file, c'est bien
                // sa dernière version qui part.
                body: JSON.stringify(customLists[listId] || { name: "", items: [] }),
              });
        return request
          .then(() => {
            // Ne retire que si cette liste n'a pas été modifiée À NOUVEAU
            // depuis la prise de cette snapshot (même garde que
            // pendingOpsRef pour la bibliothèque, voir plus haut).
            if (pendingCustomListOpsRef.current.get(listId) === op) {
              pendingCustomListOpsRef.current.delete(listId);
            }
          })
          .catch((err) =>
            logWarn(
              `Seancy : synchronisation de la liste perso "${listId}" impossible, nouvelle tentative au prochain changement.`,
              err
            )
          );
      });
      void Promise.all(requests);
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [customLists, authStatus]);

  // Synchro temps réel (voir core/sync/liveSync.ts) ---------------------
  //
  // Bibliothèque : le serveur diffuse le delta exact reçu d'un autre
  // appareil (/api/library/sync), appliqué ici directement à l'état local —
  // aucun aller-retour serveur. Sans delta (fusion initiale d'un nouvel
  // appareil, ou resynchronisation après une coupure), on recharge la seule
  // bibliothèque. Dans les deux cas, une clé modifiée localement et pas encore
  // envoyée (pendingOpsRef) garde sa valeur locale : elle partira au prochain
  // envoi et sera à son tour diffusée aux autres appareils.
  const applyRemoteLibrary = useCallback((remote: LibraryState) => {
    setState((prev) => {
      const next: LibraryState = {
        watched: { ...(remote.watched || {}) },
        watchlist: { ...(remote.watchlist || {}) },
      };
      for (const key of pendingOpsRef.current.keys()) {
        delete next.watched[key];
        delete next.watchlist[key];
        if (prev.watched[key]) {
          next.watched[key] = prev.watched[key];
        }
        if (prev.watchlist[key]) {
          next.watchlist[key] = prev.watchlist[key];
        }
      }
      return next;
    });
  }, []);

  useLiveSyncEvent("library", (event) => {
    // Tant que la fusion initiale de cet appareil n'a pas eu lieu, le pull
    // d'authentification ci-dessus s'en charge déjà.
    if (!email || storageGet(SYNCED_FOR_KEY) !== email || syncingRef.current) {
      return;
    }
    const delta = event?.payload as RemoteLibraryDelta | undefined;
    if (delta && Array.isArray(delta.upserts) && Array.isArray(delta.deletes)) {
      setState((prev) => {
        const next: LibraryState = {
          watched: { ...prev.watched },
          watchlist: { ...prev.watchlist },
        };
        for (const d of delta.deletes) {
          const key = makeKey(d.mediaType, d.id);
          if (!pendingOpsRef.current.has(key)) {
            delete next.watched[key];
            delete next.watchlist[key];
          }
        }
        for (const u of delta.upserts) {
          const key = makeKey(u.mediaType, u.tmdbId);
          if (pendingOpsRef.current.has(key)) {
            continue;
          }
          // Un titre n'a qu'un statut à la fois côté serveur (voir
          // library_items) : "vu" le retire de "envie de voir" et inversement.
          delete next.watched[key];
          delete next.watchlist[key];
          next[u.status][key] = u.item;
        }
        return next;
      });
      return;
    }
    fetch("/api/library")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("refresh failed"))))
      .then((remote: LibraryState) => applyRemoteLibrary(remote))
      .catch((err) => logWarn("Seancy : actualisation de la bibliothèque impossible.", err));
  });

  // Listes perso : pas de delta (chaque liste est remplacée en entier côté
  // serveur, voir upsertCustomListForUser), on recharge toutes les listes —
  // sauf changement local pas encore envoyé (pendingCustomListOpsRef non
  // vide), qui partira au prochain push et fera foi (dernier écrit gagne,
  // comme avant la synchro temps réel).
  useLiveSyncEvent("custom-lists", () => {
    if (!customListsSyncSettledRef.current || pendingCustomListOpsRef.current.size > 0) {
      return;
    }
    fetch("/api/custom-lists")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("refresh failed"))))
      .then((remote: CustomListMap) => {
        if (pendingCustomListOpsRef.current.size > 0) {
          return; // modifié localement pendant la requête : le local l'emporte
        }
        setCustomLists(remote || {});
      })
      .catch((err) => logWarn("Seancy : actualisation des listes personnalisées impossible.", err));
  });

  const toggleWatched = useCallback((item: LibraryItemInput, watchedAt?: number) => {
    const key = makeKey(item.mediaType, item.id);
    setState((prev) => {
      const next = { ...prev, watched: { ...prev.watched } };
      if (next.watched[key]) {
        delete next.watched[key];
        pendingOpsRef.current.set(key, {
          action: "delete",
          mediaType: item.mediaType,
          id: item.id,
        });
      } else {
        // On repasse "vu" un titre déjà présent dans la liste à voir : on
        // conserve la note/réalisateurs/épisodes déjà connus plutôt que de
        // repartir d'un item vierge (cf. bug #14 : la note disparaissait
        // silencieusement lors d'un aller-retour Vu ↔ Envie de voir).
        const existing = next.watchlist[key];
        const newItem: LibraryItem = {
          ...existing,
          ...item,
          addedAt: existing?.addedAt ?? Date.now(),
          updatedAt: Date.now(),
          // Par défaut "vu aujourd'hui" (comportement inchangé) ; l'appelant peut
          // préciser une date passée (cf. DetailPage, sélecteur de date de visionnage).
          watchedAt: watchedAt ?? Date.now(),
        };
        next.watched[key] = newItem;
        // Un film vu n'a plus besoin d'être dans la liste à voir.
        if (next.watchlist[key]) {
          next.watchlist = { ...next.watchlist };
          delete next.watchlist[key];
        }
        pendingOpsRef.current.set(key, {
          action: "upsert",
          mediaType: item.mediaType,
          id: item.id,
          status: "watched",
          item: newItem,
        });
      }
      return next;
    });
    setWatchlistOrder((prev) => prev.filter((k) => k !== key));
  }, []);

  const toggleWatchlist = useCallback((item: LibraryItemInput) => {
    const key = makeKey(item.mediaType, item.id);
    let added = false;
    setState((prev) => {
      const next = { ...prev, watchlist: { ...prev.watchlist } };
      if (next.watchlist[key]) {
        delete next.watchlist[key];
        pendingOpsRef.current.set(key, {
          action: "delete",
          mediaType: item.mediaType,
          id: item.id,
        });
      } else {
        added = true;
        // Symétrique à toggleWatched : on conserve la note/réalisateurs déjà
        // connus si le titre était marqué "vu", et on le retire de "vu"
        // puisqu'un titre ne doit être que dans une seule des deux listes.
        const existing = next.watched[key];
        const newItem: LibraryItem = {
          ...existing,
          ...item,
          addedAt: existing?.addedAt ?? Date.now(),
          updatedAt: Date.now(),
        };
        next.watchlist[key] = newItem;
        // Un titre "envie de voir" ne doit pas rester marqué "vu" en
        // parallèle (les deux listes doivent rester mutuellement exclusives).
        if (next.watched[key]) {
          next.watched = { ...next.watched };
          delete next.watched[key];
        }
        pendingOpsRef.current.set(key, {
          action: "upsert",
          mediaType: item.mediaType,
          id: item.id,
          status: "watchlist",
          item: newItem,
        });
      }
      return next;
    });
    setWatchlistOrder((prev) =>
      added ? [key, ...prev.filter((k) => k !== key)] : prev.filter((k) => k !== key)
    );
  }, []);

  const isWatched = useCallback(
    (mediaType: MediaType, id: number | string) => Boolean(state.watched[makeKey(mediaType, id)]),
    [state.watched]
  );
  const isInWatchlist = useCallback(
    (mediaType: MediaType, id: number | string) => Boolean(state.watchlist[makeKey(mediaType, id)]),
    [state.watchlist]
  );
  const getRating = useCallback(
    (mediaType: MediaType, id: number | string) =>
      state.watched[makeKey(mediaType, id)]?.rating ?? null,
    [state.watched]
  );

  // Note sur 10, uniquement pour un titre déjà marqué comme vu.
  const rateWatched = useCallback(
    (mediaType: MediaType, id: number | string, rating: number | null) => {
      const key = makeKey(mediaType, id);
      setState((prev) => {
        if (!prev.watched[key]) {
          return prev;
        }
        const updated: LibraryItem = { ...prev.watched[key], rating, updatedAt: Date.now() };
        pendingOpsRef.current.set(key, {
          action: "upsert",
          mediaType,
          id: Number(id),
          status: "watched",
          item: updated,
        });
        return { ...prev, watched: { ...prev.watched, [key]: updated } };
      });
    },
    []
  );

  // Complète après coup la durée d'un titre déjà marqué vu (cf. Stats), pour
  // les cas où elle n'était pas connue au moment du toggle.
  const setRuntime = useCallback(
    (mediaType: MediaType, id: number | string, runtimeMinutes: number) => {
      const key = makeKey(mediaType, id);
      setState((prev) => {
        if (!prev.watched[key] || prev.watched[key].runtimeMinutes != null) {
          return prev;
        }
        const updated: LibraryItem = {
          ...prev.watched[key],
          runtimeMinutes,
          updatedAt: Date.now(),
        };
        pendingOpsRef.current.set(key, {
          action: "upsert",
          mediaType,
          id: Number(id),
          status: "watched",
          item: updated,
        });
        return { ...prev, watched: { ...prev.watched, [key]: updated } };
      });
    },
    []
  );

  // Complète après coup le·s réalisateur·rice·s/créateur·rice·s d'un titre
  // déjà marqué vu (cf. Stats, "réalisateurs récurrents"), pour les cas où
  // ce n'était pas connu au moment du toggle — remplissage progressif.
  const setDirectors = useCallback(
    (mediaType: MediaType, id: number | string, directors: DirectorRef[]) => {
      const key = makeKey(mediaType, id);
      setState((prev) => {
        if (!prev.watched[key] || prev.watched[key].directors?.length) {
          return prev;
        }
        const updated: LibraryItem = { ...prev.watched[key], directors, updatedAt: Date.now() };
        pendingOpsRef.current.set(key, {
          action: "upsert",
          mediaType,
          id: Number(id),
          status: "watched",
          item: updated,
        });
        return { ...prev, watched: { ...prev.watched, [key]: updated } };
      });
    },
    []
  );

  // Suivi épisode par épisode (séries uniquement). L'entrée du titre est
  // cherchée dans watched puis watchlist (voir findShowEntry) ; si aucune
  // des deux n'existe encore (rien coché sur la fiche), on en crée une dans
  // watchlist — cocher un épisode revient à dire "je suis en train de
  // regarder ça", ce qui est plus proche d'"envie de voir" que de "déjà vu"
  // pour la série entière.
  const getWatchedEpisodes = useCallback(
    (mediaType: MediaType, id: number | string) =>
      new Set(findShowEntry(state, mediaType, id)?.watchedEpisodes || []),
    [state]
  );

  const isEpisodeWatched = useCallback(
    (mediaType: MediaType, id: number | string, season: number, episode: number) =>
      Boolean(
        findShowEntry(state, mediaType, id)?.watchedEpisodes?.includes(
          makeEpisodeKey(season, episode)
        )
      ),
    [state]
  );

  const toggleEpisodeWatched = useCallback(
    (item: LibraryItemInput, season: number, episode: number) => {
      const key = makeKey(item.mediaType, item.id);
      const epKey = makeEpisodeKey(season, episode);
      setState((prev) => {
        const listName: "watched" | "watchlist" = prev.watched[key] ? "watched" : "watchlist";
        const existing: LibraryItem = prev[listName][key] || {
          ...item,
          addedAt: Date.now(),
          updatedAt: Date.now(),
        };
        const nextEpisodes = new Set(existing.watchedEpisodes || []);
        if (nextEpisodes.has(epKey)) {
          nextEpisodes.delete(epKey);
        } else {
          nextEpisodes.add(epKey);
        }
        const updated: LibraryItem = {
          ...existing,
          watchedEpisodes: Array.from(nextEpisodes),
          updatedAt: Date.now(),
        };
        pendingOpsRef.current.set(key, {
          action: "upsert",
          mediaType: item.mediaType,
          id: item.id,
          status: listName,
          item: updated,
        });
        return { ...prev, [listName]: { ...prev[listName], [key]: updated } };
      });
    },
    []
  );

  // Coche/décoche plusieurs épisodes d'un coup (saison entière, « Vu
  // jusqu'ici »), sans changer le statut de la série.
  const setEpisodesWatched = useCallback(
    (item: LibraryItemInput, episodes: EpisodeRef[], watched: boolean, watchedAt?: number) => {
      const key = makeKey(item.mediaType, item.id);
      setState((prev) => {
        const listName: "watched" | "watchlist" = prev.watched[key] ? "watched" : "watchlist";
        const existing: LibraryItem = prev[listName][key] || {
          ...item,
          addedAt: Date.now(),
          updatedAt: Date.now(),
        };
        const nextEpisodes = new Set(existing.watchedEpisodes || []);
        for (const { seasonNumber, episodeNumber } of episodes) {
          const epKey = makeEpisodeKey(seasonNumber, episodeNumber);
          if (watched) {
            nextEpisodes.add(epKey);
          } else {
            nextEpisodes.delete(epKey);
          }
        }
        const updated: LibraryItem = {
          ...existing,
          watchedEpisodes: Array.from(nextEpisodes),
          updatedAt: Date.now(),
          // Comme toggleWatched/markSeriesWatched : par défaut "maintenant",
          // sauf date de visionnage passée choisie via le sélecteur (bouton
          // calendrier de la saison). Inchangé quand on décoche.
          ...(watched ? { watchedAt: watchedAt ?? Date.now() } : {}),
        };
        pendingOpsRef.current.set(key, {
          action: "upsert",
          mediaType: item.mediaType,
          id: item.id,
          status: listName,
          item: updated,
        });
        return { ...prev, [listName]: { ...prev[listName], [key]: updated } };
      });
    },
    []
  );

  // « Marquer la série comme vue » : comme toggleWatched (passage en "vu",
  // retrait de la liste à voir), en cochant en plus tous les épisodes
  // diffusés — la série disparaît ainsi aussi de « Séries en cours ».
  const markSeriesWatched = useCallback(
    (item: LibraryItemInput, episodes: EpisodeRef[], watchedAt?: number) => {
      const key = makeKey(item.mediaType, item.id);
      setState((prev) => {
        const existing = prev.watched[key] || prev.watchlist[key];
        const nextEpisodes = new Set(existing?.watchedEpisodes || []);
        for (const { seasonNumber, episodeNumber } of episodes) {
          nextEpisodes.add(makeEpisodeKey(seasonNumber, episodeNumber));
        }
        const newItem: LibraryItem = {
          ...existing,
          ...item,
          watchedEpisodes: Array.from(nextEpisodes),
          addedAt: existing?.addedAt ?? Date.now(),
          updatedAt: Date.now(),
          watchedAt: watchedAt ?? Date.now(),
        };
        const next = { ...prev, watched: { ...prev.watched, [key]: newItem } };
        if (next.watchlist[key]) {
          next.watchlist = { ...next.watchlist };
          delete next.watchlist[key];
        }
        pendingOpsRef.current.set(key, {
          action: "upsert",
          mediaType: item.mediaType,
          id: item.id,
          status: "watched",
          item: newItem,
        });
        return next;
      });
      setWatchlistOrder((prev) => prev.filter((k) => k !== key));
    },
    []
  );

  // Glisser-déposer dans "Envie de voir" : déplace `fromKey` juste avant ou
  // après `toKey` dans l'ordre manuel affiché.
  const reorderWatchlist = useCallback((fromKey: string, toKey: string, insertAfter: boolean) => {
    setWatchlistOrder((prev) => {
      const base = prev.includes(fromKey) ? prev : [fromKey, ...prev];
      const withoutFrom = base.filter((k) => k !== fromKey);
      let targetIndex = withoutFrom.indexOf(toKey);
      if (targetIndex < 0) {
        targetIndex = withoutFrom.length;
      }
      const insertAt = insertAfter ? targetIndex + 1 : targetIndex;
      const next = [...withoutFrom];
      next.splice(insertAt, 0, fromKey);
      return next;
    });
  }, []);

  // Listes personnalisées ------------------------------------------------

  const createList = useCallback(
    (name: string): string | null => {
      const trimmed = name.trim();
      if (!trimmed) {
        return null;
      }
      const id = makeListId();
      setCustomLists((prev) => ({
        ...prev,
        [id]: { id, name: trimmed, items: [], createdAt: Date.now() },
      }));
      markCustomListDirty(id, "upsert");
      return id;
    },
    [markCustomListDirty]
  );

  const renameList = useCallback(
    (listId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        return;
      }
      setCustomLists((prev) =>
        prev[listId] ? { ...prev, [listId]: { ...prev[listId], name: trimmed } } : prev
      );
      markCustomListDirty(listId, "upsert");
    },
    [markCustomListDirty]
  );

  const deleteList = useCallback(
    (listId: string) => {
      setCustomLists((prev) => {
        if (!prev[listId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[listId];
        return next;
      });
      markCustomListDirty(listId, "delete");
    },
    [markCustomListDirty]
  );

  // Stocke l'item complet directement dans la liste perso (pas juste sa
  // clé) : contrairement à "vu"/"envie de voir", une liste perso doit rester
  // utilisable pour un titre qui n'est dans aucune des deux (cf. bug #32 —
  // "Ajouter à…" n'implique ni "vu" ni "envie de voir").
  const addToList = useCallback(
    (listId: string, item: LibraryItemInput) => {
      const key = makeKey(item.mediaType, item.id);
      setCustomLists((prev) => {
        const list = prev[listId];
        if (
          !list ||
          list.items.some((existing) => makeKey(existing.mediaType, existing.id) === key)
        ) {
          return prev;
        }
        const newItem: LibraryItem = { ...item, addedAt: Date.now(), updatedAt: Date.now() };
        return { ...prev, [listId]: { ...list, items: [...list.items, newItem] } };
      });
      markCustomListDirty(listId, "upsert");
    },
    [markCustomListDirty]
  );

  const removeFromList = useCallback(
    (listId: string, mediaType: MediaType, id: number | string) => {
      const key = makeKey(mediaType, id);
      setCustomLists((prev) => {
        const list = prev[listId];
        if (!list) {
          return prev;
        }
        return {
          ...prev,
          [listId]: {
            ...list,
            items: list.items.filter((item) => makeKey(item.mediaType, item.id) !== key),
          },
        };
      });
      markCustomListDirty(listId, "upsert");
    },
    [markCustomListDirty]
  );

  const isInList = useCallback(
    (listId: string, mediaType: MediaType, id: number | string) => {
      const key = makeKey(mediaType, id);
      return Boolean(
        customLists[listId]?.items.some((item) => makeKey(item.mediaType, item.id) === key)
      );
    },
    [customLists]
  );

  const getListItems = useCallback(
    (listId: string): LibraryItem[] => customLists[listId]?.items || [],
    [customLists]
  );

  // Glisser-déposer dans une liste perso : déplace `fromKey` juste avant ou
  // après `toKey`. L'ordre du tableau `items` porte directement le tri
  // manuel (pas besoin d'un artefact d'ordre séparé comme pour "Envie de
  // voir", qui doit lui composer avec une fusion serveur).
  const reorderList = useCallback(
    (listId: string, fromKey: string, toKey: string, insertAfter: boolean) => {
      setCustomLists((prev) => {
        const list = prev[listId];
        if (!list) {
          return prev;
        }
        const fromIndex = list.items.findIndex(
          (item) => makeKey(item.mediaType, item.id) === fromKey
        );
        if (fromIndex < 0) {
          return prev;
        }
        const withoutFrom = list.items.filter((_, i) => i !== fromIndex);
        let targetIndex = withoutFrom.findIndex(
          (item) => makeKey(item.mediaType, item.id) === toKey
        );
        if (targetIndex < 0) {
          targetIndex = withoutFrom.length;
        }
        const insertAt = insertAfter ? targetIndex + 1 : targetIndex;
        const nextItems = [...withoutFrom];
        nextItems.splice(insertAt, 0, list.items[fromIndex]);
        return { ...prev, [listId]: { ...list, items: nextItems } };
      });
      markCustomListDirty(listId, "upsert");
    },
    [markCustomListDirty]
  );

  const customListsArray = useMemo(
    () => Object.values(customLists).sort((a, b) => a.createdAt - b.createdAt),
    [customLists]
  );

  const orderedWatchlist = useMemo(() => {
    const items = Object.values(state.watchlist);
    const orderIndex = new Map(watchlistOrder.map((key, i) => [key, i]));
    return items.slice().sort((a, b) => {
      const keyA = makeKey(a.mediaType, a.id);
      const keyB = makeKey(b.mediaType, b.id);
      const ia = orderIndex.has(keyA) ? orderIndex.get(keyA)! : Number.MAX_SAFE_INTEGER;
      const ib = orderIndex.has(keyB) ? orderIndex.get(keyB)! : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) {
        return ia - ib;
      }
      // Repli pour deux items jamais présents dans l'ordre manuel (ex.
      // fusion serveur) : les plus récemment ajoutés d'abord.
      return b.addedAt - a.addedAt;
    });
  }, [state.watchlist, watchlistOrder]);

  // Toute action utilisateur qui écrit dans la bibliothèque est réservée
  // aux membres connectés : pour un visiteur anonyme, elle ouvre la modale
  // de connexion au lieu de s'exécuter (voir MembersOnlyContext). Gardé ici
  // plutôt qu'à chaque bouton pour ne jamais oublier un point d'entrée.
  // setRuntime/setDirectors restent libres : ce sont des compléments de
  // métadonnées déclenchés automatiquement, pas des actions de l'utilisateur.
  const gated = useCallback(
    <A extends unknown[], R>(fn: (...args: A) => R, blocked: R) =>
      (...args: A): R =>
        requireMember() ? fn(...args) : blocked,
    [requireMember]
  );

  const actions = useMemo<LibraryActionsContextValue>(
    () => ({
      toggleWatched: gated(toggleWatched, undefined),
      toggleWatchlist: gated(toggleWatchlist, undefined),
    }),
    [gated, toggleWatched, toggleWatchlist]
  );

  const value = useMemo<LibraryContextValue>(() => {
    return {
      watched: Object.values(state.watched).sort((a, b) => b.addedAt - a.addedAt),
      watchlist: orderedWatchlist,
      watchedIds: new Set(Object.keys(state.watched)),
      toggleWatched: actions.toggleWatched,
      toggleWatchlist: actions.toggleWatchlist,
      isWatched,
      isInWatchlist,
      getRating,
      rateWatched: gated(rateWatched, undefined),
      setRuntime,
      setDirectors,
      getWatchedEpisodes,
      isEpisodeWatched,
      toggleEpisodeWatched: gated(toggleEpisodeWatched, undefined),
      setEpisodesWatched: gated(setEpisodesWatched, undefined),
      markSeriesWatched: gated(markSeriesWatched, undefined),
      reorderWatchlist: gated(reorderWatchlist, undefined),
      customLists: customListsArray,
      createList: gated(createList, null),
      renameList: gated(renameList, undefined),
      deleteList: gated(deleteList, undefined),
      addToList: gated(addToList, undefined),
      removeFromList: gated(removeFromList, undefined),
      isInList,
      getListItems,
      reorderList: gated(reorderList, undefined),
    };
  }, [
    gated,
    actions,
    state,
    orderedWatchlist,
    isWatched,
    isInWatchlist,
    getRating,
    rateWatched,
    setRuntime,
    setDirectors,
    getWatchedEpisodes,
    isEpisodeWatched,
    toggleEpisodeWatched,
    setEpisodesWatched,
    markSeriesWatched,
    reorderWatchlist,
    customListsArray,
    createList,
    renameList,
    deleteList,
    addToList,
    removeFromList,
    isInList,
    getListItems,
    reorderList,
  ]);

  return (
    <LibraryActionsContext.Provider value={actions}>
      <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
    </LibraryActionsContext.Provider>
  );
}

export function useLibraryActions(): LibraryActionsContextValue {
  const ctx = useContext(LibraryActionsContext);
  if (!ctx) {
    throw new Error("useLibraryActions doit être utilisé dans un LibraryProvider");
  }
  return ctx;
}

export function useLibrary(): LibraryContextValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) {
    throw new Error("useLibrary doit être utilisé dans un LibraryProvider");
  }
  return ctx;
}

export { makeKey };
