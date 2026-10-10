import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import { PageHeader } from "../../shared/components/index.ts";
import LegalSection from "./LegalSection.tsx";
import { LEGAL_CONTACT_URL } from "./contact.ts";
import styles from "./LegalPage.module.css";

export default function PrivacyPolicyPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("pageTitle.privacy"));

  return (
    <div className={styles.page}>
      <PageHeader eyebrow={t("legal.eyebrow")} title={t("privacyPolicyPage.title")} />
      <p className={styles.updated}>
        {t("privacyPolicyPage.lastUpdated", { date: t("privacyPolicyPage.lastUpdatedValue") })}
      </p>

      <LegalSection title={t("privacyPolicyPage.controller.title")}>
        <p>
          {t("privacyPolicyPage.controller.textBefore")}
          {t("legal.contactLabel")} (
          <a href={LEGAL_CONTACT_URL} target="_blank" rel="noreferrer">
            {LEGAL_CONTACT_URL}
          </a>
          ).
        </p>
      </LegalSection>

      <LegalSection title={t("privacyPolicyPage.dataCollected.title")}>
        <ul>
          <li>
            <strong>{t("privacyPolicyPage.dataCollected.account.label")}</strong>
            {t("privacyPolicyPage.dataCollected.account.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.dataCollected.signInProviders.label")}</strong>
            {t("privacyPolicyPage.dataCollected.signInProviders.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.dataCollected.library.label")}</strong>
            {t("privacyPolicyPage.dataCollected.library.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.dataCollected.preferences.label")}</strong>
            {t("privacyPolicyPage.dataCollected.preferences.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.dataCollected.push.label")}</strong>
            {t("privacyPolicyPage.dataCollected.push.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.dataCollected.technical.label")}</strong>
            {t("privacyPolicyPage.dataCollected.technical.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.dataCollected.sharedLists.label")}</strong>
            {t("privacyPolicyPage.dataCollected.sharedLists.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.dataCollected.follows.label")}</strong>
            {t("privacyPolicyPage.dataCollected.follows.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.dataCollected.reminders.label")}</strong>
            {t("privacyPolicyPage.dataCollected.reminders.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.dataCollected.sharedProfile.label")}</strong>
            {t("privacyPolicyPage.dataCollected.sharedProfile.text")}
          </li>
        </ul>
      </LegalSection>

      <LegalSection title={t("privacyPolicyPage.why.title")}>
        <p>{t("privacyPolicyPage.why.text")}</p>
      </LegalSection>

      <LegalSection title={t("privacyPolicyPage.sharing.title")}>
        <p>{t("privacyPolicyPage.sharing.intro")}</p>
        <ul>
          <li>
            <strong>{t("privacyPolicyPage.sharing.tmdb.label")}</strong>
            {t("privacyPolicyPage.sharing.tmdb.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.sharing.resend.label")}</strong>
            {t("privacyPolicyPage.sharing.resend.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.sharing.recaptcha.label")}</strong>
            {t("privacyPolicyPage.sharing.recaptcha.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.sharing.google.label")}</strong>
            {t("privacyPolicyPage.sharing.google.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.sharing.apple.label")}</strong>
            {t("privacyPolicyPage.sharing.apple.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.sharing.cloudflare.label")}</strong>
            {t("privacyPolicyPage.sharing.cloudflare.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.sharing.sentry.label")}</strong>
            {t("privacyPolicyPage.sharing.sentry.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.sharing.analytics.label")}</strong>
            {t("privacyPolicyPage.sharing.analytics.text")}
          </li>
          <li>
            <strong>{t("privacyPolicyPage.sharing.gravatar.label")}</strong>
            {t("privacyPolicyPage.sharing.gravatar.text")}
          </li>
        </ul>
        <p>{t("privacyPolicyPage.sharing.outro")}</p>
      </LegalSection>

      <LegalSection title={t("privacyPolicyPage.cookies.title")}>
        <p>{t("privacyPolicyPage.cookies.text")}</p>
      </LegalSection>

      <LegalSection title={t("privacyPolicyPage.retention.title")}>
        <p>
          {t("privacyPolicyPage.retention.textBefore")}
          {t("legal.contactLabel")}
          {t("privacyPolicyPage.retention.textAfter")}
        </p>
      </LegalSection>

      <LegalSection title={t("privacyPolicyPage.rights.title")}>
        <p>
          {t("privacyPolicyPage.rights.textBefore")}
          {t("legal.contactLabel")}
          {t("privacyPolicyPage.rights.textAfter")}
        </p>
      </LegalSection>

      <LegalSection title={t("privacyPolicyPage.changes.title")}>
        <p>{t("privacyPolicyPage.changes.text")}</p>
      </LegalSection>
    </div>
  );
}
