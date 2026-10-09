// Schéma partagé front/Worker (audit F6) pour la seule valeur externe la
// plus sensible à mal valider : `mediaType`, lu depuis une URL (route
// /media/:mediaType/:id côté front, segments de route API côté Worker) et
// réutilisé tel quel dans des chemins d'appel TMDB (`/{mediaType}/{id}`).
// Non validé, une valeur arbitraire (`/media/foo/1`) part vers TMDB sans
// filtrage. `v.picklist` plutôt qu'un `Set`/cast manuel : une seule source
// de vérité, importable aussi bien par `tsconfig.app.json` (front) que
// `tsconfig.worker.json` (Worker, voir son `include`).
import * as v from "valibot";
import type { MediaType } from "../types/tmdb.ts";

export const MediaTypeSchema = v.picklist(["movie", "tv"] as const satisfies readonly MediaType[]);

export function isMediaType(value: unknown): value is MediaType {
  return v.safeParse(MediaTypeSchema, value).success;
}
