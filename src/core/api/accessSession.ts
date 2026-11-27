// Session Cloudflare Access expirée : l'app est protégée par Access, dont le
// cookie (CF_Authorization) expire indépendamment de notre session. La page
// d'accueil peut pourtant encore s'afficher, servie par le précache du
// service worker (src/sw.ts) sans passer par le réseau. Chaque appel /api/...
// est alors redirigé par Access vers sa page de connexion, sur un autre
// domaine : le navigateur bloque la redirection (CORS) et fetch échoue avec
// un simple « Failed to fetch » / « Load failed », sans rien de plus.
//
// Ici, sur une erreur réseau, on vérifie si c'est ce cas (redirection au lieu
// d'une réponse) et, si oui, on renvoie la page vers Access pour se
// reconnecter, qui ramène ensuite sur la même page.

// Paramètre ajouté à l'URL pour forcer une vraie navigation réseau : le
// service worker ne sert pas une URL qui le porte (liste d'exclusion de sa
// route de navigation, src/sw.ts). Retiré au retour.
const REAUTH_PARAM = "reauth";
const LAST_REAUTH_KEY = "seancy.lastAccessReauth";
// Garde-fou : jamais deux renvois vers Access en moins d'une minute, pour ne
// pas boucler si la reconnexion échoue.
const REAUTH_COOLDOWN_MS = 60_000;

let probe: Promise<boolean> | null = null;

export function isNetworkError(err: unknown): boolean {
  // fetch ne rejette qu'avec un TypeError, et seulement quand aucune réponse
  // n'a pu être lue (réseau coupé, CORS, redirection bloquée...).
  return err instanceof TypeError;
}

async function accessSessionExpired(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/me", { redirect: "manual", cache: "no-store" });
    return res.type === "opaqueredirect";
  } catch {
    // Vraie coupure réseau : rien à voir avec Access.
    return false;
  }
}

function reauthRecentlyAttempted(): boolean {
  try {
    const last = Number(sessionStorage.getItem(LAST_REAUTH_KEY));
    return Number.isFinite(last) && Date.now() - last < REAUTH_COOLDOWN_MS;
  } catch {
    return false;
  }
}

// Après une erreur réseau : renvoie vers la connexion Access si c'est elle
// qui bloque. Un seul test à la fois, partagé entre les appels qui échouent
// ensemble. Résout à true si la page est en train d'être rechargée.
export function recoverFromAccessExpiry(): Promise<boolean> {
  if (!probe) {
    probe = accessSessionExpired()
      .then((expired) => {
        if (!expired || reauthRecentlyAttempted()) {
          return false;
        }
        try {
          sessionStorage.setItem(LAST_REAUTH_KEY, String(Date.now()));
        } catch {
          // Stockage indisponible (navigation privée...) : on tente quand même.
        }
        const url = new URL(window.location.href);
        url.searchParams.set(REAUTH_PARAM, String(Date.now()));
        window.location.replace(url.toString());
        return true;
      })
      .finally(() => {
        probe = null;
      });
  }
  return probe;
}

// Retire le paramètre de reconnexion de l'URL au retour d'Access.
export function stripReauthParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(REAUTH_PARAM)) {
    return;
  }
  url.searchParams.delete(REAUTH_PARAM);
  window.history.replaceState(window.history.state, "", url.toString());
}
