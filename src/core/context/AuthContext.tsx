import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { getRecaptchaToken } from "../lib/recaptcha.ts";
import { clearAccountDataFromDevice } from "../lib/accountStorage.ts";
import { clearAuthHintCookie, hasAuthHintCookie } from "../lib/authHintCookie.ts";
import { useLocale } from "./LocaleContext.tsx";
import { syncClientHeaders, useLiveSyncConnection, useLiveSyncEvent } from "../sync/liveSync.ts";
import { usePushAccountLink } from "../sync/pushAccountLink.ts";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

interface RequestLinkResult {
  ok: true;
  devLink?: string;
  devCode?: string;
}

interface EmailChangeRequestResult {
  ok: true;
  email: string;
  devCode?: string;
}

interface VerifyResult {
  ok: true;
  email: string;
}

interface AuthContextValue {
  status: AuthStatus;
  email: string | null;
  // Nom affiché (ticket #45) : source de vérité côté D1 (colonne
  // users.display_name), chargé avec le reste de la session via
  // /api/auth/me. `null` tant qu'aucune valeur n'a jamais été enregistrée.
  displayName: string | null;
  // Slug du lien de partage public du profil (/u/<slug>), `null` tant que
  // le profil est privé — voir ProfileShareCard.
  shareSlug: string | null;
  // Pseudo public unique (users.username), `null` tant qu'aucun n'a été
  // choisi. Quand il existe, le lien de partage du profil devient
  // /u/<pseudo> au lieu de /u/<shareSlug>.
  username: string | null;
  // Version (date de mise à jour) de la photo de profil personnelle, `null`
  // sans photo : l'avatar retombe alors sur Gravatar, puis sur l'initiale.
  avatarVersion: number | null;
  requestLink: (email: string) => Promise<RequestLinkResult>;
  verify: (token: string) => Promise<VerifyResult>;
  verifyCode: (email: string, code: string) => Promise<VerifyResult>;
  logout: () => Promise<void>;
  // Déconnecte tous les appareils du compte, celui-ci compris (audit M1).
  logoutAll: () => Promise<void>;
  // Enregistre le nom affiché côté serveur (save manuel, pas de synchro
  // automatique — voir AccountCard) et met à jour l'état local à l'identique.
  updateDisplayName: (displayName: string) => Promise<void>;
  // Active/désactive le partage public du profil ; désactiver invalide
  // définitivement le lien existant.
  setProfileShared: (enabled: boolean) => Promise<void>;
  // Changement d'adresse email en deux temps (voir AccountCard) : un code
  // est envoyé à la nouvelle adresse, puis sa saisie applique le changement.
  requestEmailChange: (newEmail: string) => Promise<EmailChangeRequestResult>;
  confirmEmailChange: (code: string) => Promise<void>;
  // Enregistre (ou retire, avec une chaîne vide) le pseudo ; rejette avec un
  // message lisible s'il est invalide ou déjà pris.
  updateUsername: (username: string) => Promise<void>;
  // Vérification indicative pendant la saisie (le PUT refait la vérification).
  checkUsername: (username: string, signal?: AbortSignal) => Promise<UsernameCheck>;
  // Remplace ou supprime la photo de profil personnelle.
  uploadAvatar: (image: Blob) => Promise<void>;
  removeAvatar: () => Promise<void>;
  // Suppression définitive du compte et de toutes ses données (audit M14,
  // ticket RGPD). La confirmation forte (saisie de l'adresse e-mail) se
  // fait côté appelant (voir AccountSettings) ; cet appel exécute la
  // suppression sans autre garde que la session déjà ouverte.
  deleteAccount: () => Promise<void>;
}

export interface UsernameCheck {
  // Pseudo normalisé (minuscules, sans « @ »), `null` si invalide.
  username: string | null;
  available: boolean;
  reason: "invalid" | "taken" | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Toutes les routes /api/* sont servies par le même Worker que l'app (même
// origine), donc les cookies de session partent automatiquement avec
// `credentials: "same-origin"` (comportement par défaut de fetch) — pas
// besoin de `credentials: "include"` ni de gestion CORS.

// Plus rien du compte ne doit rester dans le navigateur : on efface les
// données stockées puis on recharge l'app sur l'accueil, ce qui vide aussi
// l'état gardé en mémoire par les contextes (bibliothèque, listes, réglages)
// — sans quoi leurs effets de persistance le réécriraient dans localStorage
// au prochain changement.
function leaveAccount(): void {
  clearAccountDataFromDevice();
  window.location.replace("/");
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  // Sans cookie compagnon, le visiteur est anonyme dès le premier rendu :
  // pas de passage par "loading" (et donc pas d'interface qui change
  // d'aspect au rechargement). Avec, "loading" le temps de /api/auth/me.
  const [status, setStatus] = useState<AuthStatus>(() =>
    hasAuthHintCookie() ? "loading" : "anonymous"
  );
  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [shareSlug, setShareSlug] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [avatarVersion, setAvatarVersion] = useState<number | null>(null);

  // `verify()` (consommation du jeton sur /auth/verify) et `refresh()` (la
  // vérification passive "suis-je déjà connecté" au montage) peuvent
  // toutes les deux vouloir mettre à jour ce state autour du même
  // chargement de page. Les effets des composants enfants (VerifyAuth) se
  // déclenchent avant ceux de leur parent (AuthProvider) au montage, donc
  // le refresh() passif part AVANT que le cookie de session ne soit posé
  // par verify() — sans garde, sa réponse 401 écraserait ensuite le
  // résultat pourtant correct de verify() en arrivant après lui. Dès que
  // verify() réussit, on "épingle" l'état authentifié : refresh() ne peut
  // plus le rétrograder (mais reste libre de le faire progresser depuis
  // "loading", au cas où verify() échoue et qu'on retombe sur une session
  // déjà valide par ailleurs).
  const pinnedRef = useRef(false);

  const refresh = useCallback(() => {
    // Évite l'appel réseau pour tout visiteur qui n'a jamais eu de session
    // (dont l'intégralité du trafic anonyme et des crawlers/bots — voir
    // worker/auth.ts, AUTH_HINT_COOKIE) : sans ce cookie compagnon, une
    // réponse 401 est de toute façon garantie.
    if (!pinnedRef.current && !hasAuthHintCookie()) {
      setEmail(null);
      setDisplayName(null);
      setShareSlug(null);
      setUsername(null);
      setAvatarVersion(null);
      setStatus("anonymous");
      return Promise.resolve();
    }
    return fetch("/api/auth/me")
      .then((res) => {
        if (!res.ok) {
          throw new Error("not authenticated");
        }
        return res.json() as Promise<{
          email: string;
          displayName: string | null;
          shareSlug: string | null;
          username: string | null;
          avatarVersion: number | null;
        }>;
      })
      .then((data) => {
        setEmail(data.email);
        setDisplayName(data.displayName ?? null);
        setShareSlug(data.shareSlug ?? null);
        setUsername(data.username ?? null);
        setAvatarVersion(data.avatarVersion ?? null);
        setStatus("authenticated");
        pinnedRef.current = true;
      })
      .catch(() => {
        if (pinnedRef.current) {
          return;
        }
        setEmail(null);
        setDisplayName(null);
        setShareSlug(null);
        setUsername(null);
        setAvatarVersion(null);
        setStatus("anonymous");
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Sessions révoquées depuis un autre appareil (« tous les appareils »,
  // changement d'email) : la WebSocket est fermée par le serveur. Si la
  // session de cet appareil ne vaut plus rien, on quitte le compte comme
  // pour une déconnexion ; sinon la synchro reprend.
  const handleSessionRevoked = useCallback(async (): Promise<boolean> => {
    const res = await fetch("/api/auth/me").catch(() => null);
    if (res?.status === 401) {
      pinnedRef.current = false;
      // Cookie compagnon (pas HttpOnly) : le serveur n'a pas pu l'effacer ici.
      clearAuthHintCookie();
      leaveAccount();
      return false;
    }
    return true;
  }, []);

  // Synchro temps réel entre appareils du compte (voir core/sync/liveSync.ts) :
  // ouverte ici, une seule fois pour toute l'app. Le nom affiché modifié
  // depuis un autre appareil est rechargé via /api/auth/me.
  useLiveSyncConnection(status === "authenticated", handleSessionRevoked);
  useLiveSyncEvent("display-name", () => {
    refresh();
  });
  // Notifications : rattache/détache l'abonnement push de l'appareil au
  // compte à chaque connexion/déconnexion (voir core/sync/pushAccountLink.ts).
  usePushAccountLink(status);

  // Demande un lien de connexion par email. Renvoie la réponse du serveur
  // (peut contenir `devLink` en local sans service d'email configuré).
  const requestLink = useCallback(
    async (emailToSend: string): Promise<RequestLinkResult> => {
      const recaptchaToken = await getRecaptchaToken("request_link");
      const res = await fetch("/api/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: emailToSend, recaptchaToken, locale }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || t("auth.requestLinkError"));
      }
      return data;
    },
    [locale, t]
  );

  // Consomme le jeton (lien cliqué) ou le code (saisi à la main — voir
  // Login, utile quand le lien s'ouvre dans le navigateur au lieu de
  // l'app installée sur l'écran d'accueil, notamment sur iOS) et établit
  // la session.
  const verifyWith = useCallback(
    async (
      body: { token?: string; code?: string; email?: string },
      fallbackError: string
    ): Promise<VerifyResult> => {
      const recaptchaToken = await getRecaptchaToken("verify");
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, recaptchaToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || fallbackError);
      }
      pinnedRef.current = true;
      setEmail(data.email);
      setDisplayName(data.displayName ?? null);
      setShareSlug(data.shareSlug ?? null);
      setUsername(data.username ?? null);
      setAvatarVersion(data.avatarVersion ?? null);
      setStatus("authenticated");
      return data;
    },
    []
  );

  const verify = useCallback(
    (token: string) => verifyWith({ token }, t("auth.verify.expiredLink")),
    [verifyWith, t]
  );

  // L'adresse accompagne le code : le serveur n'accepte un code que pour
  // l'adresse à laquelle il a été envoyé (audit M2).
  const verifyCode = useCallback(
    (email: string, code: string) => verifyWith({ email, code }, t("auth.verify.expiredCode")),
    [verifyWith, t]
  );

  const logout = useCallback(async () => {
    pinnedRef.current = false;
    await fetch("/api/auth/logout", { method: "POST", headers: syncClientHeaders() }).catch(
      () => {}
    );
    leaveAccount();
  }, []);

  // Si l'appel échoue, rien n'est effacé : l'erreur remonte au bouton.
  const logoutAll = useCallback(async () => {
    const res = await fetch("/api/auth/logout-all", { method: "POST" });
    if (!res.ok) {
      throw new Error(t("accountCard.logoutAllError"));
    }
    pinnedRef.current = false;
    leaveAccount();
  }, [t]);

  // Save manuel uniquement (voir AccountCard, bouton "Enregistrer") : pas de
  // synchro automatique/temps réel — décision produit explicite pour le
  // ticket #45.
  const updateDisplayNameCallback = useCallback(
    async (newDisplayName: string): Promise<void> => {
      const res = await fetch("/api/account/display-name", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...syncClientHeaders() },
        body: JSON.stringify({ displayName: newDisplayName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || t("auth.updateDisplayNameError"));
      }
      setDisplayName(data.displayName);
    },
    [t]
  );

  const setProfileShared = useCallback(
    async (enabled: boolean): Promise<void> => {
      const res = await fetch("/api/account/share", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || t("auth.updateShareError"));
      }
      setShareSlug(data.shareSlug ?? null);
    },
    [t]
  );

  // Photo de profil personnelle : `image` est déjà recadrée et compressée
  // (voir shared/lib/avatarImage.ts), elle part telle quelle en corps.
  const uploadAvatar = useCallback(
    async (image: Blob): Promise<void> => {
      const res = await fetch("/api/account/avatar", {
        method: "PUT",
        headers: { "content-type": image.type || "image/webp", ...syncClientHeaders() },
        body: image,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          res.status === 413 ? t("auth.avatarTooLarge") : data.error || t("auth.avatarError")
        );
      }
      setAvatarVersion(data.avatarVersion ?? null);
    },
    [t]
  );

  const removeAvatar = useCallback(async (): Promise<void> => {
    const res = await fetch("/api/account/avatar", {
      method: "DELETE",
      headers: syncClientHeaders(),
    });
    if (!res.ok) {
      throw new Error(t("auth.avatarError"));
    }
    setAvatarVersion(null);
  }, [t]);

  const requestEmailChange = useCallback(
    async (newEmail: string): Promise<EmailChangeRequestResult> => {
      const res = await fetch("/api/account/email/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: newEmail, locale }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(emailChangeErrorMessage(t, data, res.status));
      }
      return data;
    },
    [locale, t]
  );

  const confirmEmailChange = useCallback(
    async (code: string): Promise<void> => {
      const res = await fetch("/api/account/email/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", ...syncClientHeaders() },
        body: JSON.stringify({ code, locale }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(emailChangeErrorMessage(t, data, res.status));
      }
      setEmail(data.email);
    },
    [locale, t]
  );

  const updateUsername = useCallback(
    async (newUsername: string): Promise<void> => {
      const res = await fetch("/api/account/username", {
        method: "PUT",
        headers: { "content-type": "application/json", ...syncClientHeaders() },
        body: JSON.stringify({ username: newUsername }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data.reason === "taken"
            ? t("auth.usernameTaken")
            : data.reason === "invalid"
              ? t("auth.usernameInvalid")
              : data.error || t("auth.updateUsernameError")
        );
      }
      setUsername(data.username ?? null);
    },
    [t]
  );

  const checkUsername = useCallback(
    async (candidate: string, signal?: AbortSignal): Promise<UsernameCheck> => {
      const res = await fetch(
        `/api/account/username/availability?username=${encodeURIComponent(candidate)}`,
        { signal }
      );
      if (!res.ok) {
        throw new Error(t("auth.updateUsernameError"));
      }
      return (await res.json()) as UsernameCheck;
    },
    [t]
  );

  // Si l'appel échoue, rien n'est effacé : l'erreur remonte au bouton, comme
  // logoutAll ci-dessus.
  const deleteAccount = useCallback(async () => {
    const res = await fetch("/api/account", { method: "DELETE", headers: syncClientHeaders() });
    if (!res.ok) {
      throw new Error(t("accountCard.deleteAccountError"));
    }
    pinnedRef.current = false;
    leaveAccount();
  }, [t]);

  // Audit H9 (fichiers concernés) : sans ce useMemo, un nouvel objet était
  // recréé à chaque rendu du Provider, donc tout consommateur de useAuth()
  // se re-rendait même quand aucun des champs lus ne changeait réellement.
  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      email,
      displayName,
      shareSlug,
      username,
      avatarVersion,
      requestLink,
      verify,
      verifyCode,
      logout,
      logoutAll,
      updateDisplayName: updateDisplayNameCallback,
      setProfileShared,
      requestEmailChange,
      confirmEmailChange,
      updateUsername,
      checkUsername,
      uploadAvatar,
      removeAvatar,
      deleteAccount,
    }),
    [
      status,
      email,
      displayName,
      shareSlug,
      username,
      avatarVersion,
      requestLink,
      verify,
      verifyCode,
      logout,
      logoutAll,
      updateDisplayNameCallback,
      setProfileShared,
      requestEmailChange,
      confirmEmailChange,
      updateUsername,
      checkUsername,
      uploadAvatar,
      removeAvatar,
      deleteAccount,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Les messages d'erreur du Worker sont en français : on les traduit côté
// client à partir du `reason` (ou du statut HTTP) qu'il renvoie.
function emailChangeErrorMessage(
  t: (key: string, options?: Record<string, unknown>) => string,
  data: { reason?: unknown; retryAfter?: unknown },
  status: number
): string {
  const { reason, retryAfter } = data;
  if (
    reason === "invalid" ||
    reason === "same" ||
    reason === "taken" ||
    reason === "invalid-code"
  ) {
    return t(`accountCard.emailChange.errors.${reason}`);
  }
  if (status === 429) {
    // Délai exact renvoyé par le Worker (fin de la fenêtre de limitation).
    if (typeof retryAfter === "number" && retryAfter > 0) {
      return retryAfter < 60
        ? t("accountCard.emailChange.errors.rateLimitedSeconds", { count: retryAfter })
        : t("accountCard.emailChange.errors.rateLimitedMinutes", {
            count: Math.ceil(retryAfter / 60),
          });
    }
    return t("accountCard.emailChange.errors.rateLimited");
  }
  return t("accountCard.emailChange.errors.generic");
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth doit être utilisé dans un AuthProvider");
  }
  return ctx;
}
