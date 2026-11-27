// Espace admin de Seancy : sur admin.seancy.com (derrière Cloudflare Access),
// ou sous /admin sur les previews et en local. Regroupe le tableau de bord,
// les tickets envoyés à Claude et les outils de maintenance. Le serveur
// (worker/admin.ts) n'ouvre ses routes qu'aux comptes listés dans le secret
// ADMIN_EMAILS ; cette page ne fait qu'en tirer l'affichage.
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import { isNetworkError, recoverFromAccessExpiry } from "../../core/api/accessSession.ts";
import { useAuth } from "../../core/context/AuthContext.tsx";
import { hideInitialLoader } from "../../core/initialLoader.ts";
import { adminPrefix, isAdminHost } from "../../core/lib/adminHost.ts";
import { DEV_HOSTNAME, isDevSite } from "../../core/lib/devSite.ts";
import Icon, { type IconName } from "../../shared/components/Icon/Icon.tsx";
import TicketLogo from "../../shared/components/TicketLogo/TicketLogo.tsx";
import { LoginForm, VerifyAuthPage } from "../auth/index.ts";
import { releaseState } from "../tickets/api.ts";
import styles from "./Admin.module.css";
import { HeaderSlot } from "./headerSlot.ts";

const Dashboard = lazy(() => import("./Dashboard.tsx"));
const Tools = lazy(() => import("./Tools.tsx"));
const Tickets = lazy(() => import("../tickets/index.ts"));

interface Me {
  admin: boolean;
  signedIn: boolean;
  name: string;
  email: string;
}

/** Lien magique reçu par e-mail : après la vérification, retour à l'espace admin (et non à « Ma liste »). */
function AdminVerify({ base }: { base: string }) {
  const [params] = useSearchParams();
  if (!params.get("next")) {
    params.set("next", base);
    return <Navigate to={{ search: `?${params}` }} replace />;
  }
  return <VerifyAuthPage />;
}

export default function AdminApp() {
  const { status, logout } = useAuth();
  const prefix = adminPrefix();
  const base = prefix || "/";
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  const siteUrl = isAdminHost() ? "https://seancy.com" : "/";
  const { pathname } = useLocation();
  // Boutons de la page dans l'en-tête sur téléphone (HeaderActions)
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const sections: { to: string; label: string; short: string; icon: IconName; end?: boolean }[] = [
    { to: base, label: "Tableau de bord", short: "Accueil", icon: "grid", end: true },
    { to: `${prefix}/tickets`, label: "Tickets", short: "Tickets", icon: "list" },
    { to: `${prefix}/outils`, label: "Outils", short: "Outils", icon: "settings" },
  ];
  // Pastille sur Accueil : release bloquée, ou changements en attente depuis plus de 3 jours
  const [attention, setAttention] = useState("");
  useEffect(() => {
    if (!me?.admin) {
      return;
    }
    const check = () =>
      releaseState()
        .then(({ release: r }) =>
          setAttention(
            r.pr?.state === "fail"
              ? "Release bloquée"
              : !r.pr && r.pending.length && r.since && Date.now() - r.since > 3 * 86_400_000
                ? "Changements à mettre en ligne"
                : ""
          )
        )
        .catch(() => setAttention(""));
    void check();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void check();
      }
    }, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [me?.admin]);
  const current =
    sections.find((s) => s.to !== base && pathname.startsWith(s.to))?.label ?? sections[0].label;

  useEffect(() => {
    hideInitialLoader();
  }, []);
  useEffect(() => {
    if (status === "loading") {
      return;
    }
    let live = true;
    fetch("/api/admin/me")
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as Me & { error?: string };
        if (!live) {
          return;
        }
        if (!r.ok) {
          setError(d.error || `Erreur ${r.status}`);
        } else {
          setMe(d);
          setError("");
        }
      })
      .catch(async (err: unknown) => {
        // Session Cloudflare Access expirée (page servie par le service
        // worker, appel redirigé vers la connexion Access et bloqué) : la
        // page repart vers Access. Sinon, vraie coupure réseau.
        if (isNetworkError(err) && (await recoverFromAccessExpiry())) {
          return;
        }
        if (live) {
          setError("Serveur injoignable");
        }
      });
    return () => {
      live = false;
    };
  }, [status]);

  useEffect(() => {
    document.documentElement.classList.add(styles.adminRoot);
    return () => document.documentElement.classList.remove(styles.adminRoot);
  }, []);
  // Icônes de l'espace admin (public/admin/ : ticket doré « ADMIN »), manifeste et titre de
  // l'onglet : posés avant le premier affichage par public/theme-init.js, pas ici (l'onglet
  // montrait d'abord ceux du site à chaque rechargement).

  const guarded = (el: ReactNode) => {
    if (error) {
      return (
        <div className={styles.card}>
          <h1>Accès refusé</h1>
          <p className={styles.muted}>{error}</p>
          <button type="button" className={styles.btn} onClick={() => window.location.reload()}>
            Réessayer
          </button>
        </div>
      );
    }
    if (!me) {
      return <p className={styles.muted}>Chargement…</p>;
    }
    if (!me.signedIn) {
      return (
        <div className={styles.card}>
          <p className={styles.eyebrow}>Espace admin</p>
          <h1>Connexion</h1>
          <p className={styles.muted}>
            Connecte-toi avec l'adresse de ton compte Seancy : tu reçois un lien et un code par
            e-mail.
          </p>
          <LoginForm oauth={false} />
        </div>
      );
    }
    if (!me.admin) {
      return (
        <div className={styles.card}>
          <h1>Compte non administrateur</h1>
          <p className={styles.muted}>
            Ce compte n'a pas accès à l'espace admin : son adresse doit figurer dans le secret
            ADMIN_EMAILS du Worker.
          </p>
          <button type="button" className={styles.btn} onClick={() => void logout()}>
            Se déconnecter
          </button>
        </div>
      );
    }
    return el;
  };

  return (
    <div className={styles.shell}>
      <header className={styles.top}>
        <Link
          to={base}
          className={styles.brand}
          aria-label="Espace admin de Seancy, tableau de bord"
        >
          <TicketLogo className={styles.logo} />
          <span className={styles.brandName}>Seancy</span>
          <span className={styles.badge}>Admin</span>
        </Link>
        {/* Téléphone : titre de la page et ses boutons, comme le panneau de Paddock Live */}
        {me?.admin && <span className={styles.pageName}>{current}</span>}
        <div ref={setSlot} className={styles.actions} />
        {me?.admin && (
          <nav className={styles.nav} aria-label="Espace admin">
            {sections.map((s) => (
              <NavLink
                key={s.to}
                to={s.to}
                end={s.end}
                className={({ isActive }) => (isActive ? styles.active : "")}
              >
                {s.label}
                {s.end && attention && (
                  <span
                    className={styles.dot}
                    title={attention}
                    role="img"
                    aria-label={attention}
                  />
                )}
              </NavLink>
            ))}
          </nav>
        )}
        <div className={styles.side}>
          {me?.admin && <span className={styles.who}>{me.name}</span>}
          {/* Ordinateur : actualiser la page (téléphone : tirer vers le bas, PullToRefresh) */}
          <button type="button" className={styles.refresh} onClick={() => window.location.reload()}>
            <Icon name="refresh" size={16} />
            Actualiser
          </button>
          <a href={siteUrl} className={styles.siteLink}>
            Voir le site
          </a>
          {/* Sur le site de développement lui-même, « Voir le site » y mène déjà */}
          {!isDevSite && (
            <a
              href={`https://${DEV_HOSTNAME}/`}
              className={styles.siteLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              Site de développement
            </a>
          )}
        </div>
      </header>
      <main id="contenu" className={styles.main} tabIndex={-1}>
        <HeaderSlot.Provider value={slot}>
          <Suspense fallback={<p className={styles.muted}>Chargement…</p>}>
            <Routes>
              <Route path="auth/verify" element={<AdminVerify base={base} />} />
              <Route index element={guarded(<Dashboard />)} />
              <Route path="tickets" element={guarded(<Tickets />)} />
              <Route path="tickets/:ticketId" element={guarded(<Tickets />)} />
              <Route path="outils" element={guarded(<Tools />)} />
              <Route path="*" element={<Navigate to={base} replace />} />
            </Routes>
          </Suspense>
        </HeaderSlot.Provider>
      </main>
      {/* Téléphone : barre d'onglets flottante en bas, comme celle du site */}
      {me?.admin && (
        <nav className={styles.tabbar} aria-label="Espace admin (onglets)">
          {sections.map((s) => (
            <NavLink
              key={s.to}
              to={s.to}
              end={s.end}
              className={({ isActive }) =>
                isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab
              }
            >
              <span className={styles.tabIcon}>
                <Icon name={s.icon} size={22} />
                {s.end && attention && (
                  <span className={styles.dot} role="img" aria-label={attention} />
                )}
              </span>
              <span>{s.short}</span>
            </NavLink>
          ))}
          <a href={siteUrl} className={styles.tab}>
            <Icon name="external" size={22} />
            <span>Le site</span>
          </a>
        </nav>
      )}
    </div>
  );
}
