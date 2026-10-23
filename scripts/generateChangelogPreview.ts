// Aperçu du changelog pour l'environnement develop persistant (ticket Trello
// "Changelog pas à jour sur develop") : compile les fragments .changeset/*.md
// en attente, comme le ferait release-changelog au prochain push sur main,
// mais sans committer ni consommer les fragments — juste pour que la page
// /changelog de develop reflète ce qui serait publié, et que son contenu
// puisse être validé avant de merger develop -> main. N'écrit que dans le
// checkout du job CI qui appelle ce script juste avant `npm run build` (voir
// ci.yml, job deploy-develop) : jamais poussé sur `develop`.

import { readFileSync, writeFileSync } from "node:fs";
import { isChangesetError, readChangesets } from "./changesetLib.ts";
import { formatChangelogEntry, insertChangelogEntry } from "./changelogRelease.ts";

const CHANGELOG_PATH = "CHANGELOG.md";
// Un seul token (pas d'espace) pour rester compatible avec le parseur
// existant (RELEASE_HEADER attend `\S+`, voir changelogParser.ts).
const PREVIEW_VERSION = "Non-publié";

function main(): void {
  const results = readChangesets();
  const errors = results.filter(isChangesetError);
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`${e.file} : ${e.reason}`);
    }
    process.exit(1);
  }
  const changesets = results.filter((r) => !isChangesetError(r));
  if (changesets.length === 0) {
    console.log(
      "Aucun fragment de changelog en attente : aperçu develop = dernière release publiée."
    );
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const entry = formatChangelogEntry(PREVIEW_VERSION, date, changesets);
  const existing = readFileSync(CHANGELOG_PATH, "utf8");
  writeFileSync(CHANGELOG_PATH, insertChangelogEntry(existing, entry));
  console.log(
    `Aperçu develop : ${changesets.length} fragment(s) en attente de release ajoutés en tête de CHANGELOG.md (non commité).`
  );
}

if (process.argv[1]?.endsWith("generateChangelogPreview.ts")) {
  main();
}
