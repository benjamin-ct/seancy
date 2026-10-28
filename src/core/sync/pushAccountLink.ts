// Rattachement de l'abonnement push de cet appareil au compte qui y est
// connecté (voir worker/index.ts, handleLinkSubscriptionAccount) : c'est ce
// qui permet au serveur de livrer les notifications du compte en in-app via
// le hub temps réel quand un appareil est connecté, et de ne plus pousser
// celles du compte vers un appareil qui s'en est déconnecté.
import { useEffect } from "react";
import { logWarn } from "../logger.ts";
import type { AuthStatus } from "../context/AuthContext.tsx";
import { storageGet, storageSet } from "../../shared/lib/storage.ts";

// Endpoint de l'abonnement push de cet appareil, posé par NotificationSettings
// à l'activation des notifications.
export const PUSH_ENDPOINT_STORAGE_KEY = "seancy.push.endpoint";
// Dernier état de rattachement confirmé par le serveur ("1" connecté, "0"
// anonyme) : évite un appel à chaque chargement de page quand rien n'a changé.
const LINKED_STORAGE_KEY = "seancy.push.linkedAccount";

export function usePushAccountLink(status: AuthStatus): void {
  useEffect(() => {
    if (status === "loading") {
      return;
    }
    const endpoint = storageGet(PUSH_ENDPOINT_STORAGE_KEY);
    const desired = status === "authenticated" ? "1" : "0";
    if (!endpoint || storageGet(LINKED_STORAGE_KEY) === desired) {
      return;
    }
    fetch("/api/subscribe/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    })
      .then((res) => {
        if (res.ok) {
          storageSet(LINKED_STORAGE_KEY, desired);
        }
      })
      .catch((err) => logWarn("Seancy : rattachement des notifications au compte échoué.", err));
  }, [status]);
}
