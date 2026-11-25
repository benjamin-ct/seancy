import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import TicketLogo from "../../../shared/components/TicketLogo/TicketLogo.tsx";
import { LEGAL_CONTACT_URL } from "../../legal/contact.ts";
import { SettingsGroup, SettingsRow } from "../../profile/components/SettingsGroup.tsx";
import styles from "./AboutPage.module.css";

export default function AboutPage() {
  const { t } = useTranslation();
  return (
    <SettingsGroup title={t("settings.sections.a-propos.title")} description={t("aboutPage.lead")}>
      <SettingsRow label={t("aboutPage.brandLabel")}>
        <span className={styles.brand}>
          <TicketLogo className={styles.logo} />
          Seancy
        </span>
      </SettingsRow>

      <SettingsRow label={t("aboutPage.catalogLabel")} description={t("aboutPage.catalogText")} />

      <SettingsRow label={t("aboutPage.legalLabel")}>
        <div className={styles.links}>
          <Link to="/conditions-utilisation">{t("legalLinks.terms")}</Link>
          <Link to="/confidentialite">{t("legalLinks.privacy")}</Link>
        </div>
      </SettingsRow>

      <SettingsRow label={t("aboutPage.contactLabel")}>
        <a href={LEGAL_CONTACT_URL} target="_blank" rel="noreferrer" className={styles.links}>
          {t("legal.contactLabel")}
        </a>
      </SettingsRow>
    </SettingsGroup>
  );
}
