import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../../core/context/AuthContext.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsGroup.tsx";
import styles from "./AccountSettings.module.css";

// Export et suppression de compte (RGPD) : déplacés hors du groupe
// « Compte » de l'onglet Compte (AccountSettings.tsx) vers Réglages › Mes
// données, dans le cadre de la refonte de la page Profil/Préférences.
export default function DataSettings() {
  const { t } = useTranslation();
  const { status, email, deleteAccount } = useAuth();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);

  if (status !== "authenticated") {
    return null;
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
