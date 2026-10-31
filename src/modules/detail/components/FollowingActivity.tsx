import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getTitleActivity } from "../../../core/api/follows.ts";
import { useAuth } from "../../../core/context/AuthContext.tsx";
import type { TitleActivity } from "../../../core/types/social.ts";
import type { MediaType } from "../../../core/types/tmdb.ts";
import { Icon } from "../../../shared/components/index.ts";
import { posterAccentFromSeed } from "../../../shared/lib/posterAccent.ts";
import posterStyles from "../../../shared/styles/posterAccents.module.css";
import { timeAgo } from "../../../shared/lib/timeAgo.ts";
import styles from "./FollowingActivity.module.css";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// Même source que la page de profil public (/api/public-profile/:slug/avatar,
// 404 → initiales).
function Avatar({ slug, name }: { slug: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={`${styles.avatar} ${posterStyles[posterAccentFromSeed(slug)]}`}
      aria-hidden="true"
    >
      {failed ? (
        initials(name)
      ) : (
        <img
          src={`/api/public-profile/${encodeURIComponent(slug)}/avatar`}
          alt=""
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

// « Vos abonnements » : qui, parmi les profils suivis, a vu ce titre (et
// sa note) ou veut le voir. Masqué si l'utilisateur n'est pas connecté ou
// ne suit personne ; en cas d'erreur réseau aussi (bloc secondaire).
export default function FollowingActivity({ mediaType, id }: { mediaType: MediaType; id: string }) {
  const { t, i18n } = useTranslation();
  const { status } = useAuth();
  const [activity, setActivity] = useState<TitleActivity | null>(null);
  const signedIn = status === "authenticated";

  useEffect(() => {
    setActivity(null);
    if (!signedIn) {
      return;
    }
    let cancelled = false;
    getTitleActivity(mediaType, id)
      .then((data) => !cancelled && setActivity(data))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [signedIn, mediaType, id]);

  if (!signedIn || !activity || activity.following === 0) {
    return null;
  }

  return (
    <section className={styles.card}>
      <h2 className={styles.title}>{t("detailPage.followingTitle")}</h2>
      {activity.entries.length === 0 ? (
        <p className={styles.empty}>{t("detailPage.followingEmpty")}</p>
      ) : (
        <ul className={styles.list}>
          {activity.entries.map(
            ({ profile, status: entryStatus, rating, reviewText, updatedAt, progress }) => {
              const name = profile.displayName || t("detailPage.followingUnnamed");
              const when = timeAgo(updatedAt, i18n.language);
              return (
                <li key={profile.slug}>
                  <Link to={`/u/${encodeURIComponent(profile.slug)}`} className={styles.row}>
                    <Avatar slug={profile.slug} name={name} />
                    <span className={styles.who}>
                      <span className={styles.name}>{name}</span>
                      <span className={styles.what}>
                        {entryStatus === "watched"
                          ? [
                              rating != null
                                ? t("detailPage.followingRated", { rating })
                                : t("detailPage.followingWatched"),
                              when,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : progress
                            ? t("detailPage.followingInProgress", {
                                season: progress.seasonNumber,
                                episode: progress.episodeNumber,
                              })
                            : t("detailPage.followingWants")}
                      </span>
                      {entryStatus === "watched" && reviewText && (
                        <span className={styles.review}>“{reviewText}”</span>
                      )}
                    </span>
                    {rating != null && (
                      <span className={styles.rating}>
                        <Icon name="star" filled />
                        {rating}
                      </span>
                    )}
                  </Link>
                </li>
              );
            }
          )}
        </ul>
      )}
    </section>
  );
}
