import { useTranslation } from "react-i18next";
import { OAUTH_PROVIDER_NAMES, oauthStartUrl, useOAuthProviders } from "./oauth.ts";
import ProviderLogo from "./ProviderLogo.tsx";
import styles from "./AuthPages.module.css";

// Boutons « Continuer avec Google / Apple » au-dessus du formulaire du lien
// magique ; rien du tout tant qu'aucun fournisseur n'est configuré.
export default function OAuthButtons({ returnTo }: { returnTo?: string | null }) {
  const { t } = useTranslation();
  const providers = useOAuthProviders();
  if (providers.length === 0) {
    return null;
  }
  return (
    <div className={styles.oauth}>
      {providers.map((provider) => (
        <a
          key={provider}
          className={`${styles.oauthBtn} ${provider === "apple" ? styles.oauthApple : ""}`}
          href={oauthStartUrl(provider, "login", returnTo)}
        >
          <ProviderLogo provider={provider} />
          {t("loginPage.continueWith", { provider: OAUTH_PROVIDER_NAMES[provider] })}
        </a>
      ))}
      <p className={styles.oauthSeparator}>
        <span>{t("loginPage.orEmail")}</span>
      </p>
    </div>
  );
}
