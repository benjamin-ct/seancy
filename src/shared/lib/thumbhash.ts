// Décodage ThumbHash côté client (voir migration 0021,
// scripts/generate-thumbhashes.ts, MediaCard.tsx) : transforme le ThumbHash
// base64 renvoyé par l'API en data URL affichable pendant le chargement de
// la vraie affiche.
import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { thumbHashToDataURL } from "thumbhash";

export function thumbhashToDataUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return thumbHashToDataURL(bytes);
}

/** État partagé par tout composant qui affiche un ThumbHash flou en fond
 * pendant le chargement de l'affiche réelle (MediaCard, DetailPage,
 * TonightPick) : décode le hash une seule fois, et expose `loaded` pour
 * garder l'<img> masquée (opacity 0) tant qu'elle n'a pas fini de charger.
 * Sans ça, le navigateur peint l'image au fur et à mesure du téléchargement
 * par-dessus le flou encore visible dessous — rendu mi-net mi-flou signalé
 * sur la carte Trello "ThumbHash affiches" (retour du 2026-10-17). */
export function usePosterThumbhash(thumbhash?: string | null) {
  const [loaded, setLoaded] = useState(false);
  const dataUrl = useMemo(() => (thumbhash ? thumbhashToDataUrl(thumbhash) : null), [thumbhash]);
  const markLoaded = useCallback(() => setLoaded(true), []);
  // Ref posée sur l'<img> : couvre le cas où elle est déjà en cache
  // navigateur au moment du montage. Dans ce cas, certains navigateurs
  // (Safari notamment) ne redéclenchent pas l'évènement `load` une fois le
  // décodage déjà terminé avant que React n'attache l'écouteur — sans ce
  // filet, l'<img> resterait masquée (opacity 0) indéfiniment, un résultat
  // pire que le bug d'origine (retour revue, carte Trello "ThumbHash
  // affiches").
  const imgRef = useCallback(
    (img: HTMLImageElement | null) => {
      if (img?.complete) {
        markLoaded();
      }
    },
    [markLoaded]
  );
  const backgroundStyle: CSSProperties | undefined =
    dataUrl && !loaded
      ? {
          backgroundImage: `url(${dataUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }
      : undefined;
  return {
    hasThumbhash: dataUrl != null,
    loaded,
    backgroundStyle,
    imgRef,
    onLoad: markLoaded,
    onError: markLoaded,
  };
}
