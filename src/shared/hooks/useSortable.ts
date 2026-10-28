import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";

interface Point {
  x: number;
  y: number;
}

interface DragSession {
  key: string;
  pointerId: number;
  from: number;
  start: Point;
  /** Centres des emplacements au départ du glisser (coordonnées de page). */
  slots: Point[];
  target: number;
  /** Dernière position du pointeur (coordonnées d'écran), pour le défilement auto. */
  client: { x: number; y: number };
  touch: boolean;
  /**
   * false tant que le glisser n'a pas démarré : souris pas encore bougée de
   * quelques pixels (clic simple), ou appui long au doigt pas encore écoulé.
   */
  active: boolean;
}

interface UseSortableOptions {
  keys: string[];
  enabled: boolean;
  /** Nouvel ordre complet et clé déplacée, appelé au lâcher si l'ordre change. */
  onReorder: (next: string[], movedKey: string) => void;
}

// Au-delà de ce déplacement (px), un appui souris devient un glisser et le clic
// qui suit est annulé (sinon l'affiche, souvent un lien, s'ouvrirait).
const MOUSE_THRESHOLD = 6;
// Au doigt, hors poignée : appui long avant de saisir le titre. Si le doigt
// bouge avant, c'est un défilement de la page et on abandonne.
const LONG_PRESS_MS = 300;
const TOUCH_SLOP = 10;
// Défilement automatique quand le titre tenu approche du haut ou du bas de
// l'écran (px de la bordure, vitesse max en px par image).
const EDGE_ZONE = 72;
const EDGE_SPEED = 18;
const ANIMATION = "transform 220ms cubic-bezier(0.2, 0, 0, 1)";

const pagePoint = (x: number, y: number): Point => ({
  x: x + window.scrollX,
  y: y + window.scrollY,
});

function centerOf(el: HTMLElement): Point {
  const rect = el.getBoundingClientRect();
  return pagePoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function nearest(slots: Point[], p: Point): number {
  let best = 0;
  let bestDistance = Infinity;
  slots.forEach((slot, i) => {
    const distance = (slot.x - p.x) ** 2 + (slot.y - p.y) ** 2;
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

export function moveKey(keys: string[], key: string, to: number): string[] {
  const next = keys.filter((k) => k !== key);
  next.splice(to, 0, key);
  return next;
}

/** Voisin après lequel (ou avant lequel, en tête) placer la clé déplacée. */
export function neighborOf(next: string[], moved: string): { toKey: string; after: boolean } {
  const index = next.indexOf(moved);
  return index > 0 ? { toKey: next[index - 1], after: true } : { toKey: next[1], after: false };
}

/**
 * Réordonner une liste au glisser-déposer, à la souris et au doigt.
 *
 * Pointer Events plutôt que le drag & drop HTML5 : ce dernier ne marche pas au
 * doigt, et sur iOS glisser une affiche (un lien) l'ouvre dans un nouvel
 * onglet. À la souris, tout l'élément se glisse. Au doigt, la poignée
 * (`data-drag-handle`, avec `touch-action: none`) saisit le titre tout de
 * suite ; ailleurs, il faut un appui long, pour que la page défile normalement
 * quand on balaie l'écran. Une fois le titre saisi, la page ne défile plus sous
 * le doigt, sauf près du haut ou du bas de l'écran où elle défile toute seule
 * pour atteindre les titres hors de vue.
 *
 * Pendant le glisser, l'élément suit le pointeur et les autres se décalent en
 * direct vers leur future place (animation FLIP) ; au lâcher, l'élément glisse
 * jusqu'à son emplacement.
 */
export function useSortable({ keys, enabled, onReorder }: UseSortableOptions) {
  const [drag, setDrag] = useState<{ key: string; target: number } | null>(null);
  // Écouteurs globaux branchés dès l'appui (avant le seuil souris) jusqu'au lâcher.
  const [listening, setListening] = useState(false);
  const session = useRef<DragSession | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const lastRects = useRef(new Map<string, Point>());
  const suppressClick = useRef(false);
  const longPress = useRef<number | undefined>(undefined);
  // Titre saisi au doigt : la page ne défile plus sous le doigt (sinon le
  // navigateur interrompt le glisser par un pointercancel). Branché sur chaque
  // élément dès le montage : un écouteur ajouté après le touchstart ne peut
  // plus bloquer le défilement.
  const blockTouchScroll = useRef((e: TouchEvent) => {
    if (session.current?.active && e.cancelable) {
      e.preventDefault();
    }
  }).current;
  // Une fonction ref stable par clé : une nouvelle fonction à chaque rendu
  // ferait détacher puis rattacher l'élément, et effacerait sa dernière
  // position mémorisée (plus d'animation FLIP).
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  function refFor(key: string) {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (el: HTMLElement | null) => {
        const previous = elements.current.get(key);
        if (el) {
          elements.current.set(key, el);
          el.addEventListener("touchmove", blockTouchScroll, { passive: false });
        } else {
          previous?.removeEventListener("touchmove", blockTouchScroll);
          elements.current.delete(key);
          lastRects.current.delete(key);
          refs.current.delete(key);
        }
      };
      refs.current.set(key, ref);
    }
    return ref;
  }
  const onReorderRef = useRef(onReorder);
  const keysRef = useRef(keys);
  useLayoutEffect(() => {
    onReorderRef.current = onReorder;
    keysRef.current = keys;
  });

  const order = drag ? moveKey(keys, drag.key, drag.target) : keys;
  const orderSignature = order.join("|");
  const dragKey = drag?.key ?? null;

  // FLIP : chaque élément qui a changé de place part visuellement de son
  // ancienne position puis glisse vers la nouvelle. L'élément tenu est exclu :
  // il suit le pointeur (voir followPointer).
  useLayoutEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const held = session.current?.active ? session.current.key : null;
    const items = [...elements.current].filter(([key]) => key !== held);
    // Écritures, lectures puis écritures en trois passes séparées : les
    // alterner élément par élément forçait un recalcul de mise en page par
    // carte à chaque changement de place pendant le glisser. Un transform ne
    // déplace pas les autres cartes, les positions lues sont donc les mêmes.
    for (const [, el] of items) {
      el.style.transition = "none";
      el.style.transform = "";
    }
    const offsets: [HTMLElement, number, number][] = [];
    for (const [key, el] of items) {
      const previous = lastRects.current.get(key);
      const rect = el.getBoundingClientRect();
      const current = pagePoint(rect.left, rect.top);
      lastRects.current.set(key, current);
      if (!previous || reduced) {
        continue;
      }
      const dx = previous.x - current.x;
      const dy = previous.y - current.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        offsets.push([el, dx, dy]);
      }
    }
    const moved: HTMLElement[] = [];
    for (const [el, dx, dy] of offsets) {
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      moved.push(el);
    }
    if (moved.length > 0) {
      // Force le calcul de la position de départ avant de lancer la transition.
      void document.body.offsetWidth;
      for (const el of moved) {
        el.style.transition = ANIMATION;
        el.style.transform = "";
      }
    }
    // dragKey : au lâcher sur place, l'ordre ne change pas mais l'élément tenu
    // doit tout de même rejoindre son emplacement.
  }, [orderSignature, dragKey]);

  const followPointer = useCallback((s: DragSession, p: Point) => {
    const el = elements.current.get(s.key);
    if (!el) {
      return;
    }
    // L'élément est rendu à l'emplacement cible : on compense ce décalage pour
    // qu'il reste sous le pointeur.
    const dx = p.x - s.start.x - (s.slots[s.target].x - s.slots[s.from].x);
    const dy = p.y - s.start.y - (s.slots[s.target].y - s.slots[s.from].y);
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px) scale(1.04)`;
  }, []);

  const finish = useCallback((commit: boolean) => {
    const s = session.current;
    session.current = null;
    window.clearTimeout(longPress.current);
    setListening(false);
    if (!s?.active) {
      return;
    }
    // Position visuelle au lâcher : point de départ de l'animation vers
    // l'emplacement final (effet FLIP ci-dessus).
    const el = elements.current.get(s.key);
    if (el) {
      const rect = el.getBoundingClientRect();
      lastRects.current.set(s.key, pagePoint(rect.left, rect.top));
    }
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    setDrag(null);
    if (commit && s.target !== s.from) {
      onReorderRef.current(moveKey(keysRef.current, s.key, s.target), s.key);
    }
  }, []);

  const start = useCallback((s: DragSession) => {
    s.active = true;
    s.slots = keysRef.current.map((key) => {
      const el = elements.current.get(key);
      if (!el) {
        return s.start;
      }
      // Positions à jour (la mise en page a pu changer depuis, ex. rotation).
      const rect = el.getBoundingClientRect();
      lastRects.current.set(key, pagePoint(rect.left, rect.top));
      return centerOf(el);
    });
    if (s.touch) {
      navigator.vibrate?.(10);
    }
    setDrag({ key: s.key, target: s.from });
  }, []);

  useEffect(() => {
    if (!listening) {
      return;
    }
    let frame = 0;
    function update(s: DragSession) {
      const p = pagePoint(s.client.x, s.client.y);
      const target = nearest(s.slots, p);
      if (target !== s.target) {
        s.target = target;
        setDrag({ key: s.key, target });
      }
      followPointer(s, p);
    }
    // Défilement automatique près du haut ou du bas de l'écran, tant que le
    // pointeur y reste (même immobile).
    function autoScroll() {
      frame = 0;
      const s = session.current;
      if (!s?.active) {
        return;
      }
      const { y } = s.client;
      const fromBottom = window.innerHeight - y;
      const speed =
        y < EDGE_ZONE
          ? -EDGE_SPEED * (1 - Math.max(y, 0) / EDGE_ZONE)
          : fromBottom < EDGE_ZONE
            ? EDGE_SPEED * (1 - Math.max(fromBottom, 0) / EDGE_ZONE)
            : 0;
      const before = window.scrollY;
      if (speed !== 0) {
        window.scrollBy(0, speed);
      }
      if (window.scrollY !== before) {
        update(s);
        frame = requestAnimationFrame(autoScroll);
      }
    }
    function onMove(e: globalThis.PointerEvent) {
      const s = session.current;
      if (!s || e.pointerId !== s.pointerId) {
        return;
      }
      s.client = { x: e.clientX, y: e.clientY };
      if (!s.active) {
        const p = pagePoint(e.clientX, e.clientY);
        const moved = Math.hypot(p.x - s.start.x, p.y - s.start.y);
        if (s.touch) {
          // Le doigt bouge avant la fin de l'appui long : on fait défiler la page.
          if (moved > TOUCH_SLOP) {
            finish(false);
          }
          return;
        }
        if (moved < MOUSE_THRESHOLD) {
          return;
        }
        start(s);
      }
      e.preventDefault();
      update(s);
      if (!frame) {
        frame = requestAnimationFrame(autoScroll);
      }
    }
    function onUp(e: globalThis.PointerEvent) {
      if (session.current && e.pointerId === session.current.pointerId) {
        finish(e.type === "pointerup");
      }
    }
    // Appui long au doigt : ni menu contextuel ni aperçu du lien.
    function onContextMenu(e: Event) {
      if (session.current?.touch) {
        e.preventDefault();
      }
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, [listening, finish, followPointer, start]);

  useEffect(() => () => window.clearTimeout(longPress.current), []);

  function onPointerDown(e: PointerEvent<HTMLElement>, key: string) {
    if (!enabled || e.button !== 0 || keys.length < 2 || session.current?.active) {
      return;
    }
    const touch = e.pointerType !== "mouse";
    const fromHandle = (e.target as HTMLElement).closest("[data-drag-handle]");
    const s: DragSession = {
      key,
      pointerId: e.pointerId,
      from: keys.indexOf(key),
      start: pagePoint(e.clientX, e.clientY),
      slots: [],
      target: keys.indexOf(key),
      client: { x: e.clientX, y: e.clientY },
      touch,
      active: false,
    };
    window.clearTimeout(longPress.current);
    session.current = s;
    setListening(true);
    if (touch && fromHandle) {
      // Au doigt, la poignée démarre le glisser tout de suite.
      e.preventDefault();
      start(s);
    } else if (touch) {
      longPress.current = window.setTimeout(() => {
        if (session.current === s) {
          start(s);
          followPointer(s, pagePoint(s.client.x, s.client.y));
        }
      }, LONG_PRESS_MS);
    }
  }

  return {
    order,
    dragKey,
    itemProps(key: string) {
      return {
        ref: refFor(key),
        onPointerDown: (e: PointerEvent<HTMLElement>) => onPointerDown(e, key),
        // Empêche le drag & drop natif des liens et images (souris).
        onDragStart: (e: MouseEvent<HTMLElement>) => e.preventDefault(),
        onClickCapture: (e: MouseEvent<HTMLElement>) => {
          if (suppressClick.current) {
            e.preventDefault();
            e.stopPropagation();
          }
        },
      };
    },
  };
}
