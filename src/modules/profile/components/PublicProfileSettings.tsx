import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../../core/context/AuthContext.tsx";
import { useLibrary } from "../../../core/context/LibraryContext.tsx";
import { Icon } from "../../../shared/components/index.ts";
import { AccountAvatar } from "./AccountSettings.tsx";
import { PUBLIC_LINK_ANCHOR } from "./ProfileHeader.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsGroup.tsx";
import styles from "./AccountSettings.module.css";

const VISIBLE_KEYS = ["watched", "watchlist", "lists", "name"] as const;
const HIDDEN_KEYS = ["email", "episodes"] as const;

// Nouvelle DA 7/10 : groupe « Profil public » de l'onglet Compte.
// Partage du profil en lecture seule : opt-in explicite, le lien n'existe
// qu'une fois le partage activé et meurt dès qu'on le désactive (voir
// handleUpdateProfileShare côté Worker).
export default function PublicProfileSettings() {
  const { t } = useTranslation();
  const { shareSlug, username, displayName, setProfileShared } = useAuth();
  const { watched, watchlist, customLists } = useLibrary();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lien lisible /u/<pseudo> dès qu'un pseudo est choisi ; l'ancien lien
  // /u/<slug> reste valide tant que le partage est actif.
  const sharePath = shareSlug ? `/u/${username ?? shareSlug}` : null;
  const shareUrl = sharePath ? `${window.location.origin}${sharePath}` : null;
  const isPublic = shareUrl !== null;

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await setProfileShared(enabled);
      setConfirmingDisable(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profileShare.error"));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!shareUrl) {
      return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(t("profileShare.copyError"));
    }
  }

  async function share() {
    if (!shareUrl) {
      return;
    }
    // Feuille de partage native quand elle existe (mobile surtout), sinon
    // copie dans le presse-papiers.
    if (navigator.share) {
      try {
        await navigator.share({ title: t("profileShare.shareTitle"), url: shareUrl });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
      }
    }
    await copy();
  }

  function onSwitch() {
    if (isPublic) {
      // Désactivation : confirmation dans la ligne, pas de window.confirm.
      setConfirmingDisable(true);
    } else {
      void toggle(true);
    }
  }

  return (
    <SettingsGroup
      id={PUBLIC_LINK_ANCHOR}
      title={t("profileShare.groupTitle")}
      description={t("profileShare.groupLead")}
    >
      <SettingsRow label={t("profileShare.title")} description={t("profileShare.hint")}>
        <div className={styles.statusRow}>
          {isPublic ? (
            <span className={`${styles.statusPill} ${styles.statusPublic}`}>
              <Icon name="globe" size={15} /> {t("profileShare.statusPublic")}
            </span>
          ) : (
            <span className={styles.statusPill}>
              <Icon name="lock" size={14} /> {t("profileShare.statusPrivate")}
            </span>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={isPublic}
            aria-label={t("profileShare.switchLabel")}
            className={`${styles.switch} ${isPublic ? styles.switchOn : ""}`}
            onClick={onSwitch}
            disabled={busy}
          />
        </div>

        {confirmingDisable && (
          <div className={styles.confirm} role="alert">
            <p>{t("profileShare.confirmDisable")}</p>
            <div className={styles.inline}>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => setConfirmingDisable(false)}
                disabled={busy}
              >
                {t("profileShare.keep")}
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => toggle(false)}
                disabled={busy}
              >
                {t("profileShare.disable")}
              </button>
            </div>
          </div>
        )}

        {isPublic && sharePath ? (
          <>
            <span className={styles.fieldLabel}>{t("profileShare.linkLabel")}</span>
            <div className={styles.linkField}>
              <Icon name="link" size={16} className={styles.linkIcon} />
              <input
                type="text"
                value={shareUrl}
                readOnly
                aria-label={t("profileShare.linkLabel")}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" className={styles.primaryBtn} onClick={copy}>
                <Icon name={copied ? "check" : "copy"} size={15} />
                {copied ? t("profileShare.copied") : t("profileShare.copy")}
              </button>
            </div>
            <div className={`${styles.inline} ${styles.shareActions}`}>
              <button type="button" className={styles.secondaryBtn} onClick={share}>
                <Icon name="share" size={15} /> {t("profileShare.share")}
              </button>
              <Link to={sharePath} className={styles.secondaryBtn}>
                <Icon name="external" size={15} /> {t("profileShare.preview")}
              </Link>
            </div>
            {!username && <p className={styles.subtleHint}>{t("profileShare.usernameTip")}</p>}
            <div className={styles.miniPreview}>
              <AccountAvatar name={displayName ?? ""} className={styles.miniAvatar} />
              <div className={styles.previewText}>
                <span>
                  <strong>{displayName || t("publicProfile.anonymousName")}</strong>
                  {username && <span className={styles.mono}> @{username}</span>}
                </span>
                <span className={styles.mutedHint}>
                  {t("profileShare.counts", {
                    watched: watched.length,
                    watchlist: watchlist.length,
                    lists: customLists.length,
                  })}
                </span>
              </div>
              <span className={styles.previewTag}>{t("accountCard.preview")}</span>
            </div>
            <p className={styles.visibilitySummary}>
              <Icon name="eye" size={15} />
              <span>
                {t("profileShare.visibleSummary")}{" "}
                <span className={styles.subtle}>{t("profileShare.hiddenSummary")}</span>
              </span>
            </p>
          </>
        ) : (
          <>
            <div className={styles.visibility}>
              <span className={styles.fieldLabel}>{t("profileShare.visibleTitle")}</span>
              <ul>
                {VISIBLE_KEYS.map((key) => (
                  <li key={key}>
                    <Icon name="check" size={15} className={styles.okIcon} />
                    {t(`profileShare.visible.${key}`)}
                  </li>
                ))}
              </ul>
              <span className={styles.fieldLabel}>{t("profileShare.hiddenTitle")}</span>
              <ul>
                {HIDDEN_KEYS.map((key) => (
                  <li key={key} className={styles.subtle}>
                    <Icon name="eyeOff" size={15} />
                    {t(`profileShare.hidden.${key}`)}
                  </li>
                ))}
              </ul>
            </div>
            <p className={styles.subtleHint}>{t("profileShare.readOnlyNote")}</p>
            <button
              type="button"
              className={`${styles.primaryBtn} ${styles.wideBtn}`}
              onClick={() => toggle(true)}
              disabled={busy}
            >
              <Icon name="link" size={16} /> {t("profileShare.enable")}
            </button>
          </>
        )}
        {error && <p className={styles.errorHint}>{error}</p>}
      </SettingsRow>

      <SettingsRow label={t("profileShare.top5")} description={t("profileShare.top5Hint")}>
        <Link to="/profil?tab=ma-liste" className={styles.secondaryBtn}>
          {t("profileShare.top5Link")} <Icon name="arrowRight" size={15} />
        </Link>
      </SettingsRow>
    </SettingsGroup>
  );
}

// Groupe séparé (ticket "Ma liste commune", retour du 2026-10-11) : qui peut
// nous ajouter à une liste commune. Indépendant du partage du profil
// ci-dessus (ça fonctionne même profil privé, listes communes pas liées à
// /u/<slug>).
export function ListInviteRestrictionSettings() {
  const { t } = useTranslation();
  const { restrictListInvites, setListInviteRestricted } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await setListInviteRestricted(enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profileShare.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsGroup
      title={t("listInviteRestriction.groupTitle")}
      description={t("listInviteRestriction.groupLead")}
    >
      <SettingsRow
        label={t("listInviteRestriction.title")}
        description={t("listInviteRestriction.hint")}
      >
        <button
          type="button"
          role="switch"
          aria-checked={restrictListInvites}
          aria-label={t("listInviteRestriction.switchLabel")}
          className={`${styles.switch} ${restrictListInvites ? styles.switchOn : ""}`}
          onClick={() => toggle(!restrictListInvites)}
          disabled={busy}
        />
        {error && <p className={styles.errorHint}>{error}</p>}
      </SettingsRow>
    </SettingsGroup>
  );
}
