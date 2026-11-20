// Vérification du partage des rôles entre le Worker du site et le Worker de
// l'espace admin (worker/admin-split.ts) : routes traitées par l'admin,
// renvois du site, et jamais de boucle entre les deux. Script autonome, même
// principe que verify-tickets.ts.

import { adminOwned, adminWorkerRoute, forwardToAdmin } from "../worker/admin-split.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    console.log(`     attendu: ${JSON.stringify(expected)}`);
    console.log(`     obtenu : ${JSON.stringify(actual)}`);
  }
  if (ok) {
    passed++;
  } else {
    failed++;
  }
}

const paths = [
  "/api/tickets",
  "/api/tickets/abc/answer",
  "/api/tickets-extra",
  "/api/admin",
  "/api/admin/me",
  "/api/admin/overview",
  "/api/admin/usage",
  "/api/admin/tools/run-check",
  "/api/admin/tools",
  "/api/administration",
  "/api/auth/me",
  "/api/vapid-public-key",
];
check(
  "API traitée par l'admin : tickets et admin, sans les outils (traitements du site)",
  paths.filter(adminOwned),
  [
    "/api/tickets",
    "/api/tickets/abc/answer",
    "/api/admin",
    "/api/admin/me",
    "/api/admin/overview",
    "/api/admin/usage",
  ]
);
check(
  "Worker admin : pages servies par lui, API de l'admin traitée, le reste renvoyé au site",
  ["/", "/tickets/abc", "/api/admin/overview", "/api/admin/tools/run-check", "/api/auth/me"].map(
    adminWorkerRoute
  ),
  ["assets", "assets", "self", "site", "site"]
);
check(
  "Site : renvoie l'API de l'admin et des tickets seulement depuis ses adresses de production",
  [
    ["seancy.com", "/api/admin/me"],
    ["www.seancy.com", "/api/tickets"],
    ["seancy.creusatbenjamin.workers.dev", "/api/tickets/tick"],
    ["admin.seancy.com", "/api/admin/overview"],
    ["develop-seancy.creusatbenjamin.workers.dev", "/api/tickets"],
    ["pr-42-seancy.creusatbenjamin.workers.dev", "/api/admin/me"],
    ["admin.localhost", "/api/admin/me"],
    ["seancy.com", "/api/admin/tools/run-check"],
    ["seancy.com", "/api/auth/me"],
  ].map(([h, p]) => forwardToAdmin(h, p)),
  [true, true, true, true, false, false, false, false, false]
);
// Jamais de boucle : ce que le site renvoie à l'admin, l'admin le traite ; ce que l'admin renvoie au site,
// le site ne le renvoie pas
check(
  "Pas de boucle entre les deux Workers",
  paths.every(
    (p) =>
      !(forwardToAdmin("seancy.com", p) && adminWorkerRoute(p) === "site") &&
      !(adminWorkerRoute(p) === "site" && forwardToAdmin("admin.seancy.com", p))
  ),
  true
);

console.log(`\n${passed} OK, ${failed} en échec`);
process.exit(failed ? 1 : 0);
