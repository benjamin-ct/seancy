// Compilation des fragments de changelog (.changeset/*.md, voir
// .changeset/README.md et scripts/changesetLib.ts) en une entrée CHANGELOG.md
// + bump SemVer — ticket Trello "Épique git-flow : release develop→main
// automatisée". Logique pure testable séparément (voir
// verify-changelog-release.ts) ; la partie qui touche au système de fichiers
// (CHANGELOG.md, package.json, suppression des fragments) est dans main()
// plus bas, jamais appelée par les tests.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isChangesetError, readChangesets, type Bump, type Changeset } from "./changesetLib.ts";

const CHANGELOG_PATH = "CHANGELOG.md";
const CHANGELOG_HEADER =
  "# Changelog\n\nFormat libre, une entrée par release. Généré automatiquement au merge d'une release (voir .changeset/README.md).\n";

// Un bump "plus fort" l'emporte sur les autres fragments de la même release
// (ex. un fragment `patch` et un fragment `minor` dans la même release →
// release `minor`) — c'est la définition même de SemVer : la version reflète
// le changement le plus significatif inclus.
const BUMP_SEVERITY: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };

export function aggregateBump(changesets: Changeset[]): Bump {
  return changesets.reduce<Bump>(
    (acc, c) => (BUMP_SEVERITY[c.bump] > BUMP_SEVERITY[acc] ? c.bump : acc),
    "patch"
  );
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function bumpVersion(current: string, bump: Bump): string {
  const match = current.match(SEMVER_PATTERN);
  if (!match) {
    throw new Error(`Version "${current}" n'est pas un SemVer valide (attendu x.y.z).`);
  }
  let [major, minor, patch] = match.slice(1).map(Number);
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

const SECTION_TITLES: Record<Bump, string> = {
  major: "Changements majeurs",
  minor: "Nouveautés",
  patch: "Correctifs",
};
// Ordre d'affichage dans l'entrée : le plus marquant en premier.
const SECTION_ORDER: Bump[] = ["major", "minor", "patch"];

export function formatChangelogEntry(
  version: string,
  date: string,
  changesets: Changeset[]
): string {
  const lines = [`## ${version} — ${date}`, ""];
  for (const bump of SECTION_ORDER) {
    const entries = changesets.filter((c) => c.bump === bump);
    if (entries.length === 0) {
      continue;
    }
    lines.push(`### ${SECTION_TITLES[bump]}`, "");
    for (const c of entries) {
      // Un fragment multi-lignes reste un seul point de liste : les lignes
      // suivantes sont indentées pour rester rattachées au même `-`.
      const [first, ...rest] = c.summary.split("\n");
      lines.push(`- ${first}`, ...rest.map((l) => `  ${l}`));
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export interface ReleasePlan {
  nextVersion: string;
  changelogEntry: string;
}

/** `null` si aucun fragment à compiler (rien à releaser). */
export function planRelease(
  currentVersion: string,
  changesets: Changeset[],
  date: string
): ReleasePlan | null {
  if (changesets.length === 0) {
    return null;
  }
  const nextVersion = bumpVersion(currentVersion, aggregateBump(changesets));
  const changelogEntry = formatChangelogEntry(nextVersion, date, changesets);
  return { nextVersion, changelogEntry };
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  return pkg.version;
}

function prependChangelog(entry: string): void {
  const existing = existsSync(CHANGELOG_PATH)
    ? readFileSync(CHANGELOG_PATH, "utf8")
    : CHANGELOG_HEADER;
  // Insère juste après l'en-tête (avant la première entrée déjà présente),
  // pas au tout début : l'en-tête doit rester la première chose du fichier.
  const splitAt = existing.indexOf("\n## ");
  const header = splitAt === -1 ? existing.trimEnd() + "\n" : existing.slice(0, splitAt + 1);
  const rest = splitAt === -1 ? "" : existing.slice(splitAt + 1);
  writeFileSync(CHANGELOG_PATH, `${header}\n${entry}${rest}`);
}

function main(): void {
  const results = readChangesets();
  const errors = results.filter(isChangesetError);
  if (errors.length > 0) {
    // Ne devrait pas arriver : check-changeset.ts (CI, à chaque PR) rejette
    // déjà tout fragment invalide avant le merge. Garde-fou défensif si un
    // fragment a quand même atteint `develop` autrement (push direct...).
    for (const e of errors) {
      console.error(`${e.file} : ${e.reason}`);
    }
    process.exit(1);
  }
  const changesets = results.filter((r): r is Changeset => !isChangesetError(r));
  const currentVersion = readPackageVersion();
  const date = new Date().toISOString().slice(0, 10);
  const plan = planRelease(currentVersion, changesets, date);
  if (!plan) {
    console.log("Aucun fragment de changelog (.changeset/*.md) à compiler : rien à releaser.");
    return;
  }

  prependChangelog(plan.changelogEntry);
  // `npm version` met à jour package.json ET package-lock.json de façon
  // cohérente (plutôt qu'une édition manuelle des deux fichiers) ; pas de
  // commit/tag git ici, laissé au workflow CI qui connaît le contexte
  // (message de commit, push) — voir .github/workflows/ci.yml.
  execFileSync(
    "npm",
    ["version", plan.nextVersion, "--no-git-tag-version", "--allow-same-version"],
    { stdio: "inherit" }
  );
  for (const c of changesets) {
    unlinkSync(c.file);
  }

  console.log(`Release ${plan.nextVersion} : ${changesets.length} fragment(s) compilé(s).`);
  // Repris par le workflow CI pour le message de commit (voir ci.yml).
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    writeFileSync(githubOutput, `version=${plan.nextVersion}\n`, { flag: "a" });
  }
}

if (process.argv[1]?.endsWith("changelogRelease.ts")) {
  main();
}
