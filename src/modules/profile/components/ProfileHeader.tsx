import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../../core/context/AuthContext.tsx";
import { useLibrary } from "../../../core/context/LibraryContext.tsx";
import { getFollowList } from "../../../core/api/follows.ts";
import { AccountAvatar, Icon } from "../../../shared/components/index.ts";
import styles from "./ProfileHeader.module.css";

// Nouvelle DA · Profil : en-tête personnel (avatar, nom, badge « Public »,
// @pseudo, compteurs) à la place de l'ancien bloc « Réglages / Profil ».
// Sans profil public, « Voir mon profil public » mène au réglage
// Confidentialité de la page Réglages (/reglages/confidentialite). L'icône
// crantée ouvre le sommaire de Réglages (refonte Profil/Préférences).
export default function ProfileHeader() {
  const { t } = useTranslation();
  const { email, displayName, username, shareSlug } = useAuth();
  const { watched, watchlist, customLists } = useLibrary();
  const [followers, setFollowers] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getFollowList(null, "followers")
      .then((profiles) => {
        if (!cancelled) {
          setFollowers(profiles.length);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const name = displayName?.trim() || email || "";
  // Même lien que PublicProfileSettings : /u/<pseudo> dès qu'un pseudo existe.
  const sharePath = shareSlug ? `/u/${username ?? shareSlug}` : null;

  async function share() {
    if (!sharePath) {
      return;
    }
    const url = `${window.location.origin}${sharePath}`;
    // Feuille de partage native quand elle existe (mobile surtout), sinon
    // copie dans le presse-papiers.
    if (navigator.share) {
      try {
        await navigator.share({ title: t("profileShare.shareTitle"), url });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Presse-papiers refusé : le lien reste copiable dans l'onglet Compte.
    }
  }

  // Abonnés pas encore chargés : un tiret à la place du nombre, pour que la
  // ligne ne s'allonge pas (ni ne passe sur deux lignes) à leur arrivée.
  const stats = [
    { key: "statWatched", count: watched.length },
    { key: "statWatchlist", count: watchlist.length },
    { key: "statLists", count: customLists.length },
    { key: "statFollowers", count: followers },
  ];

  const viewLabel = t("profileShare.preview");

  return (
    <header className={`${styles.header} ${username ? "" : styles.noHandle}`}>
      <AccountAvatar name={name} className={styles.avatar} />

      <div className={styles.identity}>
        <p className={styles.eyebrow}>{t("profile.headerEyebrow")}</p>
        <div className={styles.nameRow}>
          <h1 className={styles.name}>{name}</h1>
          {sharePath && (
            <span className={styles.badge}>
              <Icon name="globe" size={13} /> {t("profile.badgePublic")}
            </span>
          )}
        </div>
        <p className={styles.meta}>
          {username && <span className={styles.handle}>@{username}</span>}
          <span className={styles.stats}>
            {stats.map((stat, i) => (
              <span key={stat.key}>
                {i > 0 && " · "}
                <strong>{stat.count ?? "–"}</strong>{" "}
                {t(`profile.${stat.key}`, { count: stat.count ?? 0 })}
              </span>
            ))}
          </span>
        </p>
      </div>

      <div className={styles.actions}>
        {sharePath ? (
          <Link to={sharePath} className={styles.action} aria-label={viewLabel} title={viewLabel}>
            <Icon name="eye" size={18} />
            <span className={styles.actionLabel}>{viewLabel}</span>
          </Link>
        ) : (
          <Link
            to="/reglages/confidentialite"
            className={styles.action}
            aria-label={viewLabel}
            title={viewLabel}
          >
            <Icon name="eye" size={18} />
            <span className={styles.actionLabel}>{viewLabel}</span>
          </Link>
        )}
        {sharePath && (
          <button
            type="button"
            className={`${styles.action} ${styles.shareAction}`}
            onClick={() => void share()}
          >
            <Icon name={copied ? "check" : "share"} size={17} />
            <span className={styles.actionLabel}>
              {copied ? t("profile.linkCopied") : t("profile.share")}
            </span>
          </button>
        )}
        <Link
          to="/reglages"
          className={styles.action}
          aria-label={t("settings.title")}
          title={t("settings.title")}
        >
          <Icon name="settings" size={18} />
          <span className={styles.actionLabel}>{t("settings.title")}</span>
        </Link>
      </div>
    </header>
  );
}
