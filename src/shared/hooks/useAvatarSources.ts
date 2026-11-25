import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../core/context/AuthContext.tsx";
import { gravatarUrl } from "../lib/gravatar.ts";

/**
 * URL de la photo du compte courant : personnelle si elle existe, sinon
 * Gravatar, sinon `null` (à l'appelant de prévoir un repli). Chaque image qui
 * ne charge pas (404 Gravatar, photo supprimée depuis un autre appareil)
 * laisse la place à la suivante via `onError`.
 */
export function useAvatarSources(): { url: string | null; onError: () => void } {
  const { email, avatarVersion } = useAuth();
  const sources = useMemo(
    () =>
      [
        avatarVersion !== null ? `/api/account/avatar?v=${avatarVersion}` : null,
        email ? gravatarUrl(email) : null,
      ].filter((url): url is string => url !== null),
    [email, avatarVersion]
  );
  const [failedCount, setFailedCount] = useState(0);
  // Repart de la première source quand elles changent (nouvelle photo,
  // connexion avec un autre compte), sinon un précédent échec resterait
  // collé.
  useEffect(() => {
    setFailedCount(0);
  }, [sources]);
  return {
    url: sources[failedCount] ?? null,
    onError: () => setFailedCount((n) => n + 1),
  };
}
