// Espace admin sur son propre Worker (`seancy-admin`, wrangler.admin.jsonc),
// mis en ligne à chaque fusion dans develop : ses retouches n'attendent plus
// une release du site.
//
// Partage des rôles entre les deux Workers (liés par service binding) :
// - `seancy-admin` (env.ADMIN_WORKER, env.SITE) sert admin.seancy.com et
//   traite lui-même l'API de l'admin et celle des tickets (adminOwned) ; tout
//   le reste (connexion, outils qui lancent les traitements du site, clé
//   publique des notifications…) est renvoyé au Worker du site, qui garde les
//   secrets du site. Ce qui demande un secret du site passe par une adresse
//   interne (INTERNAL_HOSTNAME) : notifications aux administrateurs, état des
//   réglages du site.
// - `seancy` (env.ADMIN) renvoie au Worker admin l'API de l'admin et des
//   tickets reçue sur ses adresses de production (forwardToAdmin) : le NAS,
//   les workflows et les scripts gardent leurs adresses. Les previews de PR
//   gardent leur propre admin, sur leur base de preview.
// Jamais de boucle : le site ne renvoie que ce que l'admin traite, l'admin ne
// renvoie que le reste.
// Logique pure : vérifiée par scripts/verify-admin-split.ts.
import {
  ADMIN_HOSTNAME,
  PRODUCTION_HOSTNAME,
  REDIRECTED_TO_PRODUCTION_HOSTNAMES,
} from "./hostnames.ts";

/**
 * Nom d'hôte des appels du Worker admin au Worker du site (service binding).
 * Aucune requête venue d'Internet ne peut porter ce nom : Cloudflare
 * n'achemine vers le Worker que ses propres domaines.
 */
export const INTERNAL_HOSTNAME = "seancy.internal";

/** Routes traitées par le Worker admin : API de l'admin (sauf les outils, qui lancent les traitements du site) et des tickets. */
export function adminOwned(pathname: string): boolean {
  if (/^\/api\/tickets(\/|$)/.test(pathname)) {
    return true;
  }
  return /^\/api\/admin(\/|$)/.test(pathname) && !/^\/api\/admin\/tools(\/|$)/.test(pathname);
}

/** Côté site : requête à passer au Worker admin (adresses de production seulement). */
export function forwardToAdmin(hostname: string, pathname: string): boolean {
  return (
    adminOwned(pathname) &&
    (hostname === PRODUCTION_HOSTNAME ||
      hostname === ADMIN_HOSTNAME ||
      REDIRECTED_TO_PRODUCTION_HOSTNAMES.includes(hostname))
  );
}

/** Côté Worker admin : « site » (renvoyée au Worker du site), « assets » (page de l'admin) ou « self » (traitée ici). */
export function adminWorkerRoute(pathname: string): "site" | "assets" | "self" {
  if (!pathname.startsWith("/api/")) {
    return "assets";
  }
  return adminOwned(pathname) ? "self" : "site";
}
