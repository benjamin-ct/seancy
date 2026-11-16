// Espace admin (voir worker/admin.ts) : son propre domaine, derrière
// Cloudflare Access. Sur ce domaine, l'app affiche l'espace admin à la place
// du site. Ailleurs que sur le site public (previews, dev local), il reste
// joignable sous /admin pour l'essayer. admin.localhost : essais en local.
export const ADMIN_ORIGIN = "https://admin.seancy.com";
const ADMIN_HOSTNAMES = ["admin.seancy.com", "admin.localhost"];
const PUBLIC_HOSTNAME = "seancy.com";

export const isAdminHost = (hostname = window.location.hostname) =>
  ADMIN_HOSTNAMES.includes(hostname);
/** Début des adresses de l'espace admin : « » sur son domaine, « /admin » ailleurs. */
export const adminPrefix = () => (isAdminHost() ? "" : "/admin");
export const isPublicHost = (hostname = window.location.hostname) => hostname === PUBLIC_HOSTNAME;
