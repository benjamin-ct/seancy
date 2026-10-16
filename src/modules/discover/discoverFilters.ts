import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DEFAULT_SORT_FIELD,
  DEFAULT_SORT_DIRECTION,
  EMPTY_ADVANCED_FILTERS,
} from "../../shared/components/index.ts";
import type { AdvancedFiltersState } from "../../shared/components/index.ts";
import { SORT_FIELDS } from "../../core/api/tmdb.ts";
import type { MediaType } from "../../core/types/tmdb.ts";
import type { DiscoverSortField, SortDirection } from "../../core/api/tmdb.ts";

// Filtres de la grille Découvrir, lus depuis l'URL (audit M13) : une
// recherche filtrée peut être partagée, mise en favori, et survit au
// rechargement comme au retour arrière (chaque entrée d'historique garde
// sa propre URL).
export interface DiscoverFilters {
  mediaType: MediaType;
  genreIds: number[];
  providerIds: string[];
  useMyPlatforms: boolean;
  sortField: DiscoverSortField;
  sortDirection: SortDirection;
  advanced: AdvancedFiltersState;
  /** Films actuellement en salle (region_release_date résolu par le Worker,
   * même indicateur que le badge "Salles" de MediaCard) — sans effet pour
   * les séries, qui n'ont pas de notion de sortie ciné. */
  inTheatersOnly: boolean;
}

// Noms des paramètres d'URL, en français comme les routes (?liste=… dans Ma
// liste). Seules les valeurs différentes du défaut sont écrites, pour que
// l'accueil sans filtre garde une URL nue.
const PARAM = {
  mediaType: "type",
  genreIds: "genres",
  providerIds: "plateformes",
  useMyPlatforms: "mesPlateformes",
  sortField: "tri",
  sortDirection: "ordre",
  inTheatersOnly: "enSalle",
} as const;

const ADVANCED_PARAMS: Record<keyof AdvancedFiltersState, string> = {
  yearMin: "anneeMin",
  yearMax: "anneeMax",
  voteAverageMin: "noteMin",
  voteAverageMax: "noteMax",
  voteCountMin: "votesMin",
  originCountry: "pays",
  runtimeMin: "dureeMin",
  runtimeMax: "dureeMax",
};

function parseList(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => /^\d+$/.test(v));
}

// Une URL modifiée à la main (ou venue d'une ancienne version) ne doit
// jamais casser la page : toute valeur inattendue retombe sur le défaut.
export function parseDiscoverFilters(params: URLSearchParams): DiscoverFilters {
  const sortField = params.get(PARAM.sortField);
  const advanced = { ...EMPTY_ADVANCED_FILTERS };
  for (const [key, name] of Object.entries(ADVANCED_PARAMS) as [
    keyof AdvancedFiltersState,
    string,
  ][]) {
    const value = params.get(name)?.trim() ?? "";
    if (key === "originCountry") {
      advanced[key] = /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : "";
    } else {
      advanced[key] = value !== "" && Number.isFinite(Number(value)) ? value : "";
    }
  }
  return {
    mediaType: params.get(PARAM.mediaType) === "tv" ? "tv" : "movie",
    genreIds: parseList(params.get(PARAM.genreIds)).map(Number),
    providerIds: parseList(params.get(PARAM.providerIds)),
    useMyPlatforms: params.get(PARAM.useMyPlatforms) === "1",
    sortField: SORT_FIELDS.some((s) => s.value === sortField)
      ? (sortField as DiscoverSortField)
      : DEFAULT_SORT_FIELD,
    sortDirection:
      params.get(PARAM.sortDirection) === "asc" || params.get(PARAM.sortDirection) === "desc"
        ? (params.get(PARAM.sortDirection) as SortDirection)
        : DEFAULT_SORT_DIRECTION,
    advanced,
    inTheatersOnly: params.get(PARAM.inTheatersOnly) === "1",
  };
}

// Repart des paramètres existants pour ne pas effacer ceux qu'un autre
// composant aurait posés sur la même URL.
export function writeDiscoverFilters(
  base: URLSearchParams,
  filters: DiscoverFilters
): URLSearchParams {
  const params = new URLSearchParams(base);
  const set = (name: string, value: string, defaultValue = "") => {
    if (value === defaultValue) {
      params.delete(name);
    } else {
      params.set(name, value);
    }
  };
  set(PARAM.mediaType, filters.mediaType, "movie");
  set(PARAM.genreIds, filters.genreIds.join(","));
  set(PARAM.providerIds, filters.providerIds.join(","));
  set(PARAM.useMyPlatforms, filters.useMyPlatforms ? "1" : "");
  set(PARAM.sortField, filters.sortField, DEFAULT_SORT_FIELD);
  set(PARAM.sortDirection, filters.sortDirection, DEFAULT_SORT_DIRECTION);
  set(PARAM.inTheatersOnly, filters.inTheatersOnly ? "1" : "");
  for (const [key, name] of Object.entries(ADVANCED_PARAMS) as [
    keyof AdvancedFiltersState,
    string,
  ][]) {
    set(name, filters.advanced[key].trim());
  }
  return params;
}

export function useDiscoverFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.toString();
  // Mémoïsé sur la chaîne de l'URL : les tableaux (genreIds, providerIds)
  // gardent la même référence tant que l'URL ne change pas, sinon chaque
  // rendu relancerait les effets de chargement de DiscoverPage.
  const filters = useMemo(() => parseDiscoverFilters(new URLSearchParams(search)), [search]);

  // Dernier état écrit, pas encore rendu : « Tout effacer » du FilterPanel
  // appelle plusieurs setters d'affilée dans le même clic, et
  // setSearchParams ne compose pas ces appels (chacun repartirait de l'URL
  // du rendu courant et écraserait le précédent).
  const pendingRef = useRef<{ search: string; filters: DiscoverFilters } | null>(null);
  useEffect(() => {
    pendingRef.current = null;
  }, [search]);

  const update = useCallback(
    (patch: (current: DiscoverFilters) => Partial<DiscoverFilters>) => {
      const current = pendingRef.current?.filters ?? filters;
      const next = { ...current, ...patch(current) };
      const base = new URLSearchParams(pendingRef.current?.search ?? search);
      const nextParams = writeDiscoverFilters(base, next);
      pendingRef.current = { search: nextParams.toString(), filters: next };
      // replace : modifier un filtre ne crée pas d'entrée d'historique (le
      // retour arrière ramène à la page précédente, pas au filtre précédent).
      setSearchParams(nextParams, { replace: true, preventScrollReset: true });
    },
    [filters, search, setSearchParams]
  );

  const setters = useMemo(
    () => ({
      // Changer de type (Films/Séries) vide les genres : leurs ids diffèrent
      // entre films et séries. "En salle" n'a pas de sens pour les séries
      // (pas de notion de sortie ciné), donc il repart à zéro aussi.
      setMediaType: (mediaType: MediaType) =>
        update((current) =>
          current.mediaType === mediaType ? {} : { mediaType, genreIds: [], inTheatersOnly: false }
        ),
      setGenreIds: (genreIds: number[]) => update(() => ({ genreIds })),
      setProviderIds: (providerIds: string[]) => update(() => ({ providerIds })),
      setUseMyPlatforms: (useMyPlatforms: boolean) => update(() => ({ useMyPlatforms })),
      setSortField: (sortField: DiscoverSortField) => update(() => ({ sortField })),
      setSortDirection: (sortDirection: SortDirection) => update(() => ({ sortDirection })),
      setAdvanced: (updater: (prev: AdvancedFiltersState) => AdvancedFiltersState) =>
        update((current) => ({ advanced: updater(current.advanced) })),
      setInTheatersOnly: (inTheatersOnly: boolean) => update(() => ({ inTheatersOnly })),
    }),
    [update]
  );

  return { ...filters, ...setters };
}
