import { useEffect, useState } from "react";

// Connexion avec Google / Apple (voir worker/oauth.ts). Les fournisseurs
// proposés dépendent de la configuration du Worker : aucun en dev local ni
// sur les previews sans identifiants, d'où la liste demandée au serveur.
export type OAuthProvider = "google" | "apple";

export const OAUTH_PROVIDER_NAMES: Record<OAuthProvider, string> = {
  google: "Google",
  apple: "Apple",
};

let providersRequest: Promise<OAuthProvider[]> | null = null;

// Une seule requête par chargement de page (la liste ne change qu'au
// déploiement) ; un échec réseau laisse simplement les boutons masqués.
function fetchOAuthProviders(): Promise<OAuthProvider[]> {
  providersRequest ??= fetch("/api/auth/providers")
    .then((res) => (res.ok ? res.json() : { providers: [] }))
    .then((data: { providers?: OAuthProvider[] }) => data.providers ?? [])
    .catch(() => {
      providersRequest = null;
      return [];
    });
  return providersRequest;
}

export function useOAuthProviders(): OAuthProvider[] {
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  useEffect(() => {
    let active = true;
    fetchOAuthProviders().then((list) => active && setProviders(list));
    return () => {
      active = false;
    };
  }, []);
  return providers;
}

// Navigation complète (pas un fetch) : le Worker redirige vers le
// fournisseur, qui revient sur /auth/verify (connexion) ou /profil
// (association).
export function oauthStartUrl(
  provider: OAuthProvider,
  mode: "login" | "link",
  returnTo?: string | null
): string {
  const params = new URLSearchParams({ provider, mode });
  if (returnTo) {
    params.set("returnTo", returnTo);
  }
  return `/api/auth/oauth/start?${params}`;
}

// Chemin interne uniquement, comme sanitizeReturnTo côté Worker.
export function safeInternalPath(value: string | null | undefined): string | null {
  return value && /^\/(?![/\\])/.test(value) ? value : null;
}
