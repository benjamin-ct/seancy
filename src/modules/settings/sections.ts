import type { IconName } from "../../shared/components/Icon/Icon.tsx";

export interface SettingsSection {
  /** Segment de route sous /reglages/<id>, et clé de titre settings.sections.<id>. */
  id: string;
  icon: IconName;
}

// Sommaire de /reglages (refonte Profil/Préférences) : un identifiant =
// un segment de route sous /reglages/<id> = une ligne du sommaire, avec son
// titre dans settings.sections.<id>.title. L'ordre ici est celui
// d'affichage dans la navigation. Le résumé d'état d'une ligne (ex. « 3
// plateformes actives ») est calculé dynamiquement, voir SettingsSummary.tsx.
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: "compte", icon: "user" },
  { id: "confidentialite", icon: "lock" },
  { id: "plateformes", icon: "grid" },
  { id: "recommandations", icon: "target" },
  { id: "notifications", icon: "bell" },
  { id: "affichage", icon: "sliders" },
  { id: "donnees", icon: "download" },
  { id: "a-propos", icon: "help" },
];
