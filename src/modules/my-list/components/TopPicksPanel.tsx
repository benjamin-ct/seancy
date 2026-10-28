import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useLibrary } from "../../../core/context/LibraryContext.tsx";
import { useAuth } from "../../../core/context/AuthContext.tsx";
import { posterUrl } from "../../../core/api/tmdbClient.ts";
import type { LibraryItem } from "../../../core/types/library.ts";
import type { MediaType } from "../../../core/types/tmdb.ts";
import { Icon } from "../../../shared/components/index.ts";
import { posterAccentFromGenres } from "../../../shared/lib/posterAccent.ts";
import { moveKey, useSortable } from "../../../shared/hooks/useSortable.ts";
import posterStyles from "../../../shared/styles/posterAccents.module.css";
import { storageGetJSON, storageSetJSON } from "../../../shared/lib/storage.ts";
import styles from "./TopPicksPanel.module.css";

const MAX_PICKS = 5;

const keyOf = (item: { mediaType: string; id: number }) => `${item.mediaType}:${item.id}`;

const RANK_CLASS = ["rank1", "rank2", "rank3", "rankOutline", "rankOutline"] as const;

// Dernier top connu, gardé sur l'appareil : le panneau s'affiche tout de suite
// au lieu d'apparaître après la requête et de décaler toute la page. Effacé à
// la déconnexion (voir core/lib/accountStorage.ts).
const CACHE_KEY = "seancy.topPicks.v1";

function readCachedPicks(): string[] | null {
  const value = storageGetJSON<unknown>(CACHE_KEY, null);
  return Array.isArray(value) ? value.filter((key) => typeof key === "string") : null;
}

function cachePicks(picks: string[]) {
  storageSetJSON(CACHE_KEY, picks);
}

// Top 5 du profil partagé choisi à la main parmi ses titres vus (seuls les
// titres vus peuvent être notés, donc « vus ou notés » = vus). Sans choix, la
// page publique garde le calcul automatique (titres vus les mieux notés).
// Chaque modification est enregistrée tout de suite (PUT
// /api/account/top-picks) : le top suit donc le compte sur tous les appareils.
//
// Desktop : bandeau de 5 affiches précédées de grands chiffres. Mobile (sous
// 860px) : liste verticale avec une poignée par ligne. Même DOM pour les deux,
// seule la mise en page change (TopPicksPanel.module.css).
//
// Ordre par glisser-déposer (useSortable : souris sur toute l'affiche, doigt
// depuis la poignée, les autres titres se décalent en direct). Au clavier, les
// flèches déplacent le titre dont la poignée a le focus.
export default function TopPicksPanel() {
  const { t } = useTranslation();
  const { watched } = useLibrary();
  const { shareSlug, username } = useAuth();
  const [picks, setPicks] = useState<string[] | null>(readCachedPicks);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account/top-picks")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error())))
      .then((data: { topPicks?: string[] }) => {
        if (!cancelled) {
          setPicks(data.topPicks ?? []);
          cachePicks(data.topPicks ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPicks((current) => current ?? []);
          setError(t("topPicks.loadError"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  // Après un déplacement au clavier, le focus suit le titre déplacé (sur la
  // poignée visible : « Glisser » sur desktop, ⋮⋮ sur mobile).
  useEffect(() => {
    if (focusKey) {
      const handles = panelRef.current?.querySelectorAll<HTMLButtonElement>(
        `[data-handle-for="${CSS.escape(focusKey)}"]`
      );
      [...(handles ?? [])].find((el) => el.offsetParent !== null)?.focus();
      setFocusKey(null);
    }
  }, [focusKey]);

  const byKey = useMemo(() => new Map(watched.map((item) => [keyOf(item), item])), [watched]);
  // Un titre retiré des « vus » depuis disparaît aussi du Top (le Worker
  // fait de même côté page publique).
  const chosen = (picks ?? []).filter((key) => byKey.has(key));
  const sortable = useSortable({
    keys: chosen,
    enabled: chosen.length > 1,
    onReorder: (next) => save(next),
  });

  async function save(next: string[]) {
    const previous = picks;
    setPicks(next);
    setError(null);
    try {
      const res = await fetch("/api/account/top-picks", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topPicks: next }),
      });
      if (!res.ok) {
        throw new Error();
      }
      cachePicks(next);
    } catch {
      setPicks(previous);
      setError(t("topPicks.saveError"));
    }
  }

  function add(key: string) {
    if (!chosen.includes(key) && chosen.length < MAX_PICKS) {
      save([...chosen, key]);
    }
  }

  function remove(key: string) {
    save(chosen.filter((k) => k !== key));
  }

  function move(key: string, to: number) {
    const from = chosen.indexOf(key);
    if (from === to || to < 0 || to >= chosen.length) {
      return;
    }
    save(moveKey(chosen, key, to));
  }

  function onHandleKeyDown(e: KeyboardEvent<HTMLButtonElement>, key: string) {
    const index = chosen.indexOf(key);
    const target =
      e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? index - 1
        : e.key === "ArrowRight" || e.key === "ArrowDown"
          ? index + 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? chosen.length - 1
              : null;
    if (target === null) {
      return;
    }
    e.preventDefault();
    move(key, target);
    setFocusKey(key);
  }

  // Poignée de déplacement : départ du glisser au doigt, flèches au clavier.
  function handleProps(key: string, title: string, index: number) {
    return {
      "data-drag-handle": true,
      "data-handle-for": key,
      onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => onHandleKeyDown(e, key),
      "aria-label": t("topPicks.moveLabel", { title, rank: index + 1, count: chosen.length }),
      "aria-describedby": "top-picks-keyboard-hint",
    };
  }

  // Premier chargement sans cache : cases vides inertes, à la taille finale,
  // pour que la page ne saute pas quand le top arrive.
  const loading = picks === null;
  const free = MAX_PICKS - chosen.length;
  const emptySlots = Array.from({ length: free }, (_, i) => chosen.length + i);
  const profilePath = shareSlug ? `/u/${username ?? shareSlug}` : null;
  const canDrag = chosen.length > 1;

  return (
    <section
      ref={panelRef}
      className={styles.panel}
      aria-labelledby="top-picks-title"
      aria-busy={loading}
    >
      <div className={styles.head}>
        <div>
          <h2 id="top-picks-title" className={styles.title}>
            {t("topPicks.title")}
            {!loading && (
              <span className={styles.counter}>
                {t("topPicks.counter", { count: chosen.length, max: MAX_PICKS })}
              </span>
            )}
          </h2>
          <p className={styles.subtitle}>{t("topPicks.subtitle")}</p>
        </div>
        {profilePath && (
          <Link to={profilePath} className={styles.profileBtn}>
            <Icon name="external" /> {t("topPicks.viewOnProfile")}
          </Link>
        )}
      </div>

      {watched.length === 0 ? (
        <p className={styles.hint}>{t("topPicks.noWatched")}</p>
      ) : (
        <>
          <ol className={styles.slots}>
            {sortable.order.map((key, index) => {
              const item = byKey.get(key)!;
              const poster = posterUrl(item.posterPath, "w342");
              const accent = posterAccentFromGenres(item.genreIds, key);
              const year = item.date?.slice(0, 4);
              const type = t(item.mediaType === "tv" ? "topPicks.series" : "topPicks.movie");
              return (
                <li
                  key={key}
                  {...sortable.itemProps(key)}
                  className={`${styles.slot} ${canDrag ? styles.draggable : ""} ${
                    sortable.dragKey === key ? styles.dragging : ""
                  }`}
                >
                  {canDrag && (
                    <button
                      type="button"
                      className={styles.rowHandle}
                      {...handleProps(key, item.title, index)}
                    >
                      <Icon name="dragHandle" />
                    </button>
                  )}
                  <span className={`${styles.rank} ${styles[RANK_CLASS[index]]}`} aria-hidden>
                    {index + 1}
                  </span>
                  <div className={styles.card}>
                    {poster ? (
                      <img className={styles.poster} src={poster} alt="" draggable={false} />
                    ) : (
                      <span className={`${styles.noPoster} ${posterStyles[accent]}`}>
                        <span className={styles.noPosterTitle}>{item.title}</span>
                      </span>
                    )}
                    <span className={styles.typeBadge}>{type}</span>
                    {canDrag && (
                      <button
                        type="button"
                        className={styles.dragChip}
                        {...handleProps(key, item.title, index)}
                      >
                        <Icon name="dragHandle" /> {t("topPicks.drag")}
                      </button>
                    )}
                  </div>
                  <div className={styles.meta}>
                    <span className={styles.slotTitle}>{item.title}</span>
                    <span className={styles.slotSub}>
                      {type}
                      {year ? ` · ${year}` : ""}
                      {item.rating != null && (
                        <span className={styles.slotRating}>
                          {" · "}
                          <Icon name="star" filled /> {item.rating}
                        </span>
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={styles.remove}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => remove(key)}
                    aria-label={t("topPicks.removeTitle", { title: item.title })}
                    title={t("topPicks.remove")}
                  >
                    <Icon name="close" />
                  </button>
                </li>
              );
            })}
            {emptySlots.map((index) => (
              <li
                key={`empty-${index}`}
                className={`${styles.slot} ${styles.emptySlot} ${loading ? styles.loadingSlot : ""}`}
              >
                <span className={`${styles.rank} ${styles.rankOutline}`} aria-hidden>
                  {index + 1}
                </span>
                {loading ? (
                  <span className={`${styles.addCard} ${styles.loadingCard}`} aria-hidden />
                ) : (
                  <button
                    type="button"
                    className={styles.addCard}
                    onClick={() => setPickerOpen(true)}
                    aria-label={t("topPicks.addAt", { rank: index + 1 })}
                  >
                    <span className={styles.plus} aria-hidden>
                      +
                    </span>
                    {t("topPicks.add")}
                  </button>
                )}
                <div className={styles.meta}>
                  <span className={styles.slotSub}>
                    {loading ? "\u00a0" : t("topPicks.freeSlot")}
                  </span>
                </div>
              </li>
            ))}
          </ol>

          {free > 0 && !loading && (
            <button type="button" className={styles.addRow} onClick={() => setPickerOpen(true)}>
              <span className={styles.plus} aria-hidden>
                +
              </span>
              <span className={styles.addRowLabel}>{t("topPicks.addRow")}</span>
              <span className={styles.addRowFree}>{t("topPicks.freeCount", { count: free })}</span>
            </button>
          )}

          {canDrag && (
            <p className={styles.footHint}>
              <Icon name="dragHandle" />
              <span className={styles.footHintDesktop}>{t("topPicks.hintDesktop")}</span>
              <span className={styles.footHintMobile}>{t("topPicks.hintMobile")}</span>
            </p>
          )}
          <p id="top-picks-keyboard-hint" hidden>
            {t("topPicks.keyboardHint")}
          </p>
        </>
      )}

      {error && (
        <p className={styles.errorHint} role="alert">
          {error}
        </p>
      )}

      <TopPicksPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        watched={watched}
        chosen={chosen}
        onToggle={(key) => (chosen.includes(key) ? remove(key) : add(key))}
      />
    </section>
  );
}

interface PickerProps {
  open: boolean;
  onClose: () => void;
  watched: LibraryItem[];
  chosen: string[];
  onToggle: (key: string) => void;
}

type TypeFilter = "all" | MediaType;
const TYPE_FILTERS: TypeFilter[] = ["all", "movie", "tv"];

// Modale « Ajouter à mon top 5 » (feuille du bas sur mobile) : la recherche
// ne porte que sur les titres vus, jamais sur tout le catalogue. Les mieux
// notés d'abord ; un clic ajoute le titre, la modale reste ouverte pour en
// ajouter d'autres jusqu'à ce qu'on la ferme. Les titres déjà dans le top
// sont grisés avec leur rang ; un nouveau clic les retire (décocher).
function TopPicksPicker({ open, onClose, watched, chosen, onToggle }: PickerProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      setQuery("");
      setTypeFilter("all");
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const candidates = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return watched
      .filter(
        (item) =>
          (typeFilter === "all" || item.mediaType === typeFilter) &&
          (!q || item.title.toLocaleLowerCase().includes(q))
      )
      .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  }, [watched, query, typeFilter]);

  const free = MAX_PICKS - chosen.length;

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="top-picks-picker-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      {open && (
        <div className={styles.dialogContent}>
          <span className={styles.sheetGrabber} aria-hidden />
          <div className={styles.dialogHead}>
            <div>
              <h2 id="top-picks-picker-title" className={styles.dialogTitle}>
                {t("topPicks.pickerTitle")}
              </h2>
              <p className={styles.dialogSubtitle}>{t("topPicks.freeSlots", { count: free })}</p>
            </div>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              aria-label={t("topPicks.close")}
            >
              <Icon name="close" />
            </button>
          </div>
          <label className={styles.search}>
            <Icon name="search" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("topPicks.searchPlaceholder")}
              aria-label={t("topPicks.searchLabel")}
            />
          </label>
          <div className={styles.typeTabs} role="group" aria-label={t("topPicks.typeFilter")}>
            {TYPE_FILTERS.map((type) => (
              <button
                key={type}
                type="button"
                className={`${styles.typeTab} ${typeFilter === type ? styles.typeTabActive : ""}`}
                onClick={() => setTypeFilter(type)}
                aria-pressed={typeFilter === type}
              >
                {t(`topPicks.type.${type}`)}
              </button>
            ))}
          </div>
          <div className={styles.results}>
            {candidates.length === 0 ? (
              <p className={styles.hint}>{t("topPicks.noResult")}</p>
            ) : (
              <>
                <h3 className={styles.sectionTitle}>{t("topPicks.seenSection")}</h3>
                <ul className={styles.grid}>
                  {candidates.map((item) => {
                    const key = keyOf(item);
                    const rank = chosen.indexOf(key) + 1;
                    const poster = posterUrl(item.posterPath, "w185");
                    const accent = posterAccentFromGenres(item.genreIds, key);
                    const year = item.date?.slice(0, 4);
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          className={`${styles.candidate} ${rank ? styles.inTopCandidate : ""}`}
                          onClick={() => onToggle(key)}
                          disabled={rank === 0 && free === 0}
                          aria-pressed={rank > 0}
                        >
                          <span className={styles.candidatePoster}>
                            {poster ? (
                              <img className={styles.poster} src={poster} alt="" loading="lazy" />
                            ) : (
                              <span className={`${styles.noPoster} ${posterStyles[accent]}`}>
                                <span className={styles.noPosterTitle}>{item.title}</span>
                              </span>
                            )}
                            <span className={styles.typeBadge}>
                              {t(item.mediaType === "tv" ? "topPicks.series" : "topPicks.movie")}
                            </span>
                            {item.rating != null && (
                              <span className={styles.rating}>
                                <Icon name="star" filled /> {item.rating}
                              </span>
                            )}
                            {rank > 0 && (
                              <span className={styles.inTop}>
                                <span
                                  className={`${styles.inTopRank} ${styles[RANK_CLASS[rank - 1]]}`}
                                >
                                  {rank}
                                </span>
                                <span className={styles.inTopLabel}>{t("topPicks.inTop")}</span>
                                <span className={styles.inTopRemove}>
                                  <Icon name="close" /> {t("topPicks.untick")}
                                </span>
                              </span>
                            )}
                          </span>
                          <span className={styles.candidateTitle}>{item.title}</span>
                          {year && <span className={styles.candidateYear}>{year}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}
