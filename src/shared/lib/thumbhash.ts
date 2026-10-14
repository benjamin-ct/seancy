// Décodage ThumbHash côté client (voir migration 0021,
// scripts/generate-thumbhashes.ts, MediaCard.tsx) : transforme le ThumbHash
// base64 renvoyé par l'API en data URL affichable pendant le chargement de
// la vraie affiche.
import { thumbHashToDataURL } from "thumbhash";

export function thumbhashToDataUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return thumbHashToDataURL(bytes);
}
