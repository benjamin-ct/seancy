import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./PullToRefresh.module.css";
import Icon from "../Icon/Icon.tsx";

// Distance de tirage (après résistance) à dépasser pour déclencher le
// rechargement au relâchement.
const TRIGGER_PX = 72;
// Au-delà, l'indicateur ne descend plus.
const MAX_PULL_PX = 110;
// Le doigt doit parcourir plus que la distance affichée : donne la sensation
// élastique habituelle et évite un déclenchement sur un simple effleurement.
const RESISTANCE = 0.5;

// Vrai quand l'app tourne « ajoutée à l'écran d'accueil » : il n'y a alors
// ni barre d'adresse ni bouton de rechargement, et ni iOS ni Android ne
// proposent le tirer-pour-rafraîchir natif du navigateur.
function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// Un geste qui démarre dans un conteneur qui défile lui-même (colonne du
// tableau des tickets, panneau de réglages, liste déroulante…) fait défiler ce
// conteneur, jamais recharger l'app ; de même dans une zone marquée
// data-no-pull (tableau des tickets, où l'on glisse les colonnes et les cartes).
function isInsideScrollable(target: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== document.body) {
    if (node instanceof HTMLElement && node.dataset.noPull !== undefined) {
      return true;
    }
    if (node.scrollTop > 0) {
      return true;
    }
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

// Tirer-pour-recharger, uniquement dans l'app installée : tirer la page vers
// le bas depuis tout en haut fait apparaître un indicateur, et le relâcher
// au-delà du seuil recharge l'app (ce qui récupère au passage une éventuelle
// nouvelle version, voir core/pwaUpdate.ts).
export default function PullToRefresh() {
  const { t } = useTranslation();
  const [pull, setPull] = useState(0);
  const [reloading, setReloading] = useState(false);
  const pullRef = useRef(0);

  useEffect(() => {
    if (!isStandalone()) {
      return;
    }
    let startY: number | null = null;
    let startX = 0;

    const update = (value: number) => {
      pullRef.current = value;
      setPull(value);
    };

    const onTouchStart = (event: TouchEvent) => {
      startY =
        event.touches.length === 1 && window.scrollY <= 0 && !isInsideScrollable(event.target)
          ? event.touches[0].clientY
          : null;
      startX = event.touches[0]?.clientX ?? 0;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (startY === null) {
        return;
      }
      if (event.touches.length !== 1 || window.scrollY > 0) {
        startY = null;
        update(0);
        return;
      }
      const delta = event.touches[0].clientY - startY;
      // Glissement surtout de côté (colonnes, carrousels) : ce n'est pas un tirer-pour-recharger
      if (Math.abs(event.touches[0].clientX - startX) > Math.abs(delta)) {
        startY = null;
        update(0);
        return;
      }
      update(delta > 0 ? Math.min(delta * RESISTANCE, MAX_PULL_PX) : 0);
    };

    const onTouchEnd = () => {
      if (startY === null) {
        return;
      }
      startY = null;
      if (pullRef.current >= TRIGGER_PX) {
        setReloading(true);
        window.location.reload();
        return;
      }
      update(0);
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchEnd);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  if (pull === 0 && !reloading) {
    return null;
  }

  const ready = reloading || pull >= TRIGGER_PX;
  const offset = reloading ? TRIGGER_PX : pull;

  return (
    <div
      className={styles.indicator}
      style={{ transform: `translate(-50%, ${offset}px)` }}
      role="status"
      aria-label={t(
        reloading
          ? "pullToRefresh.reloading"
          : ready
            ? "pullToRefresh.release"
            : "pullToRefresh.pull"
      )}
    >
      <span
        className={`${styles.icon} ${reloading ? styles.spinning : ""}`}
        style={reloading ? undefined : { transform: `rotate(${(pull / TRIGGER_PX) * 270}deg)` }}
        data-ready={ready}
        aria-hidden="true"
      >
        <Icon name="refresh" />
      </span>
    </div>
  );
}
