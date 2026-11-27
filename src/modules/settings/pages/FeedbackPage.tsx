import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import Chip from "../../../shared/components/Chip/Chip.tsx";
import Icon from "../../../shared/components/Icon/Icon.tsx";
import { SettingsGroup, SettingsRow } from "../../profile/components/SettingsGroup.tsx";
import accountStyles from "../../profile/components/AccountSettings.module.css";
import styles from "./FeedbackPage.module.css";

// Mêmes bornes que le Worker (FEEDBACK_MIN / FEEDBACK_MAX, worker/tickets-logic.ts).
const MIN = 10;
const MAX = 2000;
const KINDS = ["feature", "improvement", "bug", "other"] as const;
type Kind = (typeof KINDS)[number];

// Réglages › Suggestions : formulaire envoyé à POST /api/feedback, qui range
// la suggestion (anonyme) en idée sur la page Tickets de l'espace admin.
export default function FeedbackPage() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>("feature");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const long = message.replace(/\s+/g, "").length >= MIN;

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!long) {
      setError(t("feedbackPage.errors.tooShort", { min: MIN }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, message }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { reason?: string };
        setError(
          data.reason === "rate-limited"
            ? t("feedbackPage.errors.rateLimited")
            : data.reason === "too-short"
              ? t("feedbackPage.errors.tooShort", { min: MIN })
              : t("feedbackPage.errors.generic")
        );
        return;
      }
      setSent(true);
      setMessage("");
    } catch {
      setError(t("feedbackPage.errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsGroup
      title={t("settings.sections.suggestions.title")}
      description={t("feedbackPage.lead")}
    >
      {sent ? (
        <SettingsRow>
          <div className={styles.sent} role="status">
            <span className={styles.sentIcon} aria-hidden="true">
              <Icon name="check" strokeWidth={3} />
            </span>
            <div>
              <p className={styles.sentTitle}>{t("feedbackPage.sentTitle")}</p>
              <p className={accountStyles.hint}>{t("feedbackPage.sentText")}</p>
            </div>
            <button
              type="button"
              className={`${accountStyles.secondaryBtn} ${styles.again}`}
              onClick={() => setSent(false)}
            >
              {t("feedbackPage.sendAnother")}
            </button>
          </div>
        </SettingsRow>
      ) : (
        <SettingsRow wide>
          <form className={styles.form} onSubmit={send}>
            <fieldset className={styles.kinds}>
              <legend className={accountStyles.fieldLabel}>{t("feedbackPage.kindLabel")}</legend>
              <div className={styles.chips}>
                {KINDS.map((k) => (
                  <Chip key={k} active={kind === k} onClick={() => setKind(k)}>
                    {t(`feedbackPage.kinds.${k}`)}
                  </Chip>
                ))}
              </div>
            </fieldset>

            <label className={accountStyles.fieldLabel} htmlFor="feedback-message">
              {t("feedbackPage.messageLabel")}
            </label>
            <textarea
              id="feedback-message"
              className={styles.input}
              value={message}
              maxLength={MAX}
              rows={6}
              required
              placeholder={t("feedbackPage.messagePlaceholder")}
              aria-describedby="feedback-hint"
              onChange={(e) => {
                setMessage(e.target.value);
                setError(null);
              }}
            />
            <div className={styles.meta}>
              <span id="feedback-hint">{t("feedbackPage.minHint", { min: MIN })}</span>
              <span className={styles.count}>
                {t("feedbackPage.count", { count: message.length, max: MAX })}
              </span>
            </div>

            <p className={`${accountStyles.hint} ${styles.anonymous}`}>
              <Icon name="lock" /> {t("feedbackPage.anonymous")}
            </p>

            <div className={accountStyles.inline}>
              <button type="submit" className={accountStyles.primaryBtn} disabled={busy || !long}>
                {busy ? t("feedbackPage.sending") : t("feedbackPage.send")}
              </button>
            </div>
            {error && (
              <span className={accountStyles.errorHint} role="alert">
                {error}
              </span>
            )}
          </form>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
