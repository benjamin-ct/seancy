// Résout et applique le thème *avant* le premier paint, en lisant le même
// stockage que ThemeContext.tsx (seancy.theme). Sans ça, le <style> du
// loader et le <meta theme-color> d'index.html ne pouvaient se baser que sur
// `prefers-color-scheme` (préférence système) : un choix explicite "clair"
// stocké alors que le système est en sombre (ou l'inverse) provoquait un
// flash du mauvais thème le temps que React se monte et corrige via
// data-theme (signalé sur la carte Trello).
//
// Fichier externe (et non inline dans index.html) : la CSP du Worker
// (`script-src 'self' ...`, voir worker/index.ts et public/_headers) n'inclut
// pas 'unsafe-inline' — un <script> inline y serait silencieusement bloqué.
// Servi en same-origin, ce fichier passe sous 'self' sans changement de CSP.
(function () {
  try {
    var stored = localStorage.getItem("seancy.theme");
    var preference = stored === "light" || stored === "dark" ? stored : "auto";
    var theme =
      preference === "auto"
        ? window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : preference;
    document.documentElement.setAttribute("data-theme", theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", theme === "light" ? "#fbf9f5" : "#0c1a30");
    }
  } catch (e) {
    // localStorage indisponible : repli silencieux sur le thème sombre par
    // défaut déjà posé en dur dans index.html.
  }
})();

// Espace admin (src/modules/admin/AdminApp.tsx) : icônes de l'onglet, de
// l'écran d'accueil et manifeste au ticket doré « ADMIN » (public/admin/),
// et titre de l'onglet de la page, posés ici avant le premier affichage.
// Quand React s'en chargeait une fois l'admin monté, chaque rechargement
// montrait d'abord l'icône et le titre du site, puis ceux de l'admin
// (clignotement de l'onglet). Les pages admin sont le même index.html que le
// site (servi sans le Worker) : rien d'autre ne peut les distinguer avant
// React. Même découpage que src/App.tsx et src/core/lib/adminHost.ts : tout
// le domaine admin, ou /admin ailleurs que sur le site public (develop,
// previews, local ; seancy.com/admin renvoie vers le domaine admin).
(function () {
  try {
    var host = window.location.hostname;
    var path = window.location.pathname;
    var adminHost = host === "admin.seancy.com" || host === "admin.localhost";
    var adminPath = path === "/admin" || path.indexOf("/admin/") === 0;
    if (!adminHost && (host === "seancy.com" || !adminPath)) {
      return;
    }
    var page = (adminHost ? path : path.slice("/admin".length)).replace(/\/+$/, "");
    // Mêmes titres que useDocumentTitle dans Dashboard.tsx, TicketsPage.tsx et
    // Tools.tsx (« <page> — Seancy », « [Dev] » devant sur develop, déjà mis
    // dans le <title> par scripts/develop-assets.ts). Connexion par lien
    // e-mail : titre laissé tel quel.
    var name =
      page === "/tickets" || page.indexOf("/tickets/") === 0
        ? "Tickets"
        : page === "/outils"
          ? "Outils · Admin"
          : page === "/auth/verify"
            ? null
            : "Admin";
    if (name) {
      var prefix = document.title.indexOf("[Dev] ") === 0 ? "[Dev] " : "";
      document.title = prefix + name + " — Seancy";
    }
    var swaps = [
      ['link[rel="icon"][type="image/svg+xml"]', "/admin/favicon.svg"],
      ['link[rel="icon"][sizes="32x32"]', "/admin/favicon-32.png"],
      ['link[rel="apple-touch-icon"]', "/admin/apple-touch-icon.png"],
      ['link[rel="manifest"]', "/admin/manifest.webmanifest"],
    ];
    var apply = function () {
      for (var i = 0; i < swaps.length; i++) {
        var links = document.querySelectorAll(swaps[i][0]);
        for (var j = 0; j < links.length; j++) {
          links[j].setAttribute("href", swaps[i][1]);
        }
      }
      // Nom sous l'icône sur l'écran d'accueil iOS.
      var meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "apple-mobile-web-app-title");
        document.head.appendChild(meta);
      }
      meta.setAttribute("content", "Seancy Admin");
    };
    apply();
    // Le <link rel="manifest"> est ajouté au build (vite-plugin-pwa) en fin
    // de <head>, après ce script : repris une fois la page lue.
    document.addEventListener("DOMContentLoaded", apply);
  } catch (e) {
    // Repli : icônes et titre du site, sans conséquence sur l'admin.
  }
})();
