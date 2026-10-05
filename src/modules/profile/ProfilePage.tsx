import { useRef, useState, type KeyboardEvent } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import { Icon, Loading } from "../../shared/components/index.ts";
import type { IconName } from "../../shared/components/Icon/Icon.tsx";
import { useAuth } from "../../core/context/AuthContext.tsx";
import MyListContent from "../my-list/index.ts";
import AccountSettings from "./components/AccountSettings.tsx";
import PublicProfileSettings from "./components/PublicProfileSettings.tsx";
import CommunityPanel from "./components/CommunityPanel.tsx";
import NotificationSettings from "./components/NotificationSettings.tsx";
import FavoriteProvidersSettings from "./components/FavoriteProvidersSettings.tsx";
import FavoriteLanguagesSettings from "./components/FavoriteLanguagesSettings.tsx";
import FavoriteCountriesSettings from "./components/FavoriteCountriesSettings.tsx";
import ExcludedGenresSettings from "./components/ExcludedGenresSettings.tsx";
import ExcludedTitlesSettings from "./components/ExcludedTitlesSettings.tsx";
import RegionSettings from "./components/RegionSettings.tsx";
import LanguageSettings from "./components/LanguageSettings.tsx";
import ThemeSettings from "./components/ThemeSettings.tsx";
import { SettingsGroup } from "./components/SettingsGroup.tsx";
import ProfileHeader, { PUBLIC_LINK_ANCHOR } from "./components/ProfileHeader.tsx";
import styles from "./ProfilePage.module.css";

type Tab = "compte" | "preferences" | "ma-liste" | "communaute";
const TABS: { id: Tab; icon: IconName; labelKey: string }[] = [
  { id: "compte", icon: "user", labelKey: "profile.tabAccount" },
  { id: "preferences", icon: "sliders", labelKey: "profile.tabPreferences" },
  { id: "ma-liste", icon: "bookmark", labelKey: "profile.tabMyList" },
  { id: "communaute", icon: "users", labelKey: "profile.tabCommunity" },
];
const TAB_IDS = TABS.map((tab) => tab.id);

// NOUVEAU (repris de la maquette HTML) : page Profil séparée de Ma liste —
// le Projet A regroupait avant migration les réglages (notifications,
// plateformes favorites, genres exclus) directement dans MyList.jsx.
export default function ProfilePage() {
  const { t } = useTranslation();
  useDocumentTitle(t("pageTitle.profile"));
  const { status } = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tab: Tab = TAB_IDS.includes(requestedTab as Tab) ? (requestedTab as Tab) : "compte";
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  // Onglets déjà ouverts : gardés montés (masqués) pour qu'y revenir
  // n'affiche pas de nouveau « Chargement… » ni de contenu qui se décale
  // pendant qu'il recharge (retour de review).
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set([tab]));
  if (!visited.has(tab)) {
    setVisited(new Set([...visited, tab]));
  }

  function selectTab(next: Tab) {
    setSearchParams(next === "compte" ? {} : { tab: next });
  }

  // Flèches ←/→ (et Début/Fin) : onglet voisin, sélectionné et focalisé
  // (modèle « tablist » WAI-ARIA, un seul onglet dans l'ordre de tabulation).
  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, current: Tab) {
    const index = TAB_IDS.indexOf(current);
    const next =
      e.key === "ArrowRight"
        ? TAB_IDS[(index + 1) % TAB_IDS.length]
        : e.key === "ArrowLeft"
          ? TAB_IDS[(index - 1 + TAB_IDS.length) % TAB_IDS.length]
          : e.key === "Home"
            ? TAB_IDS[0]
            : e.key === "End"
              ? TAB_IDS[TAB_IDS.length - 1]
              : null;
    if (!next) {
      return;
    }
    e.preventDefault();
    selectTab(next);
    tabRefs.current.get(next)?.focus();
  }

  // Profil privé : « Voir mon profil public » mène au réglage « Lien
  // public » de l'onglet Compte (affiché au rendu suivant si on était
  // sur un autre onglet).
  function openPublicLinkSetting() {
    selectTab("compte");
    setTimeout(() => {
      document
        .getElementById(PUBLIC_LINK_ANCHOR)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  function renderPanel(id: Tab) {
    switch (id) {
      case "compte":
        return (
          <div className={styles.settings}>
            <AccountSettings />
            <PublicProfileSettings />
          </div>
        );
      // Nouvelle DA 8/10 : tout ce qui décrit le comportement de l'app
      // (recommandations, notifications, affichage), présenté en groupes et
      // en lignes comme l'onglet Compte.
      case "preferences":
        return (
          <div className={styles.settings}>
            <SettingsGroup
              title={t("profile.recommendations")}
              description={t("profile.recommendationsLead")}
            >
              <FavoriteProvidersSettings />
              <FavoriteLanguagesSettings />
              <FavoriteCountriesSettings />
              <ExcludedGenresSettings />
              <ExcludedTitlesSettings />
            </SettingsGroup>

            <SettingsGroup
              title={t("profile.notifications")}
              description={t("profile.notificationsLead")}
            >
              <NotificationSettings />
            </SettingsGroup>

            <SettingsGroup title={t("profile.display")} description={t("profile.displayLead")}>
              <LanguageSettings />
              <RegionSettings />
              <ThemeSettings />
            </SettingsGroup>
          </div>
        );
      case "communaute":
        return (
          <section className={styles.section}>
            <CommunityPanel />
          </section>
        );
      case "ma-liste":
        return (
          <section className={styles.section}>
            <MyListContent />
          </section>
        );
    }
  }

  // Page réservée aux membres connectés : un visiteur anonyme est envoyé sur
  // /connexion, qui le ramène sur l'onglet demandé une fois connecté.
  if (status === "loading") {
    return <Loading />;
  }
  if (status === "anonymous") {
    return (
      <Navigate to="/connexion" replace state={{ from: location.pathname + location.search }} />
    );
  }

  return (
    <div className={styles.page}>
      <ProfileHeader onOpenPublicLinkSetting={openPublicLinkSetting} />

      {/* Onglets soulignés : une ligne de 4 colonnes égales, collée sous
          l'en-tête au défilement sur mobile. */}
      <div className={styles.tabs} role="tablist" aria-label={t("profile.tabsLabel")}>
        {TABS.map(({ id, icon, labelKey }) => (
          <button
            key={id}
            ref={(el) => {
              if (el) {
                tabRefs.current.set(id, el);
              } else {
                tabRefs.current.delete(id);
              }
            }}
            type="button"
            role="tab"
            id={`profile-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`profile-tabpanel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={`${styles.tab} ${tab === id ? styles.tabActive : ""}`}
            onClick={() => selectTab(id)}
            onKeyDown={(e) => onTabKeyDown(e, id)}
          >
            <Icon name={icon} size={18} className={styles.tabIcon} />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </div>

      {/* Audit M15 : sur mobile, la barre légale flottante (LegalLinks) est
          masquée et le pied de page global n'est jamais atteint sur les
          pages à défilement infini — ce lien, lui, reste à portée de main
          dès l'arrivée sur le Profil (juste sous les onglets), sans avoir à
          dérouler tout le contenu des réglages pour l'atteindre. */}
      <p className={styles.legalLine}>
        <Link to="/conditions-utilisation">{t("legalLinks.terms")}</Link>
        <span aria-hidden="true"> · </span>
        <Link to="/confidentialite">{t("legalLinks.privacy")}</Link>
      </p>

      {TABS.filter(({ id }) => visited.has(id)).map(({ id }) => (
        <div
          key={id}
          id={`profile-tabpanel-${id}`}
          role="tabpanel"
          aria-labelledby={`profile-tab-${id}`}
          hidden={tab !== id}
        >
          {renderPanel(id)}
        </div>
      ))}
    </div>
  );
}
