import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Routes, Route, Navigate, useLocation, useNavigationType } from "react-router-dom";
import {
  NavBar,
  ScrollToTop,
  ScrollToTopButton,
  RecaptchaBadge,
  Footer,
  LegalLinks,
  InAppNotifications,
  PullToRefresh,
} from "./shared/components/index.ts";
// Page d'accueil dans le bundle principal : c'est le premier écran de la
// plupart des visites. Les autres pages sont des chunks séparés, téléchargés
// à la première visite de leur route (audit H6).
import Discover from "./modules/discover/index.ts";
import { MembersOnlyDialog } from "./modules/auth/index.ts";
import { fadeIn } from "./shared/lib/motion.ts";
import { hideInitialLoader } from "./core/initialLoader.ts";
import ErrorBoundary from "./shared/components/ErrorBoundary/ErrorBoundary.tsx";
import { ADMIN_ORIGIN, isAdminHost, isPublicHost } from "./core/lib/adminHost.ts";

const NewReleases = lazy(() => import("./modules/new-releases/index.ts"));
const ComingSoon = lazy(() => import("./modules/coming-soon/index.ts"));
const Detail = lazy(() => import("./modules/detail/index.ts"));
const Person = lazy(() => import("./modules/person/index.ts"));
const Random = lazy(() => import("./modules/random/index.ts"));
const Profile = lazy(() => import("./modules/profile/index.ts"));
const Settings = lazy(() => import("./modules/settings/index.ts"));
const PublicProfile = lazy(() => import("./modules/public-profile/index.ts"));
const Search = lazy(() => import("./modules/search/index.ts"));
const SharedList = lazy(() => import("./modules/shared-list/index.ts"));
const LoginPage = lazy(() =>
  import("./modules/auth/index.ts").then((m) => ({ default: m.LoginPage }))
);
const VerifyAuthPage = lazy(() =>
  import("./modules/auth/index.ts").then((m) => ({ default: m.VerifyAuthPage }))
);
const TermsPage = lazy(() =>
  import("./modules/legal/index.ts").then((m) => ({ default: m.TermsPage }))
);
const PrivacyPolicyPage = lazy(() =>
  import("./modules/legal/index.ts").then((m) => ({ default: m.PrivacyPolicyPage }))
);
const ChangelogPage = lazy(() =>
  import("./modules/changelog/index.ts").then((m) => ({ default: m.ChangelogPage }))
);
// Espace admin (tableau de bord, tickets envoyés à Claude, outils) : sur son
// domaine (admin.seancy.com), ou sous /admin ailleurs que sur le site public.
const AdminApp = lazy(() => import("./modules/admin/index.ts"));
const ADMIN_HOST = isAdminHost();

// Ancienne adresse de la page Tickets, et /admin sur le site public : vers
// l'espace admin (son domaine en prod, /admin sur les previews et en local).
function ToAdmin({ path = "" }: { path?: string }) {
  if (isPublicHost()) {
    window.location.replace(`${ADMIN_ORIGIN}${path}`);
    return null;
  }
  return <Navigate to={`/admin${path}`} replace />;
}
const NotFound = lazy(() => import("./modules/not-found/index.ts"));

// Pendant le téléchargement d'une page : rien les 300 premières ms (cas
// courant, le chunk arrive vite), puis un indicateur discret.
function RouteFallback() {
  const { t } = useTranslation();
  return (
    <div className="route-fallback" role="status" aria-label={t("common.loading")}>
      <div className="route-fallback__spinner" />
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    hideInitialLoader();
  }, []);

  // Fondu court à chaque changement de page (pas au premier affichage,
  // couvert par le splash, ni quand seuls les paramètres changent : onglets
  // du profil, filtres). En layout effect pour partir de l'opacité 0 avant
  // que la nouvelle page ne soit peinte.
  useLayoutEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    // Retour (bouton « Retour », geste de balayage, bouton du navigateur) :
    // pas de fondu, la page revient telle quelle. Sur Safari iOS, le geste
    // fait déjà glisser la page ; repartir ensuite de l'opacité 0 laissait
    // un écran vide le temps du fondu (retour de review, vidéo du 28/09).
    if (navigationType !== "POP") {
      fadeIn(mainRef.current);
    }
    // Focus sur le contenu de la nouvelle page (audit H11) : sans ça, il
    // reste sur le lien cliqué, et un lecteur d'écran n'annonce pas le
    // changement de page. `preventScroll` : le défilement reste géré par
    // ScrollToTop et la restauration de scroll.
    mainRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Espace admin : sa propre mise en page, sans la barre ni le pied du site
  if (ADMIN_HOST || (!isPublicHost() && /^\/admin(\/|$)/.test(pathname))) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path={ADMIN_HOST ? "/*" : "/admin/*"} element={<AdminApp />} />
        </Routes>
        {/* Admin installé sur le téléphone : tirer vers le bas recharge, comme sur le site */}
        <PullToRefresh />
      </Suspense>
    );
  }

  return (
    <>
      <ScrollToTop />
      <RecaptchaBadge />
      {/* Lien d'évitement : premier élément au Tab, masqué hors focus. Focus
          posé à la main plutôt que par l'ancre, qui ajouterait un #hash à
          l'URL et une entrée d'historique. */}
      <a
        href="#contenu"
        className="skipLink"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        {t("common.skipToContent")}
      </a>
      <NavBar />
      <main id="contenu" ref={mainRef} tabIndex={-1}>
        <ErrorBoundary resetKey={pathname}>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Discover />} />
              <Route path="/nouveautes" element={<NewReleases />} />
              <Route path="/prochainement" element={<ComingSoon />} />
              <Route path="/media/:mediaType/:id" element={<Detail />} />
              <Route path="/personne/:id" element={<Person />} />
              <Route path="/aleatoire" element={<Random />} />
              <Route path="/ma-liste" element={<Navigate to="/profil?tab=ma-liste" replace />} />
              <Route path="/profil" element={<Profile />} />
              <Route path="/reglages/*" element={<Settings />} />
              <Route path="/u/:slug" element={<PublicProfile />} />
              <Route path="/recherche" element={<Search />} />
              <Route path="/liste/:slug" element={<SharedList />} />
              <Route path="/connexion" element={<LoginPage />} />
              <Route path="/auth/verify" element={<VerifyAuthPage />} />
              <Route path="/conditions-utilisation" element={<TermsPage />} />
              <Route path="/confidentialite" element={<PrivacyPolicyPage />} />
              <Route path="/changelog" element={<ChangelogPage />} />
              <Route path="/tickets" element={<ToAdmin path="/tickets" />} />
              <Route path="/admin/*" element={<ToAdmin />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
      <Footer />
      <LegalLinks />
      <ScrollToTopButton />
      <InAppNotifications />
      <PullToRefresh />
      <MembersOnlyDialog />
    </>
  );
}
