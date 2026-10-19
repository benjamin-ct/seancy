// Garde-fou CI (ticket Trello "Épique git-flow : CI preprod avancée sur
// develop", gates proposées par Benjy_CT le 2026-10-09 : "vérifier que les
// numéros de version ne se marchent pas dessus" + "le changement de version
// est cohérent") : le champ `version` de package.json n'est modifié QUE par
// le job release-changelog (voir scripts/changelogRelease.ts, ci.yml), au
// merge d'une release sur `main` — jamais à la main dans une PR de feature.
// Une PR qui le change quand même, volontairement ou par un merge/rebase
// malheureux, créerait soit une collision de version (deux PR distinctes
// proposant chacune leur propre bump), soit une incohérence avec le bump
// réellement calculé à partir des fragments .changeset/ accumulés.
//
// BASE_REF doit pointer vers une réf déjà fetchée localement (voir le job
// CI, qui checkout avec fetch-depth: 0) — absent, on considère qu'il n'y a
// rien à vérifier (hors contexte de PR, ex. push direct sur develop/main).

import { execFileSync } from "node:child_process";

const baseRef = process.env.BASE_REF;
if (!baseRef) {
  console.log("BASE_REF non fourni (pas une PR) : rien à vérifier.");
  process.exit(0);
}

function versionAt(ref: string): string | null {
  try {
    const content = execFileSync("git", ["show", `${ref}:package.json`], { encoding: "utf8" });
    const match = content.match(/"version":\s*"([^"]+)"/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

const baseVersion = versionAt(baseRef);
const headVersion = versionAt("HEAD");

if (baseVersion === null || headVersion === null) {
  console.log("package.json introuvable sur une des deux réfs : rien à vérifier.");
  process.exit(0);
}

if (baseVersion !== headVersion) {
  console.error(
    `Le champ "version" de package.json a changé (${baseVersion} → ${headVersion}). ` +
      "Il est géré automatiquement au merge d'une release sur main (voir scripts/changelogRelease.ts) : " +
      "ne le modifiez jamais à la main dans une PR de feature."
  );
  process.exit(1);
}

console.log(`OK : version package.json inchangée (${baseVersion}).`);
