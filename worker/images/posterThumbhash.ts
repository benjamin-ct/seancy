// Calcule un ThumbHash à la demande, depuis le Worker, pour une affiche
// jamais rencontrée par le batch CI (`scripts/generate-thumbhashes.ts`,
// voir ticket Trello "ThumbHash affiches") — ex. un titre de
// recommandation qui vient d'entrer dans `popular_titles` avant le
// prochain run quotidien.
//
// Décodage/redimensionnement via `@jsquash/jpeg` + `@jsquash/resize`
// (WASM pur) plutôt que `sharp` (utilisé en CI) : `sharp` dépend de
// bindings natifs (libvips) indisponibles dans le runtime Workers, même
// avec `nodejs_compat` — ça ne tournerait tout simplement pas ici, quel
// que soit le budget CPU. Benchmarké en conditions réelles (wrangler dev
// local) : ~6 ms CPU une fois les modules WASM chauds (même ordre de
// grandeur que le chiffre `sharp` mesuré côté CI), ~25 ms au premier appel
// d'un isolate neuf (coût d'instanciation des deux modules WASM, une
// seule fois par isolate).
//
// Toujours appelé via `ctx.waitUntil` (jamais dans le chemin synchrone
// d'une requête) : si le budget CPU de `waitUntil` est dépassé, le calcul
// est simplement coupé net, sans erreur visible — au pire la prochaine
// vue de cette affiche retente.
import decodeJpeg, { init as initJpegDecoder } from "@jsquash/jpeg/decode.js";
import resizeImage, { initResize } from "@jsquash/resize/index.js";
import { rgbaToThumbHash } from "thumbhash";
import type { Env } from "../types.ts";
import JPEG_DECODER_WASM from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
// @ts-expect-error - ce .wasm a son propre .d.ts fourni par le paquet
// (squoosh_resize_bg.wasm.d.ts, généré par wasm-bindgen pour un tout autre
// usage), qui masque la déclaration ambiante `*.wasm` et décrit des exports
// nommés au lieu d'un module WebAssembly — ne reflète pas ce que fait
// réellement le bundler de Wrangler ici (validé en conditions réelles,
// `wrangler dev`, voir le commentaire d'en-tête du fichier).
import RESIZE_WASM from "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm";

// w92 : même taille que `scripts/generate-thumbhashes.ts`, déjà proche du
// max recommandé par ThumbHash (100x100) et léger à télécharger/décoder.
const POSTER_BASE = "https://image.tmdb.org/t/p/w92";
const THUMBHASH_SIZE = 100;

let wasmReady: Promise<void> | null = null;

// Les deux modules WASM ne s'instancient qu'une fois par isolate (coût
// payé une seule fois, jamais par requête) : `initJpegDecoder`/`initResize`
// sont déjà idempotents côté jsquash, ce verrou évite seulement l'appel
// concurrent de deux calculs fire-and-forget avant la fin du premier init.
function ensureWasmReady(): Promise<void> {
  if (!wasmReady) {
    wasmReady = Promise.all([
      initJpegDecoder(JPEG_DECODER_WASM as WebAssembly.Module),
      initResize(RESIZE_WASM as WebAssembly.Module),
    ]).then(() => undefined);
  }
  return wasmReady;
}

export async function computePosterThumbhash(posterPath: string): Promise<string | null> {
  const res = await fetch(`${POSTER_BASE}${posterPath}`);
  if (!res.ok) {
    console.warn(`Affiche ${posterPath} inaccessible (${res.status}), ThumbHash ignoré.`);
    return null;
  }
  await ensureWasmReady();
  const decoded = await decodeJpeg(await res.arrayBuffer());
  // Équivalent de `sharp(...).resize(100, 100, { fit: "inside",
  // withoutEnlargement: true })` côté CI (scripts/generate-thumbhashes.ts) :
  // le plus grand côté est ramené à 100 au maximum (jamais agrandi), l'autre
  // suit le ratio — sans ça, une affiche portrait (quasi toutes) dépasse
  // 100 en hauteur si on fixe seulement la largeur, ce que ThumbHash rejette.
  const longestSide = Math.max(decoded.width, decoded.height);
  const scale = Math.min(1, THUMBHASH_SIZE / longestSide);
  const targetWidth = Math.max(1, Math.round(decoded.width * scale));
  const targetHeight = Math.max(1, Math.round(decoded.height * scale));
  const resized =
    targetWidth === decoded.width && targetHeight === decoded.height
      ? decoded
      : await resizeImage(decoded, { width: targetWidth, height: targetHeight });
  const hash = rgbaToThumbHash(resized.width, resized.height, resized.data);
  return btoa(String.fromCharCode(...hash));
}

// INSERT OR IGNORE plutôt que REPLACE : si le batch CI a écrit la ligne
// entre le moment où l'appelant a vu `poster_thumbhash IS NULL` et la fin
// de ce calcul, on garde la valeur déjà en base (même algorithme, résultat
// identique) plutôt que de la réécrire pour rien.
async function storePosterThumbhash(env: Env, posterPath: string, hash: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO poster_thumbhashes (poster_path, thumbhash, computed_at) VALUES (?, ?, ?)`
  )
    .bind(posterPath, hash, Date.now())
    .run();
}

// Point d'entrée pour un appel `ctx.waitUntil` : ne lève jamais, une
// affiche qui échoue à se calculer reste simplement sur le shimmer
// existant côté client jusqu'à la prochaine tentative.
export async function computeAndStorePosterThumbhash(env: Env, posterPath: string): Promise<void> {
  try {
    const hash = await computePosterThumbhash(posterPath);
    if (hash) {
      await storePosterThumbhash(env, posterPath, hash);
    }
  } catch (err) {
    console.warn(`ThumbHash à la demande échoué pour ${posterPath} :`, err);
  }
}
