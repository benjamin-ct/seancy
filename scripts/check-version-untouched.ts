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
//
// Exception structurelle : une release `develop` → `main` verra
// systématiquement `develop` en retard de version sur `main`, par
// construction — le bump du hotfix précédent (release-changelog, sur
// `main` uniquement) n'est jamais backporté sur `develop` (voir le commit
// de backport qui le retire explicitement). Le futur numéro de version est
// de toute façon recalculé par release-changelog à partir du package.json
// de `main`, jamais lu depuis celui de `develop`.
//
// Cette exception est volontairement étroite, pour ne pas rouvrir la porte
// que ce garde-fou est censé fermer :
// - HEAD_REPO/BASE_REPO doivent être le même dépôt : sans ça, n'importe quel
//   fork peut nommer sa branche "develop" et ouvrir une PR vers `main` pour
//   se faire passer pour une release (HEAD_REF, lui, est bien le nom de
//   branche réel fourni par GitHub Actions, mais pas lié au dépôt d'origine).
// - on ne désactive pas la comparaison, on assouplit juste le sens autorisé
//   de l'écart (head <= base, jamais head > base) : un squash-merge
//   malheureux de cette PR de release, qui écraserait le package.json de
//   `main` avec celui de `develop`, reste détecté (puisqu'un vrai merge, par
//   contraste, préserve la version de `main` sans conflit sur cette ligne).

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

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/** -1 si a < b, 0 si égales, 1 si a > b ; `null` si l'une des deux n'est pas un SemVer x.y.z. */
function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const ma = a.match(SEMVER_PATTERN);
  const mb = b.match(SEMVER_PATTERN);
  if (!ma || !mb) {
    return null;
  }
  for (let i = 1; i <= 3; i++) {
    const diff = Number(ma[i]) - Number(mb[i]);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
}

const isSameRepo =
  !!process.env.HEAD_REPO &&
  !!process.env.BASE_REPO &&
  process.env.HEAD_REPO === process.env.BASE_REPO;
const isReleasePr = isSameRepo && process.env.HEAD_REF === "develop" && baseRef === "origin/main";

if (baseVersion !== headVersion) {
  if (isReleasePr && compareSemver(headVersion, baseVersion) === -1) {
    console.log(
      `Release develop → main : develop (${headVersion}) en retard sur main (${baseVersion}), ` +
        "attendu (le bump du dernier hotfix n'est jamais backporté) — recalculé par release-changelog au merge."
    );
    process.exit(0);
  }
  console.error(
    `Le champ "version" de package.json a changé (${baseVersion} → ${headVersion}). ` +
      "Il est géré automatiquement au merge d'une release sur main (voir scripts/changelogRelease.ts) : " +
      "ne le modifiez jamais à la main dans une PR de feature."
  );
  process.exit(1);
}

console.log(`OK : version package.json inchangée (${baseVersion}).`);
