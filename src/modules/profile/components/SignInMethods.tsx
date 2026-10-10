import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { OAUTH_PROVIDER_NAMES, oauthStartUrl, type OAuthProvider } from "../../auth/oauth.ts";
import ProviderLogo from "../../auth/ProviderLogo.tsx";
import { Icon } from "../../../shared/components/index.ts";
import { SettingsRow } from "./SettingsGroup.tsx";
import styles from "./AccountSettings.module.css";

interface Identity {
  provider: OAuthProvider;
  email: string | null;
}

// Moyens de connexion du compte (ticket « Option de connexion ») : le lien
// magique reste toujours actif, Google / Apple s'y ajoutent ou s'en retirent
// ici. Ligne masquée tant qu'aucun fournisseur n'est configuré ni associé.
export default function SignInMethods() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Retour d'une association lancée d'ici (voir handleOAuthCallback dans
  // worker/index.ts), lu une seule fois puis retiré de l'URL.
  const [result] = useState(() => searchParams.get("oauth"));
  const [resultProvider] = useState(() => searchParams.get("provider") as OAuthProvider | null);

  useEffect(() => {
    if (searchParams.has("oauth")) {
      const next = new URLSearchParams(searchParams);
      next.delete("oauth");
      next.delete("provider");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/account/identities")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { identities: Identity[]; providers: OAuthProvider[] } | null) => {
        if (active && data) {
          setIdentities(data.identities);
          setProviders(data.providers);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function unlink(provider: OAuthProvider) {
    setBusy(provider);
    setError(null);
    try {
      const res = await fetch(`/api/account/identities?provider=${provider}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error();
      }
      setIdentities((list) => list.filter((identity) => identity.provider !== provider));
    } catch {
      setError(t("accountCard.signInMethods.unlinkError"));
    } finally {
      setBusy(null);
    }
  }

  const shown = [
    ...new Set<OAuthProvider>([...providers, ...identities.map((identity) => identity.provider)]),
  ];
  if (shown.length === 0) {
    return null;
  }

  return (
    <SettingsRow
      label={t("accountCard.signInMethods.title")}
      description={t("accountCard.signInMethods.hint")}
    >
      <ul className={styles.methods}>
        <li className={styles.method}>
          <span className={styles.methodIcon}>
            <Icon name="mail" size={18} />
          </span>
          <span className={styles.methodText}>
            <strong>{t("accountCard.signInMethods.magicLink")}</strong>
            <span className={styles.mutedHint}>{t("accountCard.signInMethods.alwaysOn")}</span>
          </span>
        </li>
        {shown.map((provider) => {
          const identity = identities.find((item) => item.provider === provider);
          const name = OAUTH_PROVIDER_NAMES[provider];
          return (
            <li key={provider} className={styles.method}>
              <span className={styles.methodIcon}>
                <ProviderLogo provider={provider} />
              </span>
              <span className={styles.methodText}>
                <strong>{name}</strong>
                <span className={styles.mutedHint}>
                  {identity
                    ? identity.email || t("accountCard.signInMethods.linked")
                    : t("accountCard.signInMethods.notLinked")}
                </span>
              </span>
              {identity ? (
                <button
                  type="button"
                  className={styles.ghostBtn}
                  onClick={() => unlink(provider)}
                  disabled={busy !== null}
                  aria-label={t("accountCard.signInMethods.unlinkLabel", { provider: name })}
                >
                  {t("accountCard.signInMethods.unlink")}
                </button>
              ) : (
                providers.includes(provider) && (
                  <a
                    className={styles.secondaryBtn}
                    href={oauthStartUrl(provider, "link")}
                    aria-label={t("accountCard.signInMethods.linkLabel", { provider: name })}
                  >
                    {t("accountCard.signInMethods.link")}
                  </a>
                )
              )}
            </li>
          );
        })}
      </ul>
      {result && (
        <p
          className={result === "linked" ? styles.okHint : styles.errorHint}
          role={result === "linked" ? "status" : "alert"}
        >
          {t(`accountCard.signInMethods.results.${result}`, {
            provider: resultProvider ? OAUTH_PROVIDER_NAMES[resultProvider] : "",
            defaultValue: t("accountCard.signInMethods.results.failed"),
          })}
        </p>
      )}
      {error && <p className={styles.errorHint}>{error}</p>}
    </SettingsRow>
  );
}
