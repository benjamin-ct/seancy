import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import { useAuth } from "../../core/context/AuthContext.tsx";
import LoginForm from "./LoginForm.tsx";
import styles from "./AuthPages.module.css";

export default function LoginPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("pageTitle.login"));
  const { status } = useAuth();
  const location = useLocation();
  // Retour d'une connexion Google / Apple qui n'a pas abouti (voir
  // handleOAuthCallback dans worker/index.ts).
  const [searchParams] = useSearchParams();
  const oauthError = searchParams.get("oauth");
  // Page d'origine quand on arrive ici depuis une page réservée aux membres
  // (ex. /profil, voir ProfilePage).
  const from = (location.state as { from?: string } | null)?.from;

  // La redirection se fait ici une fois que le statut d'auth passe à
  // "authenticated" (code validé dans LoginForm, ou session déjà ouverte).
  if (status === "authenticated") {
    return <Navigate to={from?.startsWith("/") ? from : "/profil?tab=ma-liste"} replace />;
  }

  return (
    <div className={styles.page}>
      <h1>{t("loginPage.title")}</h1>
      <p className={styles.subtitle}>{t("loginPage.subtitle")}</p>
      {oauthError && (
        <p className={`${styles.card} ${styles.error}`} role="alert">
          {t(`loginPage.oauthErrors.${oauthError}`, {
            defaultValue: t("loginPage.oauthErrors.failed"),
          })}
        </p>
      )}
      <LoginForm />
    </div>
  );
}
