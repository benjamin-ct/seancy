// Environnement develop persistant (même adresse que PREPROD_HOSTNAME dans
// worker/hostnames.ts) : logo bleu, titre d'onglet « [Dev] » et lien depuis
// l'espace admin, pour ne jamais le confondre avec la prod. Le favicon, les
// icônes d'écran d'accueil et le nom de l'appli installée y sont remplacés au
// déploiement (voir scripts/develop-assets.ts).
export const DEV_HOSTNAME = "seancy-develop.creusatbenjamin.workers.dev";

export const isDevSite = typeof window !== "undefined" && window.location.hostname === DEV_HOSTNAME;

// Préfixe du titre d'onglet sur develop (même texte que scripts/develop-assets.ts
// met dans le <title> de index.html, avant le chargement de React).
export const DEV_TITLE_PREFIX = "[Dev] ";
