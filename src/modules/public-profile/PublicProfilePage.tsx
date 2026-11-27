import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import {
  PageHeader,
  MediaCard,
  Loading,
  ErrorMessage,
  EmptyState,
  FollowButton,
  FollowStats,
  Icon,
  ListCover,
  ReadOnlyBanner,
} from "../../shared/components/index.ts";
import { getGenres } from "../../core/api/tmdb.ts";
import { useAuth } from "../../core/context/AuthContext.tsx";
import { useLocale } from "../../core/context/LocaleContext.tsx";
import { libraryItemToMediaItem } from "../../shared/lib/libraryItem.ts";
import gridStyles from "../../shared/styles/mediaGrid.module.css";
import type { CustomList, LibraryItem, PublicProfile } from "../../core/types/library.ts";
import PublicTopPicks from "./components/PublicTopPicks.tsx";
import PublicReviews from "./components/PublicReviews.tsx";
import styles from "./PublicProfilePage.module.css";

type Tab = "seen" | "want" | "reviews" | "lists";
type TypeFilter = "all" | "movie" | "tv";

type State =
  | { status: "loading" }
  | { status: "success"; profile: PublicProfile }
  | { status: "not-found" }
  | { status: "error"; error: Error };

const TOP_COUNT = 5;
const TYPE_FILTERS: Array<{ id: TypeFilter; labelKey: string }> = [
  { id: "all", labelKey: "publicProfile.filterAll" },
  { id: "movie", labelKey: "publicProfile.filterMovies" },
  { id: "tv", labelKey: "publicProfile.filterSeries" },
];
const CONFIRMATION_MS = 3500;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// Photo servie par le worker (/api/public-profile/:slug/avatar) plutôt que
// par une URL Gravatar construite ici : celle-ci contiendrait le hash de
// l'email du propriétaire. 404 → initiales, comme sur AccountCard.
function ProfileAvatar({ slug, name }: { slug: string; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [slug]);
  return (
    <div className={styles.avatar}>
      {failed ? (
        initials(name)
      ) : (
        <img
          className={styles.avatarImg}
          src={`/api/public-profile/${encodeURIComponent(slug)}/avatar`}
          alt=""
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

function ItemGrid({
  items,
  genreNames,
}: {
  items: LibraryItem[];
  genreNames: Record<number, string>;
}) {
  return (
    <div className={gridStyles.grid}>
      {items.map((item) => (
        <MediaCard
          key={`${item.mediaType}:${item.id}`}
          item={libraryItemToMediaItem(item)}
          ownerRating={item.rating}
          yearGenre
          genreName={(item.genreIds ?? []).map((id) => genreNames[id]).find(Boolean)}
        />
      ))}
    </div>
  );
}

// Profil d'un autre membre, partagé en lecture seule via /u/<slug> ou
// /u/<pseudo> (voir ProfileShareCard) : accessible sans compte. Les cartes
// restent les MediaCard habituelles — la pastille dorée en haut porte la
// note du propriétaire, les boutons « vu »/« envie de voir » du bas agissent
// sur la bibliothèque du visiteur, jamais sur celle du profil consulté.
export default function PublicProfilePage() {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const { status: authStatus } = useAuth();
  const { slug = "" } = useParams();
  const [state, setState] = useState<State>({ status: "loading" });
  const [tab, setTab] = useState<Tab>("seen");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [openListId, setOpenListId] = useState<string | null>(null);
  const [genreMap, setGenreMap] = useState<Record<number, string>>({});
  const [linkCopied, setLinkCopied] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  useDocumentTitle(
    state.status === "success"
      ? state.profile.displayName || t("publicProfile.anonymousName")
      : state.status === "not-found"
        ? t("pageTitle.notFound")
        : null
  );

  // Noms des genres pour « année · genre » sous les affiches (les items ne
  // portent que les ids TMDB). En cas d'échec, seule l'année s'affiche.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getGenres("movie"), getGenres("tv")])
      .then(([movie, tv]) => {
        if (cancelled) {
          return;
        }
        const map: Record<number, string> = {};
        for (const g of [...(movie.genres || []), ...(tv.genres || [])]) {
          map[g.id] = g.name;
        }
        setGenreMap(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!confirmation) {
      return;
    }
    const timer = setTimeout(() => setConfirmation(null), CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [confirmation]);

  useEffect(() => {
    if (!linkCopied) {
      return;
    }
    const timer = setTimeout(() => setLinkCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [linkCopied]);

  const profile = state.status === "success" ? state.profile : null;

  // Top 5 choisi à la main par le propriétaire (voir TopPicksPanel dans Ma
  // liste) ; section masquée s'il n'en a pas défini.
  const top = useMemo(() => {
    if (!profile?.topPicks.length) {
      return [];
    }
    const byKey = new Map(profile.watched.map((item) => [`${item.mediaType}:${item.id}`, item]));
    return profile.topPicks.flatMap((key) => byKey.get(key) ?? []).slice(0, TOP_COUNT);
  }, [profile]);

  // Titres vus avec un avis texte (onglet « Avis »), dans l'ordre des « Vus ».
  const reviewed = useMemo(
    () => (profile?.watched ?? []).filter((item) => item.reviewText),
    [profile]
  );

  const averageRating = useMemo(() => {
    const ratings = (profile?.watched ?? [])
      .map((item) => item.rating)
      .filter((rating): rating is number => rating != null);
    if (ratings.length === 0) {
      return null;
    }
    return (ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toLocaleString(locale, {
      maximumFractionDigits: 1,
    });
  }, [profile, locale]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setTab("seen");
    setTypeFilter("all");
    setOpenListId(null);
    fetch(`/api/public-profile/${encodeURIComponent(slug)}`)
      .then(async (res) => {
        if (res.status === 404) {
          return { status: "not-found" } as const;
        }
        if (!res.ok) {
          throw new Error(t("publicProfile.loadError"));
        }
        return { status: "success", profile: (await res.json()) as PublicProfile } as const;
      })
      .then((next) => {
        if (!cancelled) {
          setState(next);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            error: err instanceof Error ? err : new Error(t("publicProfile.loadError")),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug, t]);

  if (state.status === "loading") {
    return <Loading />;
  }
  if (state.status === "error") {
    return (
      <div className={styles.page}>
        <ErrorMessage error={state.error} />
      </div>
    );
  }
  if (state.status === "not-found" || !profile) {
    return (
      <div className={styles.page}>
        <PageHeader
          eyebrow={t("publicProfile.eyebrow")}
          title={t("publicProfile.notFoundTitle")}
          lead={t("publicProfile.notFoundLead")}
        />
        <Link to="/" className={styles.homeLink}>
          {t("notFound.backToHome")}
        </Link>
      </div>
    );
  }

  const loggedIn = authStatus === "authenticated";
  const name = profile.displayName || t("publicProfile.anonymousName");

  // Follow/unfollow : compteurs renvoyés par le serveur, appliqués tels quels.
  function applyFollow(viewerFollows: boolean, counts: { followers: number; following: number }) {
    if (!profile) {
      return;
    }
    setState({ status: "success", profile: { ...profile, ...counts, viewerFollows } });
    setConfirmation(
      viewerFollows
        ? t("publicProfile.followConfirmed", { name })
        : t("publicProfile.unfollowConfirmed", { name })
    );
  }

  // Sur son propre profil, suivre quelqu'un depuis une des listes change le
  // compteur d'abonnements affiché : on le recharge sans repasser par l'écran
  // de chargement.
  function refreshOwnCounts() {
    if (!profile?.isSelf) {
      return;
    }
    fetch(`/api/public-profile/${encodeURIComponent(slug)}`)
      .then((res) => (res.ok ? (res.json() as Promise<PublicProfile>) : null))
      .then((next) => {
        if (next) {
          setState({ status: "success", profile: next });
        }
      })
      .catch(() => {
        // Compteur légèrement en retard jusqu'au prochain chargement : sans gravité.
      });
  }

  // Feuille de partage native quand elle existe (mobile), sinon copie du
  // lien — même logique que le partage de fiche / de liste.
  async function shareProfile() {
    if (!profile) {
      return;
    }
    const url = `${window.location.origin}/u/${profile.username ?? profile.shareSlug}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: name, url });
      } catch {
        // Partage annulé par l'utilisateur : rien à faire.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
    } catch {
      // Presse-papiers indisponible : l'adresse reste dans la barre du navigateur.
    }
  }

  const byType = (items: LibraryItem[]) =>
    typeFilter === "all" ? items : items.filter((item) => item.mediaType === typeFilter);
  const openList: CustomList | undefined =
    tab === "lists" ? profile.customLists.find((l) => l.id === openListId) : undefined;
  const { followedBy } = profile;
  const followedByOthers = followedBy.total - followedBy.profiles.length;
  const followedByNames = followedBy.profiles.map(
    (p) => p.displayName || t("publicProfile.anonymousName")
  );

  const stats = [
    { value: profile.watched.length, label: t("publicProfile.statWatched") },
    { value: profile.watchlist.length, label: t("publicProfile.statWant") },
    { value: profile.customLists.length, label: t("publicProfile.statLists") },
    { value: averageRating ?? "—", label: t("publicProfile.statAverage"), star: true },
  ];

  const tabs: Array<{ id: Tab; label: string; count: number }> = [
    { id: "seen", label: t("publicProfile.tabSeen"), count: profile.watched.length },
    { id: "want", label: t("publicProfile.tabWant"), count: profile.watchlist.length },
    { id: "reviews", label: t("publicProfile.tabReviews"), count: reviewed.length },
    { id: "lists", label: t("publicProfile.tabLists"), count: profile.customLists.length },
  ];

  const shareButton = (
    <button
      type="button"
      className={`${styles.shareBtn} ${loggedIn ? styles.shareBtnIcon : ""}`}
      onClick={() => void shareProfile()}
      aria-label={t("publicProfile.share")}
      title={t("publicProfile.share")}
    >
      <Icon name={linkCopied ? "check" : "share"} size={16} />
      <span className={styles.shareLabel}>
        {linkCopied ? t("publicProfile.linkCopied") : t("publicProfile.share")}
      </span>
    </button>
  );

  return (
    <div className={styles.page}>
      {!loggedIn && authStatus !== "loading" && (
        <ReadOnlyBanner>{t("publicProfile.readOnly", { name })}</ReadOnlyBanner>
      )}

      <header className={styles.header}>
        <ProfileAvatar slug={profile.shareSlug} name={name} />
        <div className={styles.identity}>
          <p className={styles.eyebrow}>
            {loggedIn ? t("publicProfile.eyebrowMember") : t("publicProfile.eyebrow")}
          </p>
          <div className={styles.nameRow}>
            <h1 className={styles.name}>{name}</h1>
            {profile.username && <span className={styles.handle}>@{profile.username}</span>}
            {profile.followsViewer && (
              <span className={styles.followsYou}>{t("publicProfile.followsYou")}</span>
            )}
          </div>
          {loggedIn && (
            <FollowStats
              slug={profile.shareSlug}
              name={name}
              counts={{ followers: profile.followers, following: profile.following }}
              onListChange={refreshOwnCounts}
            />
          )}
          {loggedIn && followedBy.total > 0 && (
            <p className={styles.followedBy}>
              <span className={styles.miniAvatars} aria-hidden>
                {followedByNames.map((n, i) => (
                  <span key={followedBy.profiles[i].slug} className={styles.miniAvatar}>
                    {initials(n).charAt(0)}
                  </span>
                ))}
              </span>
              <span>
                {followedByOthers > 0
                  ? t("publicProfile.followedByMore", {
                      names: followedByNames.join(", "),
                      count: followedByOthers,
                    })
                  : t("publicProfile.followedBy", {
                      names: new Intl.ListFormat(locale, { type: "conjunction" }).format(
                        followedByNames
                      ),
                      count: followedBy.total,
                    })}
              </span>
            </p>
          )}
        </div>
        <div className={`${styles.actions} ${loggedIn ? "" : styles.actionsSolo}`}>
          {loggedIn &&
            (profile.isSelf ? (
              <span className={styles.selfHint}>{t("follow.ownProfile")}</span>
            ) : (
              <FollowButton
                slug={profile.shareSlug}
                following={profile.viewerFollows}
                onChange={applyFollow}
              />
            ))}
          {shareButton}
        </div>
      </header>

      {confirmation && (
        <p className={styles.confirmation} role="status">
          <Icon name="check" size={16} /> {confirmation}
        </p>
      )}

      <ul className={styles.stats}>
        {stats.map((stat) => (
          <li key={stat.label} className={styles.stat}>
            <span className={styles.statValue}>
              {stat.star && (
                <span className={styles.statStar}>
                  <Icon name="star" size={14} filled />
                </span>
              )}
              {stat.value}
            </span>
            <span className={styles.statLabel}>{stat.label}</span>
          </li>
        ))}
      </ul>

      {top.length > 0 && <PublicTopPicks items={top} ownerName={name} genreNames={genreMap} />}

      <div className={styles.toolbar}>
        <div className={styles.segmented} role="tablist">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`${styles.segment} ${tab === item.id ? styles.segmentActive : ""}`}
              onClick={() => {
                setTab(item.id);
                setOpenListId(null);
              }}
            >
              {item.label} <span className={styles.count}>{item.count}</span>
            </button>
          ))}
        </div>
        {(tab !== "lists" || openList) && (
          <>
            {tab !== "reviews" && (
              <p className={styles.legend}>
                <Icon name="star" size={12} filled /> {t("publicProfile.legendOwner", { name })} ·{" "}
                <Icon name="star" size={12} /> <Icon name="check" size={12} />{" "}
                {t("publicProfile.legendVisitor")}
              </p>
            )}
            <div
              className={styles.segmented}
              role="group"
              aria-label={t("publicProfile.typeFilter")}
            >
              {TYPE_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={typeFilter === filter.id}
                  className={`${styles.segment} ${typeFilter === filter.id ? styles.segmentActive : ""}`}
                  onClick={() => setTypeFilter(filter.id)}
                >
                  {t(filter.labelKey)}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {tab === "seen" &&
        (byType(profile.watched).length === 0 ? (
          <EmptyState label={t("publicProfile.emptySeen")} />
        ) : (
          <ItemGrid items={byType(profile.watched)} genreNames={genreMap} />
        ))}

      {tab === "want" &&
        (byType(profile.watchlist).length === 0 ? (
          <EmptyState label={t("publicProfile.emptyWant")} />
        ) : (
          <ItemGrid items={byType(profile.watchlist)} genreNames={genreMap} />
        ))}

      {tab === "reviews" &&
        (byType(reviewed).length === 0 ? (
          <EmptyState label={t("publicProfile.emptyReviews")} />
        ) : (
          <PublicReviews items={byType(reviewed)} ownerName={name} />
        ))}

      {tab === "lists" &&
        !openList &&
        (profile.customLists.length === 0 ? (
          <EmptyState label={t("publicProfile.emptyLists")} />
        ) : (
          <ul className={styles.lists}>
            {profile.customLists.map((list) => (
              <li key={list.id}>
                <button
                  type="button"
                  className={styles.listCard}
                  onClick={() => setOpenListId(list.id)}
                >
                  <ListCover items={list.items} />
                  <span className={styles.listBody}>
                    <span className={styles.listName}>{list.name}</span>
                    <span className={styles.listCount}>
                      {t("publicProfile.listCount", { count: list.items.length })}
                    </span>
                  </span>
                  <Icon name="arrowRight" size={18} />
                </button>
              </li>
            ))}
          </ul>
        ))}

      {openList && (
        <section aria-labelledby="public-list-title">
          <div className={styles.listHead}>
            <button type="button" className={styles.backBtn} onClick={() => setOpenListId(null)}>
              <Icon name="arrowLeft" size={16} /> {t("publicProfile.backToLists")}
            </button>
            <h2 id="public-list-title" className={styles.listTitle}>
              {openList.name}
            </h2>
          </div>
          {byType(openList.items).length === 0 ? (
            <EmptyState label={t("publicProfile.emptyList")} />
          ) : (
            <ItemGrid items={byType(openList.items)} genreNames={genreMap} />
          )}
        </section>
      )}
    </div>
  );
}
