import type { TFunction } from "i18next";

// « 2 h 46 » plutôt que « 166 min » (maquette) ; les durées de moins d'une
// heure (épisodes) restent en minutes. Partagé entre la fiche (film, durée
// moyenne d'un épisode) et le détail de chaque épisode du bloc Épisodes.
export function formatRuntime(t: TFunction, minutes: number): string {
  if (minutes < 60) {
    return t("detailPage.runtimeMinutes", { count: minutes });
  }
  const m = minutes % 60;
  return t("detailPage.runtimeHours", {
    hours: Math.floor(minutes / 60),
    minutes: String(m).padStart(2, "0"),
    count: m,
  });
}
