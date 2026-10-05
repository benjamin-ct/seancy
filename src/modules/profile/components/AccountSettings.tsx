import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../../core/context/AuthContext.tsx";
import { gravatarUrl } from "../../../shared/lib/gravatar.ts";
import {
  loadAvatarSource,
  renderAvatarImage,
  type AvatarCrop,
} from "../../../shared/lib/avatarImage.ts";
import { Icon } from "../../../shared/components/index.ts";
import AvatarCropDialog from "./AvatarCropDialog.tsx";
import EmailChangeForm from "./EmailChangeForm.tsx";
import SignInMethods from "./SignInMethods.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsGroup.tsx";
import styles from "./AccountSettings.module.css";

// Même règle que normalizeUsername côté Worker (worker/share-slug.ts) : on
// n'interroge le serveur que pour une saisie déjà valide.
const USERNAME_PATTERN = /^[a-z0-9_]{3,15}$/;
const USERNAME_CHECK_DELAY_MS = 400;

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

type UsernameStatus = "idle" | "checking" | "available" | "taken" | "invalid" | "error";

/** Initiale affichée dans l'avatar quand il n'y a aucune photo. */
function initial(name: string, fallback: string): string {
  return (name.trim() || fallback).charAt(0).toUpperCase() || "?";
}

/**
 * Avatar du compte : photo personnelle si elle existe, sinon photo Gravatar,
 * sinon l'initiale. Chaque image qui ne se charge pas (404 Gravatar, photo
 * supprimée depuis un autre appareil) laisse la place à la suivante.
 */
export function AccountAvatar({ name, className }: { name: string; className: string }) {
  const { email, avatarVersion } = useAuth();
  const sources = useMemo(
    () =>
      [
        avatarVersion !== null ? `/api/account/avatar?v=${avatarVersion}` : null,
        email ? gravatarUrl(email) : null,
      ].filter((url): url is string => url !== null),
    [email, avatarVersion]
  );
  const [failedCount, setFailedCount] = useState(0);
  // Repart de la première source quand elles changent (nouvelle photo,
  // connexion avec un autre compte), sinon un précédent échec resterait
  // collé.
  useEffect(() => {
    setFailedCount(0);
  }, [sources]);
  const url = sources[failedCount];
  return (
    <div className={className} aria-hidden="true">
      {url ? (
        <img
          key={url}
          className={styles.avatarImg}
          src={url}
          alt=""
          onError={() => setFailedCount((n) => n + 1)}
        />
      ) : (
        initial(name, email || "?")
      )}
    </div>
  );
}

// Choix / suppression de la photo personnelle, sous l'aperçu de l'identité.
// La photo choisie s'ouvre d'abord dans la modale de recadrage, puis est
// enregistrée dès la validation (pas via la barre « Enregistrer » du nom et
// du pseudo).
function AvatarActions() {
  const { t } = useTranslation();
  const { avatarVersion, uploadAvatar, removeAvatar } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Photo en cours de recadrage (modale ouverte tant qu'elle est non nulle).
  const [source, setSource] = useState<ImageBitmap | null>(null);

  // Libère la mémoire de la photo décodée une fois la modale refermée.
  useEffect(() => () => source?.close(), [source]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.avatarError"));
    } finally {
      setBusy(false);
    }
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Permet de rechoisir le même fichier juste après.
    e.target.value = "";
    if (!file) {
      return;
    }
    setError(null);
    loadAvatarSource(file).then(setSource, () => setError(t("accountCard.avatarUnreadable")));
  }

  function onCropConfirm(crop: AvatarCrop) {
    if (!source) {
      return;
    }
    run(async () => {
      await uploadAvatar(await renderAvatarImage(source, crop));
      setSource(null);
    });
  }

  return (
    <div className={styles.avatarActions}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={onFileChange}
        aria-label={t("accountCard.avatarChoose")}
      />
      <button
        type="button"
        className={styles.secondaryBtn}
        onClick={() => inputRef.current?.click()}
        disabled={busy}
      >
        {busy
          ? t("accountCard.saving")
          : avatarVersion !== null
            ? t("accountCard.avatarChange")
            : t("accountCard.avatarChoose")}
      </button>
      {avatarVersion !== null && (
        <button
          type="button"
          className={styles.ghostBtn}
          onClick={() => run(removeAvatar)}
          disabled={busy}
        >
          {t("accountCard.avatarRemove")}
        </button>
      )}
      <small className={error ? styles.errorHint : styles.mutedHint} aria-live="polite">
        {error ?? t("accountCard.avatarHint")}
      </small>
      <AvatarCropDialog
        image={source}
        busy={busy}
        error={error}
        onCancel={() => setSource(null)}
        onConfirm={onCropConfirm}
      />
    </div>
  );
}

// Nouvelle DA 7/10 : groupe « Compte » de l'onglet Compte (identité, e-mail,
// session). C'est désormais le seul endroit où se déconnecter.
export default function AccountSettings() {
  const { t } = useTranslation();
  const {
    status,
    email,
    displayName,
    username,
    updateDisplayName,
    updateUsername,
    checkUsername,
    logout,
    logoutAll,
    deleteAccount,
  } = useAuth();
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleStatus, setHandleStatus] = useState<UsernameStatus>("idle");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailChanged, setEmailChanged] = useState(false);
  const [confirmingLogoutAll, setConfirmingLogoutAll] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const [logoutAllError, setLogoutAllError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);

  async function onLogoutAll() {
    setLoggingOutAll(true);
    setLogoutAllError(null);
    try {
      await logoutAll();
    } catch (err) {
      setLogoutAllError(err instanceof Error ? err.message : t("accountCard.logoutAllError"));
      setLoggingOutAll(false);
    }
  }

  const deleteConfirmMatches =
    deleteConfirmInput.trim().toLowerCase() === (email ?? "").trim().toLowerCase();

  async function onDeleteAccount() {
    if (!deleteConfirmMatches) {
      return;
    }
    setDeletingAccount(true);
    setDeleteAccountError(null);
    try {
      await deleteAccount();
    } catch (err) {
      setDeleteAccountError(
        err instanceof Error ? err.message : t("accountCard.deleteAccountError")
      );
      setDeletingAccount(false);
    }
  }

  // Source de vérité : D1 (colonne users.display_name), chargée avec le
  // reste de la session (voir AuthContext, /api/auth/me) — c'est ce qui
  // rend le nom identique sur tous les appareils une fois enregistré
  // (ticket #45). Resynchronise le champ chaque fois que la valeur connue
  // du serveur change (connexion, ou juste après un enregistrement réussi).
  useEffect(() => {
    setName(displayName ?? "");
  }, [displayName]);

  useEffect(() => {
    setHandle(username ?? "");
  }, [username]);

  // Pseudo (ticket « Ajoute de pseudo ») : disponibilité vérifiée pendant la
  // saisie, avec un léger délai pour ne pas interroger le serveur à chaque
  // frappe. Purement indicatif — l'enregistrement refait la vérification.
  const normalizedHandle = normalizeUsername(handle);
  const handleChanged = normalizedHandle !== (username ?? "");
  const nameChanged = name.trim() !== (displayName ?? "");
  const dirty = nameChanged || handleChanged;
  useEffect(() => {
    if (!handleChanged || normalizedHandle === "") {
      setHandleStatus("idle");
      return;
    }
    if (!USERNAME_PATTERN.test(normalizedHandle)) {
      setHandleStatus("invalid");
      return;
    }
    setHandleStatus("checking");
    const controller = new AbortController();
    const timer = setTimeout(() => {
      checkUsername(normalizedHandle, controller.signal)
        .then((res) => setHandleStatus(res.available ? "available" : (res.reason ?? "taken")))
        .catch((err: unknown) => {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            setHandleStatus("error");
          }
        });
    }, USERNAME_CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [normalizedHandle, handleChanged, checkUsername]);

  // Le « ✓ Enregistré » disparaît dès qu'on recommence à modifier.
  useEffect(() => {
    if (dirty) {
      setSaved(false);
    }
  }, [dirty]);

  if (status !== "authenticated") {
    return null;
  }

  // Save manuel uniquement (barre « Modifications non enregistrées ») : pas
  // de synchro automatique/temps réel — décision produit explicite pour le
  // ticket #45. Pas de gestion de conflit multi-appareils : dernier
  // enregistrement gagnant.
  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (nameChanged) {
        await updateDisplayName(name.trim());
      }
      if (handleChanged) {
        await updateUsername(normalizedHandle);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2400);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("accountCard.saveError"));
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setName(displayName ?? "");
    setHandle(username ?? "");
    setError(null);
  }

  // Aperçu en direct : reflète la saisie en cours, avant enregistrement.
  const previewName = name.trim() || t("accountCard.previewNoName");
  const previewHandle = normalizedHandle || username || "";
  const blockingHandle = handleChanged && normalizedHandle !== "" && handleStatus !== "available";

  return (
    <SettingsGroup title={t("accountCard.groupTitle")} description={t("accountCard.groupLead")}>
      <SettingsRow label={t("accountCard.identity")} description={t("accountCard.identityHint")}>
        <div className={styles.preview}>
          <AccountAvatar name={name} className={styles.avatar} />
          <div className={styles.previewText}>
            <strong className={styles.previewName}>{previewName}</strong>
            {previewHandle ? (
              <>
                <span className={styles.mono}>@{previewHandle}</span>
                <span className={`${styles.mono} ${styles.previewLink}`}>
                  <Icon name="link" size={13} />
                  {window.location.host}/u/{previewHandle}
                </span>
              </>
            ) : (
              <span className={styles.previewLink}>{t("accountCard.previewNoUsername")}</span>
            )}
          </div>
          <span className={styles.previewTag}>{t("accountCard.preview")}</span>
        </div>
        <AvatarActions />

        <div className={styles.identityFields}>
          <label className={styles.field}>
            <span>{t("accountCard.displayName")}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("accountCard.displayNamePlaceholder")}
            />
          </label>
          <label className={styles.field}>
            <span>{t("accountCard.username")}</span>
            <div className={styles.handleInput}>
              <span className={styles.handlePrefix} aria-hidden="true">
                @
              </span>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder={t("accountCard.usernamePlaceholder")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={16}
                aria-describedby="account-username-status"
              />
            </div>
            <small
              id="account-username-status"
              className={
                handleStatus === "available"
                  ? styles.okHint
                  : handleStatus === "taken" ||
                      handleStatus === "invalid" ||
                      handleStatus === "error"
                    ? styles.errorHint
                    : styles.mutedHint
              }
              aria-live="polite"
            >
              {handleStatus === "idle"
                ? t("accountCard.usernameHint")
                : t(`accountCard.username_${handleStatus}`)}
            </small>
          </label>
        </div>

        {dirty ? (
          <div className={styles.saveBar} role="status">
            <span className={styles.saveBarText}>{t("accountCard.unsaved")}</span>
            {error && <span className={styles.errorHint}>{error}</span>}
            <div className={styles.saveBarActions}>
              <button type="button" className={styles.ghostBtn} onClick={cancel} disabled={saving}>
                {t("accountCard.cancel")}
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={save}
                disabled={saving || blockingHandle}
              >
                {saving ? t("accountCard.saving") : t("accountCard.save")}
              </button>
            </div>
          </div>
        ) : (
          saved && (
            <p className={styles.okHint} role="status">
              <Icon name="check" size={14} strokeWidth={2.6} /> {t("accountCard.saved")}
            </p>
          )
        )}
      </SettingsRow>

      <SettingsRow label={t("accountCard.email")} description={t("accountCard.emailHint")}>
        <div className={styles.inline}>
          <input
            className={styles.readonlyInput}
            type="email"
            value={email || ""}
            readOnly
            aria-label={t("accountCard.email")}
          />
          {!editingEmail && (
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => {
                setEmailChanged(false);
                setEditingEmail(true);
              }}
            >
              {t("accountCard.emailChange.edit")}
            </button>
          )}
        </div>
        <p className={styles.subtleHint}>
          <Icon name="lock" size={14} /> {t("accountCard.emailPrivate")}
        </p>
        {editingEmail && (
          <EmailChangeForm
            onCancel={() => setEditingEmail(false)}
            onDone={() => {
              setEditingEmail(false);
              setEmailChanged(true);
            }}
          />
        )}
        {emailChanged && <p className={styles.okHint}>{t("accountCard.emailChange.done")}</p>}
      </SettingsRow>

      <SignInMethods />

      <SettingsRow label={t("accountCard.session")} description={t("accountCard.sessionHint")}>
        <button type="button" className={styles.secondaryBtn} onClick={logout}>
          {t("accountCard.logout")}
        </button>
      </SettingsRow>

      <SettingsRow
        label={t("accountCard.allDevices")}
        description={t("accountCard.allDevicesHint")}
      >
        {confirmingLogoutAll ? (
          <div role="alert">
            <p className={styles.subtleHint}>{t("accountCard.logoutAllConfirm")}</p>
            <div className={styles.inline}>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={onLogoutAll}
                disabled={loggingOutAll}
              >
                {t("accountCard.logoutAll")}
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => setConfirmingLogoutAll(false)}
                disabled={loggingOutAll}
              >
                {t("accountCard.emailChange.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => setConfirmingLogoutAll(true)}
          >
            {t("accountCard.logoutAll")}
          </button>
        )}
        {logoutAllError && <p className={styles.errorHint}>{logoutAllError}</p>}
      </SettingsRow>

      <SettingsRow
        label={t("accountCard.exportData")}
        description={t("accountCard.exportDataHint")}
      >
        <a className={styles.secondaryBtn} href="/api/account/export" download="seancy-export.json">
          {t("accountCard.exportDataButton")}
        </a>
      </SettingsRow>

      <SettingsRow
        label={t("accountCard.deleteAccount")}
        description={t("accountCard.deleteAccountHint")}
      >
        {confirmingDelete ? (
          <div className={styles.confirm} role="alertdialog">
            <p>{t("accountCard.deleteAccountConfirmTitle")}</p>
            <p>{t("accountCard.deleteAccountConfirmText", { email })}</p>
            <input
              type="text"
              value={deleteConfirmInput}
              onChange={(e) => setDeleteConfirmInput(e.target.value)}
              placeholder={t("accountCard.deleteAccountConfirmPlaceholder")}
              aria-label={t("accountCard.deleteAccountConfirmPlaceholder")}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={deletingAccount}
            />
            {deleteAccountError && <p className={styles.errorHint}>{deleteAccountError}</p>}
            <div className={styles.inline}>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={onDeleteAccount}
                disabled={!deleteConfirmMatches || deletingAccount}
              >
                {deletingAccount
                  ? t("accountCard.deleting")
                  : t("accountCard.deleteAccountConfirmButton")}
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => {
                  setConfirmingDelete(false);
                  setDeleteConfirmInput("");
                  setDeleteAccountError(null);
                }}
                disabled={deletingAccount}
              >
                {t("accountCard.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => setConfirmingDelete(true)}
          >
            {t("accountCard.deleteAccountButton")}
          </button>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}
