import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import TicketLogo from "../TicketLogo/TicketLogo.tsx";
import styles from "./Footer.module.css";

export default function Footer() {
  const { t } = useTranslation();
  return (
    <footer className={styles.footer}>
      <div className={styles.row}>
        <span className={styles.brand}>
          <TicketLogo className={styles.logo} />
          Seancy
        </span>
        <span className={styles.meta}>{t("footer.tagline")}</span>
        <nav className={styles.links}>
          <Link to="/conditions-utilisation">{t("footer.terms")}</Link>
          <Link to="/confidentialite">{t("footer.privacy")}</Link>
          <Link to="/changelog">{t("footer.changelog")}</Link>
        </nav>
      </div>
    </footer>
  );
}
