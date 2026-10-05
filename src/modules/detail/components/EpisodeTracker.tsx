import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { dateLocaleTag, formatFullDate, type SeriesEpisodeBadge } from "../../../core/api/tmdb.ts";
import { isStrictlyFutureDate } from "../../../core/api/releaseBadge.ts";
import { useLibrary } from "../../../core/context/LibraryContext.tsx";
import { useLocale } from "../../../core/context/LocaleContext.tsx";
import { useMembersOnly } from "../../../core/context/MembersOnlyContext.tsx";
import type { EpisodeRef, LibraryItemInput } from "../../../core/types/library.ts";
import type { Episode, EpisodeAirInfo, Season } from "../../../core/types/tmdb.ts";
import { Icon } from "../../../shared/components/index.ts";
import { pop } from "../../../shared/lib/motion.ts";
import {
  airedEpisodesUpTo,
  isAired,
  mainSeasons,
  todayIso,
  type LoadSeason,
} from "../useSeasonEpisodes.ts";
import styles from "./EpisodeTracker.module.css";

interface EpisodeTrackerProps {
  item: LibraryItemInput;
  seasons: Season[];
  episodesBySeason: Record<number, Episode[]>;
  loadSeason: LoadSeason;
  /** Badge « Vient de sortir » / « Prochainement » de la série, repris sur
   * l'épisode concerné. */
  episodeBadge: SeriesEpisodeBadge | null;
  nextEpisodeToAir: EpisodeAirInfo | null | undefined;
}

type NextState =
  | { kind: "loading"; seasonNumber: number }
  | { kind: "next"; seasonNumber: number; episode: Episode }
  | { kind: "upToDate" };

function parseKey(key: string): EpisodeRef {
  const [seasonNumber, episodeNumber] = key.split("-").map(Number);
  return { seasonNumber, episodeNumber };
}

function isAfter(a: EpisodeRef, b: EpisodeRef): boolean {
  return (
    a.seasonNumber > b.seasonNumber ||
    (a.seasonNumber === b.seasonNumber && a.episodeNumber > b.episodeNumber)
  );
}

// Bloc « Épisodes » de la fiche série : prochain épisode à voir, onglets de
// saison et liste des épisodes de la saison affichée. Comme « Séries en
// cours » (useResumableSeries), le prochain épisode est celui qui suit le
// dernier vu dans l'ordre saison/épisode — pas « le premier non coché ».
// Les épisodes spéciaux (saison 0) ont leur onglet mais ne comptent ni dans
// le total ni dans le prochain épisode.
export default function EpisodeTracker({
  item,
  seasons,
  episodesBySeason,
  loadSeason,
  episodeBadge,
  nextEpisodeToAir,
}: EpisodeTrackerProps) {
  const { t } = useTranslation();
  const { getWatchedEpisodes, toggleEpisodeWatched, setEpisodesWatched } = useLibrary();
  const { requireMember } = useMembersOnly();
  const { locale } = useLocale();
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  // Saisons dont la liste d'épisodes est repliée (longues saisons : on
  // n'a pas à faire défiler 190 épisodes pour atteindre la suite de la fiche).
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const tabsRef = useRef<HTMLDivElement>(null);
  const today = todayIso();

  const main = mainSeasons(seasons);
  const specials = seasons.find((s) => s.season_number === 0 && s.episode_count > 0);
  const tabs = specials ? [...main, specials] : main;
  const watchedKeys = getWatchedEpisodes(item.mediaType, item.id);
  const watchedMain = [...watchedKeys].map(parseKey).filter((ref) => ref.seasonNumber > 0);
  const totalEpisodes = main.reduce((sum, s) => sum + s.episode_count, 0);
  const lastWatched = watchedMain.reduce<EpisodeRef | null>(
    (max, ref) => (!max || isAfter(ref, max) ? ref : max),
    null
  );

  const next = findNext();
  const loadingSeason = next.kind === "loading" ? next.seasonNumber : null;
  const firstSeason = main.find((s) => s.episode_count > 0)?.season_number ?? null;
  const shownSeason =
    selectedSeason ??
    (next.kind === "next" ? next.seasonNumber : (lastWatched?.seasonNumber ?? firstSeason));

  useEffect(() => {
    if (loadingSeason != null) {
      loadSeason(loadingSeason);
    }
  }, [loadingSeason, loadSeason]);

  useEffect(() => {
    if (shownSeason != null) {
      loadSeason(shownSeason);
    }
  }, [shownSeason, loadSeason]);

  function findNext(): NextState {
    const start = lastWatched?.seasonNumber ?? 0;
    for (const season of main) {
      if (season.season_number < start || season.episode_count === 0) {
        continue;
      }
      const episodes = episodesBySeason[season.season_number];
      if (!episodes) {
        return { kind: "loading", seasonNumber: season.season_number };
      }
      const candidate = episodes.find(
        (ep) =>
          !lastWatched ||
          isAfter(
            { seasonNumber: season.season_number, episodeNumber: ep.episode_number },
            lastWatched
          )
      );
      if (candidate) {
        return isAired(candidate, today)
          ? { kind: "next", seasonNumber: season.season_number, episode: candidate }
          : { kind: "upToDate" };
      }
    }
    return { kind: "upToDate" };
  }

  function watchedInSeason(seasonNumber: number): number {
    let count = 0;
    for (const key of watchedKeys) {
      if (key.startsWith(`${seasonNumber}-`)) {
        count += 1;
      }
    }
    return count;
  }

  function isWatched(seasonNumber: number, episodeNumber: number): boolean {
    return watchedKeys.has(`${seasonNumber}-${episodeNumber}`);
  }

  async function markUpTo(seasonNumber: number, episodeNumber: number) {
    if (!requireMember()) {
      return;
    }
    const refs = await airedEpisodesUpTo(seasons, loadSeason, { seasonNumber, episodeNumber });
    setEpisodesWatched(item, refs, true);
  }

  // Même mécanisme que le bouton calendrier de la fiche détail (« Vu » du
  // film/de la série) : marquer une saison comme vue à une date passée
  // plutôt que toujours "aujourd'hui", pour des stats/un fil social fiables
  // même en regardant une saison plus tard que sa diffusion.
  function handleSeasonWatchDateChange(e: ChangeEvent<HTMLInputElement>, episodes: EpisodeRef[]) {
    const value = e.target.value;
    // Repart d'un champ vide : un <input type="date"> ne redéclenche pas
    // onChange si on resélectionne la même date plus tard.
    e.target.value = "";
    if (!value || !requireMember()) {
      return;
    }
    const watchedAt = new Date(`${value}T12:00:00`).getTime();
    if (Number.isNaN(watchedAt) || watchedAt > Date.now()) {
      return;
    }
    setEpisodesWatched(item, episodes, true, watchedAt);
  }

  function shortDate(iso: string | undefined | null): string | null {
    if (!iso) {
      return null;
    }
    return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(dateLocaleTag(locale), {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  if (totalEpisodes === 0 && !specials) {
    return null;
  }

  // « Vous êtes à jour » : prochain épisode annoncé par TMDB, sinon
  // première saison annoncée.
  function upcomingNote(): string | null {
    if (nextEpisodeToAir?.air_date) {
      return t("episodeTracker.nextAiring", {
        season: nextEpisodeToAir.season_number,
        episode: nextEpisodeToAir.episode_number,
        date: formatFullDate(nextEpisodeToAir.air_date, locale) || nextEpisodeToAir.air_date,
      });
    }
    const announced = main.find(
      (s) =>
        (!lastWatched || s.season_number > lastWatched.seasonNumber) &&
        (s.episode_count === 0 || isStrictlyFutureDate(s.air_date, today))
    );
    if (!announced) {
      return null;
    }
    return announced.air_date
      ? t("episodeTracker.seasonAnnouncedOn", {
          number: announced.season_number,
          date: formatFullDate(announced.air_date, locale) || announced.air_date,
        })
      : t("episodeTracker.seasonAnnounced", { number: announced.season_number });
  }

  const shown = tabs.find((s) => s.season_number === shownSeason) ?? null;
  const shownEpisodes = shownSeason != null ? episodesBySeason[shownSeason] : undefined;
  const shownAired = (shownEpisodes || []).filter((ep) => isAired(ep, today));
  const shownComplete =
    shown != null &&
    shownAired.length > 0 &&
    shownAired.every((ep) => isWatched(shown.season_number, ep.episode_number));
  const note = next.kind === "upToDate" ? upcomingNote() : null;
  const shownCollapsed = shown != null && collapsed.has(shown.season_number);

  function toggleCollapsed(seasonNumber: number, fromBottom = false) {
    setCollapsed((prev) => {
      const nextSet = new Set(prev);
      if (!nextSet.delete(seasonNumber)) {
        nextSet.add(seasonNumber);
      }
      return nextSet;
    });
    // Replié depuis le bas d'une longue liste : on remonte aux onglets,
    // sinon on se retrouve loin sous le bloc qui vient de rétrécir.
    if (fromBottom) {
      requestAnimationFrame(() =>
        tabsRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
      );
    }
  }

  function collapseButton(seasonNumber: number, fromBottom = false) {
    const isCollapsed = collapsed.has(seasonNumber);
    return (
      <button
        type="button"
        className={styles.collapseBtn}
        onClick={() => toggleCollapsed(seasonNumber, fromBottom)}
        aria-expanded={!isCollapsed}
      >
        <Icon name={isCollapsed ? "chevronDown" : "chevronUp"} size={16} />
        {isCollapsed ? t("episodeTracker.expandSeason") : t("episodeTracker.collapseSeason")}
      </button>
    );
  }

  return (
    <section className={styles.tracker}>
      <h2 className={styles.title}>
        {t("episodeTracker.title")}
        {totalEpisodes > 0 && (
          <span className={styles.total}>
            {t("episodeTracker.watchedCount", {
              watched: Math.min(watchedMain.length, totalEpisodes),
              total: totalEpisodes,
            })}
          </span>
        )}
      </h2>

      {totalEpisodes > 0 && (
        <div className={styles.upNext}>
          {next.kind === "next" && (
            <>
              <div className={styles.upNextText}>
                <p className={`eyebrow ${styles.upNextEyebrow}`}>{t("episodeTracker.upNext")}</p>
                <p className={styles.upNextTitle}>
                  <b>
                    {t("episodeTracker.episodeRef", {
                      season: next.seasonNumber,
                      episode: next.episode.episode_number,
                    })}
                  </b>
                  {next.episode.name && (
                    <span className={styles.upNextName}> · {next.episode.name}</span>
                  )}
                </p>
                <p className={styles.upNextMeta}>
                  {lastWatched
                    ? t("continueWatching.watchedUpTo", {
                        season: lastWatched.seasonNumber,
                        episode: lastWatched.episodeNumber,
                      })
                    : t("episodeTracker.notStarted")}
                </p>
              </div>
              <button
                type="button"
                className={styles.upNextBtn}
                onClick={(e) => {
                  pop(e.currentTarget.firstElementChild);
                  toggleEpisodeWatched(item, next.seasonNumber, next.episode.episode_number);
                }}
              >
                <Icon name="check" strokeWidth={3} />
                {t("episodeTracker.watched")}
              </button>
            </>
          )}
          {next.kind === "upToDate" && (
            <div className={styles.upNextText}>
              <p className={styles.upNextTitle}>
                <b>
                  {lastWatched ? t("episodeTracker.upToDate") : t("episodeTracker.notAiredYet")}
                </b>
              </p>
              {note && <p className={styles.upNextMeta}>{note}</p>}
            </div>
          )}
          {next.kind === "loading" && <p className={styles.upNextMeta}>{t("common.loading")}</p>}
        </div>
      )}

      <div className={styles.tabs} role="tablist" ref={tabsRef}>
        {tabs.map((season) => {
          const count = watchedInSeason(season.season_number);
          const announced =
            season.episode_count === 0 || isStrictlyFutureDate(season.air_date, today);
          const complete = season.episode_count > 0 && count >= season.episode_count;
          const name =
            season.season_number === 0
              ? season.name || t("episodeTracker.specials")
              : t("episodeTracker.seasonNumber", { number: season.season_number });
          return (
            <button
              key={season.season_number}
              type="button"
              role="tab"
              aria-selected={season.season_number === shownSeason}
              disabled={season.episode_count === 0}
              className={`${styles.tab} ${announced ? styles.tabAnnounced : ""} ${
                season.season_number === shownSeason ? styles.tabOn : ""
              }`}
              onClick={() => setSelectedSeason(season.season_number)}
            >
              {announced ? (
                t("episodeTracker.announcedSeason", { name })
              ) : (
                <>
                  {name}
                  <span className={styles.tabCount}>
                    {count}/{season.episode_count}
                  </span>
                  {complete && <Icon name="check" size={14} strokeWidth={3} />}
                </>
              )}
            </button>
          );
        })}
      </div>

      {shown && (
        <div role="tabpanel">
          {!shownEpisodes && <p className={styles.loading}>{t("common.loading")}</p>}
          {shownEpisodes && shownEpisodes.length === 0 && (
            <p className={styles.loading}>{t("episodeTracker.noEpisodesFound")}</p>
          )}
          {shownEpisodes && shownEpisodes.length > 0 && (
            <>
              <div className={styles.listHead}>
                <span className={styles.listCount}>
                  {t("episodeTracker.episodesCount", { count: shownEpisodes.length })}
                </span>
                {collapseButton(shown.season_number)}
              </div>
              {!shownCollapsed && (
                <ul className={styles.episodeList}>
                  {shownEpisodes.map((ep) => {
                    const seasonNumber = shown.season_number;
                    const watched = isWatched(seasonNumber, ep.episode_number);
                    const isNext =
                      next.kind === "next" &&
                      next.seasonNumber === seasonNumber &&
                      next.episode.episode_number === ep.episode_number;
                    const aired = isAired(ep, today);
                    const badge =
                      episodeBadge &&
                      episodeBadge.seasonNumber === seasonNumber &&
                      episodeBadge.episodeNumber === ep.episode_number
                        ? episodeBadge.kind
                        : null;
                    const status = watched
                      ? t("episodeTracker.statusWatched")
                      : isNext
                        ? t("episodeTracker.upNext")
                        : aired
                          ? t("episodeTracker.statusNotWatched")
                          : null;
                    const date = shortDate(ep.air_date);
                    const epLabel = t("episodeTracker.episodeRef", {
                      season: seasonNumber,
                      episode: ep.episode_number,
                    });
                    return (
                      <li
                        key={ep.id ?? ep.episode_number}
                        className={`${styles.episode} ${isNext ? styles.episodeNext : ""}`}
                      >
                        <button
                          type="button"
                          className={`${styles.dot} ${watched ? styles.dotOn : ""}`}
                          aria-pressed={watched}
                          aria-label={
                            watched
                              ? t("episodeTracker.unmarkEpisode", { episode: epLabel })
                              : t("episodeTracker.markEpisode", { episode: epLabel })
                          }
                          onClick={(e) => {
                            if (!watched) {
                              pop(e.currentTarget);
                            }
                            toggleEpisodeWatched(item, seasonNumber, ep.episode_number);
                          }}
                        >
                          <Icon name="check" size={16} strokeWidth={watched ? 3 : 2} />
                        </button>
                        <span className={styles.epNumber}>
                          {t("episodeTracker.episodeShort", { number: ep.episode_number })}
                        </span>
                        <span className={styles.epText}>
                          <span className={styles.epTitle}>
                            {ep.name || t("episodeTracker.untitled")}
                            {badge && (
                              <span
                                className={`${styles.badge} ${
                                  badge === "just_released" ? styles.badgeNew : ""
                                }`}
                              >
                                {badge === "just_released"
                                  ? t("mediaCard.episodeJustReleased")
                                  : t("mediaCard.episodeUpcoming")}
                              </span>
                            )}
                          </span>
                          <span className={`${styles.epMeta} ${watched ? styles.epMetaOn : ""}`}>
                            {aired || !date
                              ? [status, date].filter(Boolean).join(" · ")
                              : t("episodeTracker.airsOn", { date })}
                          </span>
                        </span>
                        {!watched && !isNext && aired && seasonNumber > 0 && (
                          <button
                            type="button"
                            className={styles.upToHere}
                            onClick={() => markUpTo(seasonNumber, ep.episode_number)}
                          >
                            {t("episodeTracker.watchedUpToHere")}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {(shownAired.length > 0 || !shownCollapsed) && (
                <div className={styles.seasonActions}>
                  {!shownCollapsed && collapseButton(shown.season_number, true)}
                  {shownAired.length > 0 && (
                    <button
                      type="button"
                      className={styles.seasonBtn}
                      onClick={() =>
                        setEpisodesWatched(
                          item,
                          (shownComplete ? shownEpisodes : shownAired).map((ep) => ({
                            seasonNumber: shown.season_number,
                            episodeNumber: ep.episode_number,
                          })),
                          !shownComplete
                        )
                      }
                    >
                      <Icon name={shownComplete ? "close" : "check"} />
                      {shownComplete
                        ? t("episodeTracker.unmarkSeason")
                        : shown.season_number === 0
                          ? t("episodeTracker.markAllWatched")
                          : t("episodeTracker.markSeason", { number: shown.season_number })}
                    </button>
                  )}
                  {!shownComplete && shownAired.length > 0 && (
                    <span className={styles.watchDateWrap}>
                      <span
                        className={`${styles.seasonBtn} ${styles.watchDateBtn}`}
                        aria-hidden="true"
                      >
                        <Icon name="calendar" />
                      </span>
                      <input
                        type="date"
                        className={styles.watchDateInput}
                        max={today}
                        aria-label={t("episodeTracker.watchDateAriaLabel", {
                          number: shown.season_number,
                        })}
                        title={t("episodeTracker.watchDateAriaLabel", {
                          number: shown.season_number,
                        })}
                        onChange={(e) =>
                          handleSeasonWatchDateChange(
                            e,
                            shownAired.map((ep) => ({
                              seasonNumber: shown.season_number,
                              episodeNumber: ep.episode_number,
                            }))
                          )
                        }
                      />
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
