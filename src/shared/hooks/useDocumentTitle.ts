import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DEV_TITLE_PREFIX, isDevSite } from "../../core/lib/devSite.ts";

// Titre de l'onglet par page (audit H11) : « Dune (2021) — Seancy » plutôt
// que le même titre partout, pour l'historique, les onglets, le partage et
// les lecteurs d'écran. `page` null/vide (données pas encore chargées, ou
// page d'accueil) : titre par défaut de l'appli. Le titre par défaut est
// remis en place quand la page est quittée, pour qu'une page sans titre
// propre n'hérite pas de celui de la précédente. Sur le site de
// développement, chaque titre commence par « [Dev] ».
const prefix = isDevSite ? DEV_TITLE_PREFIX : "";

export function useDocumentTitle(page: string | null | undefined): void {
  const { t } = useTranslation();
  const title = prefix + (page ? t("pageTitle.withSuffix", { page }) : t("pageTitle.default"));

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(
    () => () => {
      document.title = prefix + t("pageTitle.default");
    },
    [t]
  );
}
