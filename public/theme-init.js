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
