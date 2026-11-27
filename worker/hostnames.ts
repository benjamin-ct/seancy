// Adresses du site et de l'espace admin : sans aucune dépendance, pour être lues
// aussi par les scripts de vérification (voir worker/admin-split.ts).
export const PRODUCTION_HOSTNAME = "seancy.com";
// Autres adresses du Worker `seancy` qui ne doivent jamais servir le site :
// tout y part en 301 vers PRODUCTION_HOSTNAME, /api compris (voir index.ts ;
// les pages, servies en assets sans passer par le Worker, sont redirigées
// côté client par src/core/lib/legacyOriginRedirect.ts). Pour www, il suffit
// d'ajouter www.seancy.com en domaine personnalisé du Worker.
export const REDIRECTED_TO_PRODUCTION_HOSTNAMES: readonly string[] = [
  "www.seancy.com",
  "seancy.creusatbenjamin.workers.dev",
];

// Espace admin (voir worker/admin.ts) : même Worker, domaine à part derrière
// Cloudflare Access. Compté comme la prod partout où le domaine décide d'un
// comportement de dev (identifiants de connexion renvoyés dans la réponse,
// outils de validation des previews…), mais jamais indexé (voir page-meta.ts).
export const ADMIN_HOSTNAME = "admin.seancy.com";

export function isProductionHostname(hostname: string): boolean {
  return hostname === PRODUCTION_HOSTNAME || hostname === ADMIN_HOSTNAME;
}

// Hostname de l'environnement `develop` persistant : le Worker dédié
// `seancy-develop`, déployé par le job deploy-develop de la CI (voir README).
export const PREPROD_HOSTNAME = "seancy-develop.creusatbenjamin.workers.dev";
