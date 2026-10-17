import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import { Loading } from "../../shared/components/index.ts";
import { useAuth } from "../../core/context/AuthContext.tsx";
import SettingsLayout from "./SettingsLayout.tsx";
import AccountPage from "./pages/AccountPage.tsx";
import PrivacyPage from "./pages/PrivacyPage.tsx";
import ProvidersPage from "./pages/ProvidersPage.tsx";
import RecommendationsPage from "./pages/RecommendationsPage.tsx";
import NotificationsPage from "./pages/NotificationsPage.tsx";
import DisplayPage from "./pages/DisplayPage.tsx";
import DataPage from "./pages/DataPage.tsx";
import AboutPage from "./pages/AboutPage.tsx";
import styles from "./SettingsLayout.module.css";

// Desktop uniquement (le panneau détail est masqué sur mobile tant qu'on
// est sur le sommaire, voir SettingsLayout.module.css) : invite à choisir
// une rubrique dans le sommaire visible à gauche.
function SettingsSummaryPlaceholder() {
  const { t } = useTranslation();
  return <p className={styles.placeholder}>{t("settings.pickSection")}</p>;
}

// Page Réglages (refonte Profil/Préférences, carte Trello
// https://trello.com/c/Wym5VQTd) : sommaire + 8 sous-pages, montée sur
// /reglages/* (routing propre au module, voir App.tsx). Réservée aux
// membres connectés, même garde que ProfilePage.
export default function SettingsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("pageTitle.settings"));
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return <Loading />;
  }
  if (status === "anonymous") {
    return (
      <Navigate to="/connexion" replace state={{ from: location.pathname + location.search }} />
    );
  }

  return (
    <Routes>
      <Route element={<SettingsLayout />}>
        <Route index element={<SettingsSummaryPlaceholder />} />
        <Route path="compte" element={<AccountPage />} />
        <Route path="confidentialite" element={<PrivacyPage />} />
        <Route path="plateformes" element={<ProvidersPage />} />
        <Route path="recommandations" element={<RecommendationsPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="affichage" element={<DisplayPage />} />
        <Route path="donnees" element={<DataPage />} />
        <Route path="a-propos" element={<AboutPage />} />
        <Route path="*" element={<Navigate to="/reglages" replace />} />
      </Route>
    </Routes>
  );
}
