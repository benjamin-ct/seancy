// Client pour les suggestions IA « Pour vous ce soir » — génération,
// cache et repli vivent côté Worker (voir worker/ai-suggestions.ts) ; le
// Worker ne renvoie que des identifiants, la fiche affichée est chargée
// dans la langue active via le proxy TMDB habituel (voir TonightPick).
import { syncClientHeaders } from "../sync/liveSync.ts";
import type { MediaType } from "../types/tmdb.ts";

export interface TonightSuggestion {
  mediaType: MediaType;
  id: number;
}

// "pending" : lot du jour en cours de génération, à redemander dans
// quelques secondes. "fallback" : lot calculé par l'algo non-IA (quota
// Workers AI dépassé...), affiché exactement comme "ready".
export type TonightSuggestionsResponse =
  { status: "pending" } | { status: "ready" | "fallback"; items: TonightSuggestion[] };

export class TonightSuggestionsAuthError extends Error {}

export async function getTonightSuggestions(
  signal?: AbortSignal
): Promise<TonightSuggestionsResponse> {
  const res = await fetch("/api/tonight-suggestions", { signal });
  if (res.status === 401) {
    throw new TonightSuggestionsAuthError("Non connecté.");
  }
  if (!res.ok) {
    throw new Error(`Erreur suggestions du soir (${res.status})`);
  }
  return (await res.json()) as TonightSuggestionsResponse;
}

export async function postTonightSkip(item: TonightSuggestion): Promise<void> {
  const res = await fetch("/api/tonight-suggestions/skip", {
    method: "POST",
    headers: { "content-type": "application/json", ...syncClientHeaders() },
    body: JSON.stringify({ mediaType: item.mediaType, tmdbId: item.id }),
  });
  if (!res.ok) {
    throw new Error(`Erreur "autre suggestion" (${res.status})`);
  }
}
