import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useLibrary } from "../../core/context/LibraryContext.tsx";
import { useAuth } from "../../core/context/AuthContext.tsx";
import { ContinueWatchingRow, EmptyState, Icon } from "../../shared/components/index.ts";
import { useResumableSeries } from "../../shared/hooks/useResumableSeries.ts";
import StatsPanel from "./components/StatsPanel.tsx";
import WatchlistPanel from "./components/WatchlistPanel.tsx";
import CustomListPanel from "./components/CustomListPanel.tsx";
import TopPicksPanel from "./components/TopPicksPanel.tsx";
import type { CustomList } from "../../core/types/library.ts";
import styles from "./MyListPage.module.css";

type Tab = "seen" | "want" | "progress" | string; // string = id de liste personnalisée
const FIXED_TABS: Tab[] = ["seen", "want", "progress"];
// Une liste commune (ownerId défini) a besoin d'un id d'onglet composite
// (voir allLists ci-dessous) : l'id de liste seul n'est unique que par compte.
type ListTab = CustomList & { tabId?: string };

export default function MyListContent() {
  const { t } = useTranslation();
  const { watched, watchlist, customLists, sharedLists, createList } = useLibrary();
  const { status: authStatus } = useAuth();
  // Listes perso ("miennes") et listes communes dont je suis seulement
  // membre (ticket "Ma liste commune") partagent les mêmes onglets, mais pas
  // le même id d'onglet : un id de liste seul n'est unique que par compte,
  // donc une liste commune utilise une clé composite (voir sharedListTabId)
  // pour ne jamais entrer en collision avec une de mes propres listes.
  const sharedListTabId = (listId: string, ownerId: number) => `shared:${ownerId}:${listId}`;
  const allLists: ListTab[] = [
    ...customLists,
    ...sharedLists.map((l) => ({ ...l, tabId: sharedListTabId(l.id, l.ownerId!) })),
  ];
  // Chaque liste perso a sa propre URL (/profil?tab=ma-liste&liste=<id>) :
  // c'est aussi là qu'est renvoyé le propriétaire qui ouvre le lien public de
  // sa propre liste (voir SharedListPage). Les onglets fixes gardent un état
  // local, sans paramètre.
  const [searchParams, setSearchParams] = useSearchParams();
  const [localTab, setLocalTab] = useState<Tab>("seen");
  const requestedList = searchParams.get("liste");
  const tab: Tab =
    requestedList && allLists.some((l) => (l.tabId ?? l.id) === requestedList)
      ? requestedList
      : localTab;

  function setTab(next: Tab) {
    setLocalTab(next);
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (!FIXED_TABS.includes(next)) {
          params.set("liste", next);
        } else {
          params.delete("liste");
        }
        return params;
      },
      { replace: true }
    );
  }
  // Listes partagées (id de liste → slug du lien public) : icône de lien sur
  // l'onglet et statut dans l'en-tête de la liste.
  const [shares, setShares] = useState<Record<string, string>>({});
  useEffect(() => {
    if (authStatus !== "authenticated") {
      setShares({});
      return;
    }
    let cancelled = false;
    fetch("/api/list-shares")
      .then((res): Promise<Record<string, string>> | Record<string, string> =>
        res.ok ? res.json() : {}
      )
      .then((data) => {
        if (!cancelled) {
          setShares(data);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [authStatus]);

  function setShare(listId: string, slug: string | null) {
    setShares((prev) => {
      const next = { ...prev };
      if (slug) {
        next[listId] = slug;
      } else {
        delete next[listId];
      }
      return next;
    });
  }

  const [creating, setCreating] = useState(false);
  const [newListName, setNewListName] = useState("");

  const continuingSeries = useResumableSeries(watchlist);
  const activeCustomList = allLists.find((l) => (l.tabId ?? l.id) === tab);

  // Onglets dans l'ordre d'affichage, pour la navigation au clavier.
  const tabIds: Tab[] = ["want", "seen", "progress", ...allLists.map((l) => l.tabId ?? l.id)];
  const idPrefix = useId();
  const tabDomId = (id: Tab) => `${idPrefix}-tab-${id}`;
  const panelDomId = `${idPrefix}-panel`;
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());

  // Flèches ←/→ (et Début/Fin) : onglet voisin, sélectionné et focalisé
  // (modèle « tablist » WAI-ARIA, comme ProfilePage).
  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, current: Tab) {
    const index = tabIds.indexOf(current);
    const next =
      e.key === "ArrowRight"
        ? tabIds[(index + 1) % tabIds.length]
        : e.key === "ArrowLeft"
          ? tabIds[(index - 1 + tabIds.length) % tabIds.length]
          : e.key === "Home"
            ? tabIds[0]
            : e.key === "End"
              ? tabIds[tabIds.length - 1]
              : null;
    if (!next) {
      return;
    }
    e.preventDefault();
    setTab(next);
    tabRefs.current.get(next)?.focus();
  }

  function tabProps(id: Tab) {
    return {
      ref: (el: HTMLButtonElement | null) => {
        if (el) {
          tabRefs.current.set(id, el);
        } else {
          tabRefs.current.delete(id);
        }
      },
      type: "button" as const,
      role: "tab",
      id: tabDomId(id),
      "aria-selected": tab === id,
      "aria-controls": panelDomId,
      tabIndex: tab === id ? 0 : -1,
      className: `${styles.tab} ${tab === id ? styles.tabActive : ""}`,
      onClick: () => setTab(id),
      onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => onTabKeyDown(e, id),
    };
  }

  function submitNewList() {
    const id = createList(newListName);
    if (id) {
      setNewListName("");
      setCreating(false);
      setTab(id);
    }
  }

  return (
    <div>
      {/* Pas pendant "loading" : la bannière clignoterait à chaque
          rechargement pour un membre connecté. */}
      {authStatus === "anonymous" && (
        <div className={styles.authBanner}>
          <p className={styles.authBannerText}>{t("myListPage.authBannerText")}</p>
          <Link to="/connexion" className={styles.loginBtn}>
            {t("myListPage.login")}
          </Link>
        </div>
      )}

      {/* Top 5 du profil partagé : enregistré sur le compte, donc connecté uniquement. */}
      {authStatus === "authenticated" && (
        <>
          <TopPicksPanel />
          <hr className={styles.divider} />
        </>
      )}

      {/* Onglets fixes puis listes perso, sur une seule ligne (défilement
          horizontal sur mobile). */}
      <div className={styles.tabs}>
        {/* Le bouton « Nouvelle liste » n'est pas un onglet : il reste hors
            du tablist, sur la même ligne. */}
        <div className={styles.tabList} role="tablist" aria-label={t("myListPage.tabsLabel")}>
          <button {...tabProps("want")}>
            {t("myListPage.tabWant")} <span className={styles.count}>{watchlist.length}</span>
          </button>
          <button {...tabProps("seen")}>
            {t("myListPage.tabSeen")} <span className={styles.count}>{watched.length}</span>
          </button>
          <button {...tabProps("progress")}>
            {t("myListPage.tabProgress")}{" "}
            <span className={styles.count}>{continuingSeries.length}</span>
          </button>
          {allLists.map((list) => {
            const id = list.tabId ?? list.id;
            return (
              <button key={id} {...tabProps(id)}>
                {list.ownerId !== undefined ? (
                  <Icon name="users" className={styles.sharedIcon} />
                ) : (
                  shares[list.id] && <Icon name="link" className={styles.sharedIcon} />
                )}
                {list.name} <span className={styles.count}>{list.items.length}</span>
                {(list.ownerId !== undefined || shares[list.id]) && (
                  <span className={styles.srOnly}>{t("myListPage.sharedTab")}</span>
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={styles.newTab}
          aria-expanded={creating}
          onClick={() => setCreating((v) => !v)}
        >
          {t("myListPage.newListTab")}
        </button>
      </div>

      {creating && (
        <form
          className={styles.newListForm}
          onSubmit={(e) => {
            e.preventDefault();
            submitNewList();
          }}
        >
          <input
            type="text"
            aria-label={t("myListPage.newListLabel")}
            placeholder={t("myListPage.newListPlaceholder")}
            maxLength={40}
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            autoFocus
          />
          <button type="submit">{t("myListPage.create")}</button>
          <button type="button" onClick={() => setCreating(false)}>
            {t("myListPage.cancel")}
          </button>
        </form>
      )}

      <div id={panelDomId} role="tabpanel" aria-labelledby={tabDomId(tab)}>
        {tab === "seen" &&
          (watched.length === 0 ? (
            <EmptyState label={t("myListPage.emptySeen")} />
          ) : (
            <StatsPanel watched={watched} />
          ))}

        {tab === "want" && <WatchlistPanel items={watchlist} />}

        {tab === "progress" &&
          (continuingSeries.length === 0 ? (
            <EmptyState label={t("myListPage.emptyProgress")} />
          ) : (
            <ContinueWatchingRow items={continuingSeries} />
          ))}

        {activeCustomList && (
          <CustomListPanel
            list={activeCustomList}
            onDeleted={() => setTab("want")}
            canShare={authStatus === "authenticated" && activeCustomList.ownerId === undefined}
            shareSlug={shares[activeCustomList.id] ?? null}
            onShareChange={(slug) => setShare(activeCustomList.id, slug)}
          />
        )}
      </div>
    </div>
  );
}
