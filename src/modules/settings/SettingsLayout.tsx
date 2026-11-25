import { Link, Outlet, useLocation, useMatch } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Icon } from "../../shared/components/index.ts";
import type { IconName } from "../../shared/components/Icon/Icon.tsx";
import { SETTINGS_SECTIONS } from "./sections.ts";
import { useSettingsSummary } from "./SettingsSummary.tsx";
import styles from "./SettingsLayout.module.css";

function SettingsSectionRow({ id, icon }: { id: string; icon: IconName }) {
  const { t } = useTranslation();
  const summary = useSettingsSummary(id);
  const match = useMatch(`/reglages/${id}/*`);
  return (
    // Chemin absolu, pas relatif (`to={id}`) : `/reglages/*` est une route
    // splat (voir App.tsx), donc un `to` relatif se résout par rapport à
    // l'URL courante entière plutôt qu'au segment de route — en repartant
    // d'une sous-page déjà ouverte (ex. /reglages/compte), il pointait vers
    // /reglages/compte/confidentialite (aucune route ne matche, retour au
    // sommaire par le `path="*"` plus bas), d'où le clic qui ne marchait
    // qu'une fois sur deux (retour de review).
    <Link
      to={`/reglages/${id}`}
      className={`${styles.row} ${match ? styles.rowActive : ""}`}
      aria-current={match ? "page" : undefined}
    >
      <Icon name={icon} size={19} className={styles.rowIcon} />
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>{t(`settings.sections.${id}.title`)}</span>
        <span className={styles.rowSummary}>{summary ?? t(`settings.sections.${id}.summary`)}</span>
      </span>
      <Icon name="chevronRight" size={16} className={styles.rowChevron} />
    </Link>
  );
}

// Page Réglages (refonte Profil/Préférences, carte Trello
// https://trello.com/c/Wym5VQTd) : sommaire + sous-pages, séparée de Profil
// (qui ne garde plus que Ma liste et Communauté). Sur desktop, sommaire à
// gauche et détail à droite en permanence (vrai panneau maître-détail) ;
// sur mobile, un seul des deux panneaux est visible à la fois — déterminé
// ici par la correspondance exacte avec /reglages (sommaire) ou non
// (détail), piloté en CSS via [data-pane].
export default function SettingsLayout() {
  const { t } = useTranslation();
  const location = useLocation();
  const atSummary = location.pathname === "/reglages" || location.pathname === "/reglages/";

  return (
    <div className={styles.page} data-pane={atSummary ? "summary" : "detail"}>
      <h1 className={styles.heading}>{t("settings.title")}</h1>

      <nav className={styles.nav} aria-label={t("settings.navLabel")}>
        {SETTINGS_SECTIONS.map(({ id, icon }) => (
          <SettingsSectionRow key={id} id={id} icon={icon} />
        ))}
      </nav>

      <div className={styles.detail}>
        {!atSummary && (
          <Link to="/reglages" className={styles.back}>
            <Icon name="arrowLeft" size={16} /> {t("settings.backToSummary")}
          </Link>
        )}
        <Outlet />
      </div>
    </div>
  );
}
