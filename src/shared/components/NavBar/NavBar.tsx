import { NavLink, Link, matchPath, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { searchMultiRanked, posterUrl } from "../../../core/api/tmdb.ts";
import { useAuth } from "../../../core/context/AuthContext.tsx";
import { useRegion } from "../../../core/context/RegionContext.tsx";
import { setMediaPreview } from "../../lib/mediaPreviewCache.ts";
import { prefersReducedMotion } from "../../lib/motion.ts";
import type { SearchMultiResult } from "../../../core/types/tmdb.ts";
import TicketLogo from "../TicketLogo/TicketLogo.tsx";
import Icon, { type IconName } from "../Icon/Icon.tsx";
import SlidingIndicator from "../SlidingIndicator/SlidingIndicator.tsx";
import useHideOnScroll from "../../hooks/useHideOnScroll.ts";
import styles from "./NavBar.module.css";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;
const MAX_LIVE_RESULTS = 8;

const NAV_LINKS: { to: string; key: string; icon: IconName; end?: boolean }[] = [
  { to: "/", key: "discover", icon: "compass", end: true },
  { to: "/nouveautes", key: "newReleases", icon: "sparkle" },
  { to: "/prochainement", key: "comingSoon", icon: "calendar" },
  { to: "/aleatoire", key: "random", icon: "shuffle" },
];

function SearchResults({
  results,
  status,
  query,
  onPick,
  inline,
  onViewAll,
  listboxId,
  activeIndex,
}: {
  results: SearchMultiResult[];
  status: "idle" | "loading" | "success" | "error";
  query: string;
  onPick: (path: string) => void;
  inline?: boolean;
  onViewAll: () => void;
  /** Liste d'options du combobox (voir comboboxProps dans NavBar). */
  listboxId: string;
  /** Option active au clavier (-1 : aucune), le focus restant dans le champ. */
  activeIndex: number;
}) {
  const { t } = useTranslation();
  // Alimente le cache de préview (voir mediaPreviewCache) pour que la fiche
  // puisse préafficher affiche/titre/date pendant son chargement.
  useEffect(() => {
    for (const item of results) {
      if (item.media_type === "movie" || item.media_type === "tv") {
        setMediaPreview(item.media_type, item.id, {
          title: item.title || item.name || "",
          posterPath: item.poster_path ?? null,
          date: item.region_release_date || item.release_date || item.first_air_date,
        });
      }
    }
  }, [results]);

  return (
    <div className={`${styles.results} ${inline ? styles.resultsInline : ""}`}>
      {status === "loading" && (
        <p className={styles.hint} role="status">
          {t("navBar.searching")}
        </p>
      )}
      {status === "success" && results.length === 0 && (
        <p className={styles.hint} role="status">
          {t("navBar.noResults")}
        </p>
      )}
      <div id={listboxId} role="listbox" aria-label={t("navBar.searchAriaLabel")}>
        {results.map((item, index) => {
          // Options atteintes aux flèches depuis le champ (aria-activedescendant),
          // pas au Tab : le Tab quitte la recherche et referme la liste.
          const optionProps = {
            id: `${listboxId}-${index}`,
            role: "option",
            "aria-selected": index === activeIndex,
            tabIndex: -1,
          };
          if (item.media_type === "person") {
            const path = `/personne/${item.id}`;
            return (
              <Link
                key={`person-${item.id}`}
                {...optionProps}
                to={path}
                className={styles.item}
                onClick={() => onPick(path)}
              >
                {item.profile_path ? (
                  <img
                    src={posterUrl(item.profile_path, "w92") ?? undefined}
                    alt=""
                    className={styles.avatar}
                  />
                ) : (
                  <div className={`${styles.avatar} ${styles.avatarEmpty}`} />
                )}
                <div>
                  <p className={styles.itemTitle}>{item.name}</p>
                  <p className={styles.itemMeta}>{t("navBar.personRoleHint")}</p>
                </div>
              </Link>
            );
          }
          const title = item.title || item.name || "";
          const date = item.region_release_date || item.release_date || item.first_air_date;
          const path = `/media/${item.media_type}/${item.id}`;
          return (
            <Link
              key={`${item.media_type}-${item.id}`}
              {...optionProps}
              to={path}
              className={styles.item}
              onClick={() => onPick(path)}
            >
              {item.poster_path ? (
                <img
                  src={posterUrl(item.poster_path, "w92") ?? undefined}
                  alt=""
                  className={styles.poster}
                />
              ) : (
                <div className={`${styles.poster} ${styles.posterEmpty}`} />
              )}
              <div>
                <p className={styles.itemTitle}>{title}</p>
                <p className={styles.itemMeta}>
                  {item.media_type === "movie"
                    ? t("navBar.mediaTypeMovie")
                    : t("navBar.mediaTypeSeries")}
                  {date ? ` · ${date.slice(0, 4)}` : ""}
                </p>
              </div>
            </Link>
          );
        })}
        {results.length > 0 && (
          <Link
            id={`${listboxId}-${results.length}`}
            role="option"
            aria-selected={activeIndex === results.length}
            tabIndex={-1}
            to={`/recherche?q=${encodeURIComponent(query)}`}
            className={styles.allResults}
            onClick={onViewAll}
          >
            {t("navBar.viewAllResults", { query })}
          </Link>
        )}
      </div>
    </div>
  );
}

export default function NavBar() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchMultiResult[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Option mise en avant aux flèches dans la liste de suggestions (-1 : aucune).
  const [activeIndex, setActiveIndex] = useState(-1);
  const [prevResults, setPrevResults] = useState(results);
  if (prevResults !== results) {
    setPrevResults(results);
    setActiveIndex(-1);
  }
  const listboxIdPrefix = useId();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const { status: authStatus } = useAuth();
  const { region } = useRegion();
  // Pendant la vérification de la session au rechargement ("loading", seulement
  // quand le cookie compagnon est présent), on affiche déjà la navigation
  // d'un membre connecté : sinon « Connexion » puis l'onglet Profil
  // apparaissent et disparaissent le temps de la réponse de /api/auth/me.
  const authenticated = authStatus !== "anonymous";
  // Barre d'onglets mobile escamotée quand on descend dans la page, rendue
  // dès qu'on remonte ou qu'on change de page (gardée pendant la recherche).
  const tabbarHidden = useHideOnScroll(pathname, !searchOpen);

  // Hauteur réelle de l'en-tête collant, publiée en --topnav-height pour
  // les éléments collants posés juste dessous (mois de Prochainement...) :
  // elle varie selon la largeur et l'ouverture du panneau de recherche.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) {
      return;
    }
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty("--topnav-height", `${el.offsetHeight}px`);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--topnav-height");
    };
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setStatus("idle");
      return;
    }
    setStatus("loading");
    // Réponse d'une frappe précédente arrivée après la suivante (« bat »
    // après « batman »), ou après que le champ a été vidé : ignorée, sinon
    // elle écraserait les bons résultats ou rouvrirait la liste.
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      searchMultiRanked(trimmed, region)
        .then((results) => {
          if (cancelled) {
            return;
          }
          const filtered = results
            .filter(
              (item) =>
                item.media_type === "movie" ||
                item.media_type === "tv" ||
                item.media_type === "person"
            )
            .slice(0, MAX_LIVE_RESULTS);
          setResults(filtered);
          setStatus("success");
          setOpen(true);
        })
        .catch(() => {
          if (cancelled) {
            return;
          }
          setResults([]);
          setStatus("error");
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [query, region]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setSearchOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Le panneau de recherche mobile se referme dès qu'on change de page
  // (résultat choisi, onglet du bas, lien de la page…).
  useEffect(() => {
    setSearchOpen(false);
  }, [pathname]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) {
      return;
    }
    setOpen(false);
    setSearchOpen(false);
    navigate(`/recherche?q=${encodeURIComponent(q)}`);
  }

  function goTo(path: string) {
    setOpen(false);
    setSearchOpen(false);
    setQuery("");
    if (path) {
      navigate(path);
    }
  }

  const hasQuery = query.trim().length >= MIN_QUERY_LENGTH;
  // Options : les résultats puis « Voir tous les résultats ».
  const optionCount = results.length > 0 ? results.length + 1 : 0;

  // Champ de recherche en combobox WAI-ARIA (liste de suggestions) : les
  // flèches parcourent les options sans quitter le champ, Entrée ouvre
  // l'option active (sinon lance la recherche complète).
  function comboboxProps(listboxId: string, expanded: boolean) {
    return {
      role: "combobox",
      "aria-autocomplete": "list" as const,
      "aria-expanded": expanded,
      "aria-controls": listboxId,
      "aria-activedescendant":
        expanded && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined,
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
        // Tab : la liste se referme (sinon le focus entrait dans son
        // conteneur défilable, que Chrome rend focalisable).
        if (e.key === "Tab") {
          setOpen(false);
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          if (optionCount === 0) {
            return;
          }
          e.preventDefault();
          if (!expanded) {
            setOpen(true);
            return;
          }
          const step = e.key === "ArrowDown" ? 1 : -1;
          // Cycle -1 (champ seul) → 0 … optionCount - 1 → -1.
          setActiveIndex((i) => ((i + 1 + step + optionCount + 1) % (optionCount + 1)) - 1);
          return;
        }
        if (e.key === "Enter" && expanded && activeIndex >= 0) {
          e.preventDefault();
          document.getElementById(`${listboxId}-${activeIndex}`)?.click();
        }
      },
    };
  }

  const tabbarLinks = [
    ...NAV_LINKS.map((link) => ({ ...link, label: t(`navBar.tabLinks.${link.key}`) })),
    ...(authenticated
      ? [
          {
            to: "/profil",
            key: "profile",
            icon: "user" as IconName,
            end: false,
            label: t("navBar.profileTitle"),
          },
        ]
      : []),
  ];
  // Même règle de correspondance que NavLink, pour placer la pastille active
  // (-1 hors onglet : fiche, recherche…, la pastille est alors masquée).
  const activeTabIndex = tabbarLinks.findIndex((link) =>
    matchPath({ path: link.to, end: link.end ?? false }, pathname)
  );

  function onNavClick() {
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  return (
    <>
      <header className={styles.topnav} ref={headerRef}>
        <div className={styles.inner}>
          <Link to="/" className={styles.brand} onClick={onNavClick}>
            <TicketLogo className={styles.logo} />
            Seancy
          </Link>

          <nav
            className={`${styles.tabs} ${styles.desktopOnly}`}
            aria-label={t("navBar.mainNavAriaLabel")}
          >
            <SlidingIndicator activeKey={pathname} />
            {NAV_LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                onClick={onNavClick}
                className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ""}`}
              >
                {t(`navBar.navLinks.${link.key}`)}
              </NavLink>
            ))}
          </nav>

          <div
            className={`${styles.search} ${styles.desktopOnly}`}
            ref={wrapperRef}
            // Tab (ou tout focus sorti de la recherche) : liste refermée.
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) {
                setOpen(false);
              }
            }}
          >
            <form onSubmit={onSubmit} role="search">
              <Icon name="search" />
              <input
                type="search"
                placeholder={t("navBar.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => results.length > 0 && setOpen(true)}
                aria-label={t("navBar.searchAriaLabel")}
                {...comboboxProps(`${listboxIdPrefix}-desktop`, open && hasQuery)}
              />
            </form>
            {open && hasQuery && (
              <SearchResults
                listboxId={`${listboxIdPrefix}-desktop`}
                activeIndex={activeIndex}
                results={results}
                status={status}
                query={query.trim()}
                onPick={goTo}
                onViewAll={() => setOpen(false)}
              />
            )}
          </div>

          <button
            type="button"
            className={`${styles.iconBtn} ${styles.mobileOnly} ${searchOpen ? styles.iconBtnActive : ""}`}
            onClick={() => setSearchOpen((v) => !v)}
            aria-label={t("navBar.searchAriaLabel")}
            aria-expanded={searchOpen}
            aria-controls="mobile-search"
          >
            <Icon name="search" />
          </button>

          {/* Profil réservé aux membres connectés (voir ProfilePage) : un
              visiteur anonyme n'y a aucun accès visible, seulement
              « Connexion ». La déconnexion se fait depuis Profil › Compte. */}
          {authenticated ? (
            <NavLink
              to="/profil"
              className={({ isActive }) =>
                `${styles.iconBtn} ${styles.desktopOnly} ${isActive ? styles.iconBtnActive : ""}`
              }
              aria-label={t("navBar.profileAriaLabel")}
              title={t("navBar.profileTitle")}
            >
              <Icon name="user" strokeWidth={1.8} />
            </NavLink>
          ) : (
            <Link to="/connexion" className={styles.loginBtn} onClick={onNavClick}>
              {t("navBar.login")}
            </Link>
          )}
        </div>

        {searchOpen && (
          <div id="mobile-search" className={`${styles.mobileSearchPanel} ${styles.mobileOnly}`}>
            <form onSubmit={onSubmit} role="search" className={styles.mobileSearch}>
              <Icon name="search" />
              <input
                type="search"
                autoFocus
                placeholder={t("navBar.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t("navBar.searchAriaLabel")}
                {...comboboxProps(`${listboxIdPrefix}-mobile`, hasQuery)}
              />
            </form>
            {hasQuery && (
              <SearchResults
                listboxId={`${listboxIdPrefix}-mobile`}
                activeIndex={activeIndex}
                results={results}
                status={status}
                query={query.trim()}
                inline
                onPick={goTo}
                onViewAll={() => setSearchOpen(false)}
              />
            )}
          </div>
        )}
        <div className="perfStrip perfStripTop" aria-hidden="true" />
      </header>

      {/* Barre d'onglets mobile (masquée au-delà de 860px) : pilule flottante
          en verre dépoli, icônes seules (libellé en aria-label/title). La
          pastille de l'onglet actif glisse d'un onglet à l'autre. « Ma liste »
          n'y figure pas : elle vit dans Profil. */}
      <nav
        className={`${styles.tabbar} ${tabbarHidden ? styles.tabbarHidden : ""}`}
        aria-label={t("navBar.tabBarAriaLabel")}
        style={
          {
            "--tab-count": tabbarLinks.length,
            "--tab-index": activeTabIndex,
          } as React.CSSProperties
        }
      >
        {activeTabIndex >= 0 && <span className={styles.tabbarIndicator} aria-hidden="true" />}
        {tabbarLinks.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            onClick={onNavClick}
            aria-label={link.label}
            title={link.label}
            className={({ isActive }) =>
              `${styles.tabbarItem} ${isActive ? styles.tabbarItemActive : ""}`
            }
          >
            {({ isActive }) => (
              <>
                <Icon name={link.icon} size={isActive ? 20 : 24} strokeWidth={1.9} />
                {/* Libellé visible seulement sur l'onglet actif (audit F8) :
                    les autres restent en icône seule, faute de place pour
                    tout étiqueter dans cette largeur de pilule mobile. */}
                {isActive && <span className={styles.tabbarLabel}>{link.label}</span>}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </>
  );
}
