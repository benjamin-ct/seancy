// Espace admin de Seancy : sur admin.seancy.com (derrière Cloudflare Access),
// ou sous /admin sur les previews et en local. Regroupe le tableau de bord,
// les tickets envoyés à Claude et les outils de maintenance. Le serveur
// (worker/admin.ts) n'ouvre ses routes qu'aux comptes listés dans le secret
// ADMIN_EMAILS ; cette page ne fait qu'en tirer l'affichage.
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, NavLink, Route, Routes, useSearchParams } from "react-router-dom";
import { useAuth } from "../../core/context/AuthContext.tsx";
import { hideInitialLoader } from "../../core/initialLoader.ts";
import { adminPrefix, isAdminHost } from "../../core/lib/adminHost.ts";
import TicketLogo from "../../shared/components/TicketLogo/TicketLogo.tsx";
import { LoginForm, VerifyAuthPage } from "../auth/index.ts";
import styles from "./Admin.module.css";

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
      .catch(() => live && setError("Serveur injoignable"));
    return () => {
      live = false;
    };
  }, [status]);

  useEffect(() => {
    document.documentElement.classList.add(styles.adminRoot);
    return () => document.documentElement.classList.remove(styles.adminRoot);
  }, []);

  const guarded = (el: ReactNode) => {
    if (error) {
      return (
        <div className={styles.card}>
          <h1>Accès refusé</h1>
          <p className={styles.muted}>{error}</p>
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
          <span>Seancy</span>
          <span className={styles.badge}>Admin</span>
        </Link>
        {me?.admin && (
          <nav className={styles.nav} aria-label="Espace admin">
            <NavLink to={base} end className={({ isActive }) => (isActive ? styles.active : "")}>
              Tableau de bord
            </NavLink>
            <NavLink
              to={`${prefix}/tickets`}
              className={({ isActive }) => (isActive ? styles.active : "")}
            >
              Tickets
            </NavLink>
            <NavLink
              to={`${prefix}/outils`}
              className={({ isActive }) => (isActive ? styles.active : "")}
            >
              Outils
            </NavLink>
          </nav>
        )}
        <div className={styles.side}>
          {me?.admin && <span className={styles.who}>{me.name}</span>}
          <a href={siteUrl} className={styles.siteLink}>
            Voir le site
          </a>
        </div>
      </header>
      <main id="contenu" className={styles.main} tabIndex={-1}>
        <Suspense fallback={<p className={styles.muted}>Chargement…</p>}>
          <Routes>
            <Route path="auth/verify" element={<AdminVerify base={base} />} />
            <Route index element={guarded(<Dashboard />)} />
            <Route path="tickets" element={guarded(<Tickets />)} />
            <Route path="outils" element={guarded(<Tools />)} />
            <Route path="*" element={<Navigate to={base} replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
