import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useLibrary } from "../../../core/context/LibraryContext.tsx";
import {
  MediaCard,
  Dropdown,
  EmptyState,
  Icon,
  ListCover,
} from "../../../shared/components/index.ts";
import dropdownStyles from "../../../shared/components/Dropdown/Dropdown.module.css";
import { libraryItemToMediaItem } from "../../../shared/lib/libraryItem.ts";
import { posterUrl, formatFullDate } from "../../../core/api/tmdb.ts";
import { useLocale } from "../../../core/context/LocaleContext.tsx";
import { posterAccentFromGenres } from "../../../shared/lib/posterAccent.ts";
import posterStyles from "../../../shared/styles/posterAccents.module.css";
import { neighborOf, useSortable } from "../../../shared/hooks/useSortable.ts";
import gridStyles from "../../../shared/styles/mediaGrid.module.css";
import type { CustomList, LibraryItem } from "../../../core/types/library.ts";
import { getListMembers, memberLabel, type ListMember } from "../../../core/api/listMembers.ts";
import ListShareDialog from "./ListShareDialog.tsx";
import ListMembersDialog from "./ListMembersDialog.tsx";
import styles from "./CustomListPanel.module.css";

interface CustomListPanelProps {
  list: CustomList;
  onDeleted: () => void;
  /** Partage géré seulement pour un membre connecté (sinon `canShare` à false). */
  canShare: boolean;
  /** Slug du lien public, null si la liste n'est pas partagée. */
  shareSlug: string | null;
  onShareChange: (slug: string | null) => void;
}

type SortMode = "manual" | "title" | "year";
const SORTS: Array<{ id: SortMode; labelKey: string }> = [
  { id: "manual", labelKey: "customListPanel.sortManual" },
  { id: "title", labelKey: "customListPanel.sortTitle" },
  { id: "year", labelKey: "customListPanel.sortYear" },
];

type ViewMode = "grid" | "list";

function makeKey(item: LibraryItem): string {
  return `${item.mediaType}:${item.id}`;
}

export default function CustomListPanel({
  list,
  onDeleted,
  canShare,
  shareSlug,
  onShareChange,
}: CustomListPanelProps) {
  const { t } = useTranslation();
  const { getListItems, deleteList, renameList, reorderList, leaveSharedList, getRating } =
    useLibrary();
  const [shareOpen, setShareOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const { locale } = useLocale();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(list.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("manual");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const items = getListItems(list.id, list.ownerId);
  const ratedCount = items.filter((item) => getRating(item.mediaType, item.id) != null).length;

  // Badge "liste commune" (icône + survol = noms des membres) : chargé pour
  // CETTE liste seule (un seul panneau de liste affiché à la fois), pas
  // juste quand on est membre (déjà visible côté serveur via list.ownerId) —
  // aussi quand on est propriétaire d'une liste qu'on a partagée, cas qui
  // n'avait aucun indicateur avant ce ticket. Rechargé à la fermeture du
  // dialogue (ajout/retrait d'un membre) pour rester à jour.
  const [members, setMembers] = useState<ListMember[]>([]);
  useEffect(() => {
    let cancelled = false;
    getListMembers(list.id, list.ownerId)
      .then(({ members: data }) => !cancelled && setMembers(data))
      .catch(() => !cancelled && setMembers([]));
    return () => {
      cancelled = true;
    };
  }, [list.id, list.ownerId, membersOpen]);
  const isCommon = list.ownerId !== undefined || members.length > 0;

  function handleDelete() {
    deleteList(list.id, list.ownerId);
    onDeleted();
  }

  function handleLeave() {
    if (list.ownerId !== undefined) {
      leaveSharedList(list.id, list.ownerId);
    }
    onDeleted();
  }

  function submitRename() {
    renameList(list.id, renameValue, list.ownerId);
    setRenaming(false);
  }

  const manual = sortMode === "manual";
  const canSort = manual && items.length > 1;
  const byKey = new Map(items.map((item) => [makeKey(item), item]));
  const sortable = useSortable({
    keys: items.map(makeKey),
    enabled: canSort,
    onReorder: (next, moved) => {
      const { toKey, after } = neighborOf(next, moved);
      reorderList(list.id, moved, toKey, after, list.ownerId);
    },
  });
  const sorted =
    sortMode === "title"
      ? [...items].sort((a, b) => a.title.localeCompare(b.title, "fr"))
      : sortMode === "year"
        ? [...items].sort((a, b) => (b.date || "").localeCompare(a.date || ""))
        : sortable.order.map((key) => byKey.get(key)!);

  // Glisser à la souris sur tout l'élément, au doigt depuis la poignée ⋮⋮.
  function sortItemProps(item: LibraryItem, className = "") {
    const key = makeKey(item);
    return {
      key,
      ...(canSort ? sortable.itemProps(key) : {}),
      className: `${styles.sortItem} ${className} ${canSort ? styles.draggable : ""} ${
        sortable.dragKey === key ? styles.dragging : ""
      }`,
    };
  }
  const dragHandle = canSort && (
    <span className={styles.dragHandle} data-drag-handle aria-hidden>
      <Icon name="dragHandle" />
    </span>
  );

  return (
    <div>
      <div className={styles.header}>
        {/* Couverture en éventail : les 3 premières affiches de la liste. */}
        <ListCover items={items} />

        <div className={styles.headerBody}>
          {renaming ? (
            <form
              className={styles.renameForm}
              onSubmit={(e) => {
                e.preventDefault();
                submitRename();
              }}
            >
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                maxLength={40}
                aria-label={t("customListPanel.renameLabel")}
                autoFocus
              />
              <button type="submit">{t("customListPanel.rename")}</button>
              <button type="button" onClick={() => setRenaming(false)}>
                {t("customListPanel.cancel")}
              </button>
            </form>
          ) : (
            <h2 className={styles.listName}>{list.name}</h2>
          )}
          <p className={styles.listMeta}>
            {t("customListPanel.itemsCount", { count: items.length })} ·{" "}
            {t("customListPanel.ratedCount", { count: ratedCount })}
          </p>
          {canShare && (
            <span className={`${styles.status} ${shareSlug ? styles.statusShared : ""}`}>
              <Icon name={shareSlug ? "link" : "lock"} />
              {t(shareSlug ? "customListPanel.statusShared" : "customListPanel.statusPrivate")}
            </span>
          )}
          {isCommon && (
            <span
              className={`${styles.status} ${styles.statusShared} ${styles.commonBadge}`}
              tabIndex={0}
            >
              <Icon name="users" />
              {t("customListPanel.statusCommon")}
              {members.length > 0 && (
                <span className={styles.commonTooltip} role="tooltip">
                  {members.map(memberLabel).join(", ")}
                </span>
              )}
            </span>
          )}
        </div>

        <div className={styles.headerActions}>
          {items.length > 0 && (
            <>
              <div
                className={styles.viewToggle}
                role="group"
                aria-label={t("customListPanel.viewModeAriaLabel")}
              >
                <button
                  type="button"
                  className={`${styles.viewBtn} ${viewMode === "grid" ? styles.viewBtnOn : ""}`}
                  aria-pressed={viewMode === "grid"}
                  title={t("customListPanel.gridViewTitle")}
                  onClick={() => setViewMode("grid")}
                >
                  <Icon name="grid" />
                </button>
                <button
                  type="button"
                  className={`${styles.viewBtn} ${viewMode === "list" ? styles.viewBtnOn : ""}`}
                  aria-pressed={viewMode === "list"}
                  title={t("customListPanel.listViewTitle")}
                  onClick={() => setViewMode("list")}
                >
                  <Icon name="grip" />
                </button>
              </div>
              <Dropdown
                label={
                  <>
                    {t("customListPanel.sortLabel")}&nbsp;:{" "}
                    {t(SORTS.find((s) => s.id === sortMode)?.labelKey ?? "")}
                  </>
                }
                align="right"
              >
                <div className={dropdownStyles.head}>{t("customListPanel.sortBy")}</div>
                {SORTS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`${dropdownStyles.option} ${sortMode === s.id ? dropdownStyles.optionOn : ""}`}
                    onClick={() => setSortMode(s.id)}
                  >
                    <span className={dropdownStyles.radio} /> {t(s.labelKey)}
                  </button>
                ))}
              </Dropdown>
            </>
          )}
          {canShare && (
            <button type="button" className={styles.shareBtn} onClick={() => setShareOpen(true)}>
              <Icon name="share" /> {t("customListPanel.share")}
            </button>
          )}
          <div className={styles.more}>
            <Dropdown
              label={<Icon name="more" size={18} />}
              ariaLabel={t("customListPanel.moreActions")}
              caret={false}
              closeOnSelect
              align="right"
            >
              <button
                type="button"
                className={dropdownStyles.option}
                onClick={() => {
                  setRenameValue(list.name);
                  setRenaming(true);
                }}
              >
                <Icon name="edit" /> {t("customListPanel.renameButton")}
              </button>
              <button
                type="button"
                className={dropdownStyles.option}
                onClick={() => setConfirmingDelete(true)}
              >
                <Icon name="trash" /> {t("customListPanel.deleteButton")}
              </button>
              <button
                type="button"
                className={dropdownStyles.option}
                onClick={() => setMembersOpen(true)}
              >
                <Icon name="users" /> {t("customListPanel.membersButton")}
              </button>
            </Dropdown>
          </div>
        </div>
      </div>

      {confirmingDelete && (
        <div className={styles.confirmDelete} role="alertdialog">
          <p>{t("customListPanel.confirmDelete", { name: list.name })}</p>
          <div className={styles.inline}>
            <button type="button" className={styles.confirmDeleteBtn} onClick={handleDelete}>
              {t("customListPanel.deleteButton")}
            </button>
            <button
              type="button"
              className={styles.confirmCancelBtn}
              onClick={() => setConfirmingDelete(false)}
            >
              {t("customListPanel.cancel")}
            </button>
          </div>
        </div>
      )}

      {canSort && <p className={styles.dragHint}>{t("customListPanel.dragHint")}</p>}

      {canShare && (
        <ListShareDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          listId={list.id}
          listName={list.name}
          slug={shareSlug}
          onSlugChange={onShareChange}
        />
      )}

      <ListMembersDialog
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        listId={list.id}
        listName={list.name}
        ownerId={list.ownerId}
        onLeft={handleLeave}
      />

      {items.length === 0 ? (
        <EmptyState label={t("customListPanel.emptyState", { name: list.name })} />
      ) : viewMode === "grid" ? (
        <div className={gridStyles.grid}>
          {sorted.map((item) => {
            const { key, ...props } = sortItemProps(item);
            return (
              <div key={key} {...props}>
                <MediaCard item={libraryItemToMediaItem(item)} />
                {dragHandle}
              </div>
            );
          })}
        </div>
      ) : (
        <div className={styles.rows}>
          {sorted.map((item) => {
            const { key, ...props } = sortItemProps(item, styles.row);
            const accentKey = posterAccentFromGenres(item.genreIds, key);
            return (
              <div key={key} {...props}>
                <Link to={`/media/${item.mediaType}/${item.id}`} className={styles.rowThumb}>
                  {item.posterPath ? (
                    <img
                      src={posterUrl(item.posterPath, "w92") ?? undefined}
                      alt={item.title}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <div
                      className={posterStyles[accentKey]}
                      style={{ width: "100%", height: "100%" }}
                    />
                  )}
                </Link>
                <Link to={`/media/${item.mediaType}/${item.id}`} className={styles.rowBody}>
                  <span className={styles.rowTitle}>{item.title}</span>
                  <span className={styles.rowSub}>
                    {item.mediaType === "movie"
                      ? t("navBar.mediaTypeMovie")
                      : t("navBar.mediaTypeSeries")}
                    {item.date
                      ? ` · ${formatFullDate(item.date, locale) || item.date.slice(0, 4)}`
                      : ""}
                  </span>
                </Link>
                {dragHandle}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
