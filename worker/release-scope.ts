// Ce qui attend une release develop → main, et ce qui est déjà en ligne dès la
// fusion dans develop. L'espace admin a son propre Worker (`seancy-admin`,
// wrangler.admin.jsonc), mis en ligne à chaque fusion dans develop par le job
// deploy-admin de la CI, qui applique aussi les migrations sur la base de
// production : une retouche de l'admin ou des tickets n'a donc rien à attendre
// d'une release.
//
// Sert à la carte « Mise en ligne » du tableau de bord (worker/release.ts : un
// commit qui ne touche que l'admin n'est pas compté « pas encore en ligne ») et
// au contrôle des fragments de changelog (scripts/check-changeset.ts : pas de
// fragment pour une PR qui ne touche que l'admin, rien à annoncer sur le site).
//
// Limite connue : worker/admin.ts et worker/tickets.ts exposent aussi au Worker
// du site quelques fonctions (accessGate, isAdminHostname, adminEmails,
// siteConfig, pushAdmins). Une retouche de l'une d'elles ne vaut pour le site
// qu'à la release : ajouter alors un fragment de changelog à la PR.
// Logique pure : vérifiée par scripts/verify-release.ts.

/** Code servi seulement par le Worker de l'admin (page de l'admin et des tickets, leur API). */
const ADMIN_ONLY = [
  /^src\/modules\/(admin|tickets)\//,
  /^worker\/(admin|tickets|tickets-logic|ticket-title|ticket-level|release|release-scope|claude-usage|cloudflare-usage|quota-alerts)\.ts$/,
];

/**
 * Fichiers mis en ligne par la release seulement : le reste du code du site
 * (Worker, pages, service worker, assets), ses dépendances et sa configuration
 * de build, ainsi que les workflows GitHub (ceux des tickets et les tâches
 * planifiées tournent depuis main).
 */
const RELEASE_ONLY = [
  /^src\//,
  /^worker\//,
  /^public\//,
  /^index\.html$/,
  /^package(-lock)?\.json$/,
  /^vite\.config\.ts$/,
  /^tsconfig[^/]*\.json$/,
  /^wrangler\.jsonc$/,
  /^\.github\//,
];

/** Fichier qui n'est mis en ligne qu'à la release develop → main. */
export function needsRelease(path: string): boolean {
  return !ADMIN_ONLY.some((r) => r.test(path)) && RELEASE_ONLY.some((r) => r.test(path));
}

/**
 * Changement (commit ou PR) à mettre en ligne par une release : au moins un de
 * ses fichiers ne l'est qu'ainsi. Sinon (admin, tickets, migrations, outillage,
 * fragments, documentation), il est déjà en ligne ou n'a rien à mettre en ligne.
 */
export function changeNeedsRelease(paths: readonly string[]): boolean {
  return paths.some(needsRelease);
}
