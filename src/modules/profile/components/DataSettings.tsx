import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../../core/context/AuthContext.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsGroup.tsx";
import styles from "./AccountSettings.module.css";

// Export et suppression de compte (RGPD) : déplacés hors du groupe
// « Compte » de l'onglet Compte (AccountSettings.tsx) vers Réglages › Mes
// données, dans le cadre de la refonte de la page Profil/Préférences.
//
// Suppression en trois temps (remplace la confirmation par simple saisie
// de l'adresse e-mail, audit M14) : un code envoyé par email prouve l'accès
// à la boîte mail, sa confirmation programme la suppression dans 7 jours
// (affichée ensuite via pendingDeletionAt), annulable à tout moment avant
// cette échéance — automatiquement en se reconnectant, ou explicitement
// avec le bouton ci-dessous.
export default function DataSettings() {
  const { t } = useTranslation();
  const {
    status,
    pendingDeletionAt,
    requestAccountDeletion,
    confirmAccountDeletion,
    cancelAccountDeletion,
  } = useAuth();
  const [requesting, setRequesting] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status !== "authenticated") {
    return null;
  }

  async function onRequestDeletion() {
    setRequesting(true);
    setError(null);
    try {
      const result = await requestAccountDeletion();
      setCodeSent(true);
      setDevCode(result.devCode ?? null);
      setCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("accountCard.deleteAccountError"));
    } finally {
      setRequesting(false);
    }
  }

  async function onConfirmDeletion() {
    setConfirming(true);
    setError(null);
    try {
      await confirmAccountDeletion(code.trim());
      setCodeSent(false);
      setCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("accountCard.deleteAccountError"));
    } finally {
      setConfirming(false);
    }
  }

  async function onCancelDeletion() {
    setCancelling(true);
    setError(null);
    try {
      await cancelAccountDeletion();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("accountCard.deleteAccountError"));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <SettingsGroup title={t("dataSettings.groupTitle")} description={t("dataSettings.groupLead")}>
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
        {pendingDeletionAt ? (
          <div className={styles.confirm} role="alertdialog">
            <p>
              {t("accountCard.deleteAccountPending", {
                date: new Date(pendingDeletionAt).toLocaleDateString(),
              })}
            </p>
            {error && <p className={styles.errorHint}>{error}</p>}
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={onCancelDeletion}
              disabled={cancelling}
            >
              {cancelling ? t("accountCard.deleting") : t("accountCard.deleteAccountCancel")}
            </button>
          </div>
        ) : codeSent ? (
          <div className={styles.confirm} role="alertdialog">
            <p>{t("accountCard.deleteAccountCodeSent")}</p>
            {devCode && (
              <p className={styles.hint}>
                {t("accountCard.emailChange.devCode", { code: devCode })}
              </p>
            )}
            <input
              type="text"
              inputMode="text"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t("accountCard.emailChange.code")}
              aria-label={t("accountCard.emailChange.code")}
              disabled={confirming}
            />
            {error && <p className={styles.errorHint}>{error}</p>}
            <div className={styles.inline}>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={onConfirmDeletion}
                disabled={!code.trim() || confirming}
              >
                {confirming
                  ? t("accountCard.deleting")
                  : t("accountCard.deleteAccountConfirmButton")}
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => {
                  setCodeSent(false);
                  setCode("");
                  setError(null);
                }}
                disabled={confirming}
              >
                {t("accountCard.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <>
            {error && <p className={styles.errorHint}>{error}</p>}
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={onRequestDeletion}
              disabled={requesting}
            >
              {requesting ? t("accountCard.deleting") : t("accountCard.deleteAccountButton")}
            </button>
          </>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}
