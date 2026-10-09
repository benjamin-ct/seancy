// www/workers.dev : départ immédiat vers seancy.com.
import "./core/lib/legacyOriginRedirect.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
// Polices de la DA auto-hébergées (servies depuis l’origine avec le bundle) :
// plus de Google Fonts, bloqué par la CSP et source d’un transfert d’IP vers
// Google. Seuls les sous-ensembles Unicode utilisés sont téléchargés.
import "@fontsource/bebas-neue/400.css";
import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource-variable/inter/wght.css";
import "./styles/global.css";
import App from "./App.tsx";
import { AuthProvider } from "./core/context/AuthContext.tsx";
import { LibraryProvider } from "./core/context/LibraryContext.tsx";
import { MembersOnlyProvider } from "./core/context/MembersOnlyContext.tsx";
import { RemindersProvider } from "./core/context/RemindersContext.tsx";
import { RegionProvider, fetchRegion, loadStoredRegion } from "./core/context/RegionContext.tsx";
import { RegionAccountSync } from "./core/context/RegionAccountSync.tsx";
import { DEFAULT_REGION } from "./core/api/releaseBadge.ts";
import { FavoriteProvidersProvider } from "./core/context/FavoriteProvidersContext.tsx";
import { FavoriteLanguagesProvider } from "./core/context/FavoriteLanguagesContext.tsx";
import { FavoriteCountriesProvider } from "./core/context/FavoriteCountriesContext.tsx";
import { ExcludedGenresProvider } from "./core/context/ExcludedGenresContext.tsx";
import { ExcludedTitlesProvider } from "./core/context/ExcludedTitlesContext.tsx";
import { ThemeProvider } from "./core/context/ThemeContext.tsx";
import { LocaleProvider } from "./core/context/LocaleContext.tsx";
import {
  applyInitialLocale,
  ensureLocaleLoaded,
  isSupportedLocale,
  loadInitialLocale,
  type Locale,
} from "./core/i18n/i18n.ts";
import { LocaleAccountSync } from "./core/context/LocaleAccountSync.tsx";
import { ensureSentryInit, logError } from "./core/logger.ts";
import ErrorBoundary from "./shared/components/ErrorBoundary/ErrorBoundary.tsx";
import { injectWebAnalytics } from "./core/webAnalytics.ts";
import { isLikelyAutomatedClient } from "./core/botDetection.ts";
import { setupPwaAutoUpdate, setupStaleChunkReload } from "./core/pwaUpdate.ts";
import { hideInitialLoader } from "./core/initialLoader.ts";
import { stripReauthParam } from "./core/api/accessSession.ts";
import { clearAccountDataFromDevice, hasAccountDataOnDevice } from "./core/lib/accountStorage.ts";
import { hasAuthHintCookie } from "./core/lib/authHintCookie.ts";

// Best-effort, non bloquant pour le rendu initial : voir logger.ts et
// webAnalytics.ts (no-op tant que les secrets Cloudflare correspondants ne
// sont pas configurés).
// Sauté pour un client détecté comme automatisé (voir botDetection.ts) :
// ces deux appels parlent directement à des tiers (Sentry, Cloudflare Web
// Analytics) sans jamais passer par le Worker, donc invisibles à la
// détection de bots qui s'y trouve déjà (worker/bots.ts) — un crawler ne
// devrait ni polluer nos dashboards d'audience, ni consommer notre quota
// d'ingestion d'erreurs Sentry pour des erreurs qu'il déclenche lui-même.
// N'affecte ni le rendu ni le contenu de la page.
if (!isLikelyAutomatedClient(navigator)) {
  ensureSentryInit();
  injectWebAnalytics();
}

// Recharge l'app installée quand une nouvelle version est déployée, au lieu
// de garder l'ancien bundle jusqu'à une relance complète (voir pwaUpdate.ts).
setupPwaAutoUpdate();
setupStaleChunkReload();

// Retour de la page de connexion Cloudflare Access (voir accessSession.ts).
stripReauthParam();

// Session perdue sans passer par le bouton de déconnexion (expirée, cookies
// effacés) : le cookie compagnon seancy_auth a la même durée de vie que la
// session (voir worker/auth.ts), son absence suffit donc à savoir qu'on
// n'est plus connecté. Effacé avant le premier rendu, pour que les contextes
// ne rechargent pas en mémoire les données du compte précédent.
if (!hasAuthHintCookie() && hasAccountDataOnDevice()) {
  clearAccountDataFromDevice();
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Élément #root introuvable dans index.html.");
}

// Résolu avant le premier rendu (pas dans un effet de RegionProvider) pour
// que Discover/Nouveautés/À venir/Au hasard, dont le fetch dépend de la
// région, démarrent directement avec la bonne au lieu de charger une
// première fois avec DEFAULT_REGION puis de se recharger entièrement une
// fois /api/region résolu — c'est ce rechargement complet qui donnait
// l'impression que l'appli clignotait au premier affichage d'une page.
// Le splash statique de index.html couvre cette attente ; le délai est
// borné pour ne jamais bloquer indéfiniment (ex. Worker indisponible).
//
// Un choix manuel déjà stocké sur cet appareil (réglages du profil) fait
// autorité et évite tout appel réseau : /api/region ne sert que de repli
// tant qu'aucun choix explicite n'existe (voir RegionContext.tsx). La
// requête est partagée avec RegionProvider, qui en reprend le résultat si
// elle arrive après le délai, au lieu d'en refaire une (audit M8).
const INITIAL_REGION_TIMEOUT_MS = 1500;
const storedRegion = loadStoredRegion();
const regionRequest = storedRegion ? null : fetchRegion();

async function resolveInitialRegion(): Promise<string> {
  if (!regionRequest) {
    return storedRegion ?? DEFAULT_REGION;
  }
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), INITIAL_REGION_TIMEOUT_MS)
  );
  return (await Promise.race([regionRequest, timeout])) ?? DEFAULT_REGION;
}

// Langue enregistrée sur le compte, lue avant le premier rendu pour la même
// raison que la région : sans elle, un compte réglé en anglais sur un
// appareil qui n'a encore rien mémorisé (nouvelle connexion, preview) ou qui
// a gardé une autre langue affichait l'accueil en français, puis tout
// rebasculait en anglais à la réponse de LocaleAccountSync (review H8).
// Seulement si connecté, et borné comme /api/region.
async function fetchAccountLocale(): Promise<Locale | null> {
  if (!hasAuthHintCookie()) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch("/api/locale", { signal: controller.signal });
    if (!res.ok) {
      return null;
    }
    const data: { locale?: string | null } = await res.json();
    return data.locale && isSupportedLocale(data.locale) ? data.locale : null;
  } catch {
    // Repli sur la langue de l'appareil ; LocaleAccountSync resynchronise
    // après le montage.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Traductions de la langue de l'appareil chargées en parallèle (chunk séparé
// hors français, voir i18n.ts), sans allonger l'attente du splash.
async function resolveInitialLocale(): Promise<void> {
  const deviceLocale = loadInitialLocale();
  const [accountLocale] = await Promise.all([
    fetchAccountLocale(),
    ensureLocaleLoaded(deviceLocale),
  ]);
  if (accountLocale && accountLocale !== deviceLocale) {
    await ensureLocaleLoaded(accountLocale);
    applyInitialLocale(accountLocale);
  }
}

const [initialRegion] = await Promise.all([resolveInitialRegion(), resolveInitialLocale()]);

// Erreurs de rendu hors de toute ErrorBoundary (providers, NavBar…) : React
// démonte alors l'appli, au moins l'erreur remonte dans Sentry. Celles
// interceptées par ErrorBoundary sont déjà journalisées par elle.
createRoot(rootElement, {
  onUncaughtError: (error) => logError("Erreur React non interceptée", error),
}).render(
  <StrictMode>
    <ThemeProvider>
      <LocaleProvider>
        <BrowserRouter>
          <RegionProvider initialRegion={initialRegion} regionRequest={regionRequest}>
            <AuthProvider>
              <LocaleAccountSync>
                <RegionAccountSync>
                  <FavoriteProvidersProvider>
                    <FavoriteLanguagesProvider>
                      <FavoriteCountriesProvider>
                        <ExcludedGenresProvider>
                          <ExcludedTitlesProvider>
                            <MembersOnlyProvider>
                              <LibraryProvider>
                                <RemindersProvider>
                                  <ErrorBoundary>
                                    <App />
                                  </ErrorBoundary>
                                </RemindersProvider>
                              </LibraryProvider>
                            </MembersOnlyProvider>
                          </ExcludedTitlesProvider>
                        </ExcludedGenresProvider>
                      </FavoriteCountriesProvider>
                    </FavoriteLanguagesProvider>
                  </FavoriteProvidersProvider>
                </RegionAccountSync>
              </LocaleAccountSync>
            </AuthProvider>
          </RegionProvider>
        </BrowserRouter>
      </LocaleProvider>
    </ThemeProvider>
  </StrictMode>
);

// Normalement retiré par App juste après le premier rendu (voir
// initialLoader.ts) ; ce délai reste un filet si App ne se monte jamais
// (erreur rattrapée plus haut par ErrorBoundary).
setTimeout(hideInitialLoader, 3000);
