// Réduction des images avant leur envoi dans un ticket (import Trello,
// captures de Claude) : le Worker n'a que 10 ms de calcul par requête sur le
// forfait gratuit, et enregistrer une grosse image dans D1 les dépasse
// (« exceededCpu », HTTP 503). Au-delà de 150 Ko, une image PNG, JPEG ou
// WebP est convertie en WebP (1 400 px de côté au plus, qualité 75) : une
// capture d'écran passe d'environ 1 Mo à moins de 150 Ko.
export const SHRINK_ABOVE = 150_000;

export interface Upload {
  bytes: Uint8Array;
  type: string;
  name: string;
}

/** `suffix` : ajouté au nom du fichier converti (ex. identifiant de la pièce jointe, pour le retrouver). */
export async function shrinkImage(file: Upload, suffix = ""): Promise<Upload> {
  if (file.bytes.length <= SHRINK_ABOVE || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
    return file;
  }
  const { default: sharp } = await import("sharp");
  const out = await sharp(file.bytes)
    .rotate()
    .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();
  return {
    bytes: new Uint8Array(out),
    type: "image/webp",
    name: `${file.name.replace(/\.\w+$/, "")}${suffix}.webp`,
  };
}

/** Nom tel que le Worker l'enregistre (worker/tickets.ts, putFile). */
export const storedName = (name: string) =>
  (name.split(/[\\/]/).pop() ?? "").replace(/[^\p{L}\p{N}._ -]+/gu, "-").slice(0, 120) || "fichier";
