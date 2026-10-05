// Fonctions PURES de dérivation de métadonnées film/série (durée estimée,
// date de sortie ciné FR, formatage de date, statut "au cinéma"). Isolées
// à dessein : aucune dépendance à `import.meta.env` ni au réseau, donc
// directement testables sous Node natif (voir scripts/verify-movie-meta.ts)
// et importables par le client Vite, qui les réexporte depuis tmdb.ts pour
// ne pas changer les points d'import existants. Une seule source de
// vérité, aucune copie à synchroniser.
import type { MediaDetails, MediaType, ReleaseDatesResponse } from "../types/tmdb.ts";
import { DEFAULT_REGION } from "./releaseBadge.ts";

/** Sous-ensemble de MediaDetails réellement consommé ici — accepte aussi un
 * objet partiel/`null` (fiche pas encore chargée, ou test avec des données
 * incomplètes), voir les appels de MediaCard/Detail/Random. */
type RuntimeSource = Pick<
  MediaDetails,
  | "runtime"
  | "episode_run_time"
  | "number_of_episodes"
  | "last_episode_to_air"
  | "next_episode_to_air"
> | null;

// Durée totale estimée en minutes. Film : `runtime` tel quel. Série : pas
// de durée globale chez TMDB, on l'estime en durée d'un épisode ×
// nombre d'épisodes. `null` si l'information manque (repli côté appelant).
//
// `episode_run_time` (durée globale série) est de plus en plus souvent un
// tableau vide chez TMDB (constaté sur Breaking Bad par ex., alors que la
// série a bien une durée par épisode) : sans repli, toute série concernée
// ressort avec une durée de 0 dans les statistiques, y compris pour un
// titre marqué vu (voir ticket Trello "Amélioration statistiques", retour
// "le bouton vu d'une série ne la compte pas dans les statistiques"). On se
// rabat sur la durée du dernier épisode diffusé, puis du prochain à venir,
// toutes deux bien renseignées par TMDB même quand episode_run_time est vide.
export function estimateRuntimeMinutes(
  details: RuntimeSource,
  mediaType: MediaType
): number | null {
  if (mediaType === "movie") {
    return details?.runtime || null;
  }
  const perEpisode =
    details?.episode_run_time?.[0] ||
    details?.last_episode_to_air?.runtime ||
    details?.next_episode_to_air?.runtime;
  const episodeCount = details?.number_of_episodes;
  if (!perEpisode || !episodeCount) {
    return null;
  }
  return perEpisode * episodeCount;
}

// TMDB ne donne pas de date de fin d'exploitation en salle : on considère
// un film "encore au cinéma" s'il est sorti il y a moins de 6 semaines.
export const THEATRICAL_WINDOW_DAYS = 42;

// Type de sortie TMDB : 3 = sortie nationale en salles, 2 = sortie limitée
// en salles. On préfère la sortie nationale (la plus ancienne s'il y en a
// plusieurs) ; UNIQUEMENT à défaut, la sortie limitée (la plus ancienne).
// NB : on choisit d'abord le TYPE, puis la date la plus ancienne DANS ce
// type — et non la date la plus ancienne tous types confondus, sinon une
// sortie limitée antérieure masquerait la sortie nationale qu'on veut
// privilégier.
function extractTheatricalDate(
  releaseDatesResponse: ReleaseDatesResponse | undefined,
  region: string
): string | null {
  const entry = releaseDatesResponse?.results?.find((r) => r.iso_3166_1 === region);
  if (!entry) {
    return null;
  }
  const earliestOfType = (type: number) =>
    (entry.release_dates || [])
      .filter((rd) => rd.type === type)
      .sort((a, b) => a.release_date.localeCompare(b.release_date))[0];
  const theatrical = earliestOfType(3) || earliestOfType(2);
  return theatrical ? theatrical.release_date.slice(0, 10) : null;
}

// Pour la fiche détail : `details` vient de getDetails(), qui inclut déjà
// release_dates (pas d'appel réseau supplémentaire). `region` : région
// détectée du visiteur (RegionContext) — repli sur DEFAULT_REGION ("FR")
// si non fournie.
export function getTheatricalDateFromDetails(
  details: Pick<MediaDetails, "release_dates"> | null | undefined,
  region: string = DEFAULT_REGION
): string | null {
  return extractTheatricalDate(details?.release_dates, region);
}

// Locale d'affichage des dates — union locale à ce module (pas d'import
// depuis core/i18n/i18n.ts, qui a un effet de bord d'initialisation
// react-i18next à l'import : casserait l'exécution sous Node natif de ce
// module, voir commentaire de tête). Les valeurs correspondent à celles de
// Locale (core/i18n/i18n.ts) ; à tenir synchronisé si une langue est ajoutée.
export type DateLocale = "fr" | "en";

const DATE_LOCALE_TAGS: Record<DateLocale, string> = {
  fr: "fr-FR",
  en: "en-US",
};

// Tag BCP47 (ex. "fr-FR") pour `Intl`/`toLocaleDateString` à partir de la
// locale active de l'app — point d'entrée unique pour ne pas éparpiller ce
// mapping dans chaque composant qui formate une date.
export function dateLocaleTag(locale: DateLocale): string {
  return DATE_LOCALE_TAGS[locale];
}

// Date complète lisible (ex. "12 septembre 2026" / "September 12, 2026"),
// films et séries — plus précis que l'année seule affichée jusqu'ici sur
// les cartes/lignes de liste. `null` si la date est absente ou invalide
// (repli sur l'année seule côté appelant).
export function formatFullDate(
  dateString: string | null | undefined,
  locale: DateLocale = "fr"
): string | null {
  if (!dateString) {
    return null;
  }
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toLocaleDateString(dateLocaleTag(locale), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export type TheatricalStatus = "upcoming" | "in_theaters" | "past";

// "upcoming" (pas encore sorti), "in_theaters" (sorti il y a moins de
// THEATRICAL_WINDOW_DAYS), "past" (sorti plus tôt), ou null si aucune date
// de sortie cinéma n'est connue pour ce titre dans la région du visiteur
// (VOD/streaming direct, film jamais distribué en salle dans ce pays...).
// Utilisé sur la fiche détail (une seule date, déjà connue précisément via
// extractTheatricalDate).
export function theatricalStatusFromDate(
  dateString: string | null | undefined
): TheatricalStatus | null {
  if (!dateString) {
    return null;
  }
  const diffDays = (Date.now() - new Date(dateString).getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays < 0) {
    return "upcoming";
  }
  if (diffDays <= THEATRICAL_WINDOW_DAYS) {
    return "in_theaters";
  }
  return "past";
}
