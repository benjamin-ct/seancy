// Exige un fragment de changelog (.changeset/*.md) sur toute PR qui touche
// du code produit (src/, worker/ ou migrations/) — voir ticket Trello
// "Épique git-flow : changelog par PR" et .changeset/README.md. Les PR
// purement infra/outillage/doc n'ont rien à fournir : leur impact
// utilisateur est nul, donc rien à annoncer dans le changelog.
//
// BASE_REF doit pointer vers une réf déjà fetchée localement (voir le job
// CI, qui checkout avec fetch-depth: 0) — absent, on considère qu'il n'y a
// rien à vérifier (hors contexte de PR, ex. push direct sur develop/main).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isChangesetError, listChangesetFiles, parseChangeset } from "./changesetLib.ts";

const baseRef = process.env.BASE_REF;
if (!baseRef) {
  console.log("BASE_REF non fourni (pas une PR) : rien à vérifier.");
  process.exit(0);
}

function changedFiles(): string[] {
  const out = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

const files = changedFiles();
const touchesProductCode = files.some(
  (f) => f.startsWith("src/") || f.startsWith("worker/") || f.startsWith("migrations/")
);

if (!touchesProductCode) {
  console.log("Aucun fichier src/, worker/ ou migrations/ modifié : fragment non requis.");
  process.exit(0);
}

const addedFragments = files.filter(
  (f) => f.startsWith(".changeset/") && f.endsWith(".md") && f !== ".changeset/README.md"
);

if (addedFragments.length === 0) {
  console.error(
    "Cette PR modifie du code produit (src/, worker/ ou migrations/) mais n'ajoute aucun " +
      "fragment de changelog sous .changeset/. Ajoutez un fichier .changeset/<slug>.md " +
      "(voir .changeset/README.md pour le format)."
  );
  process.exit(1);
}

let failed = false;
for (const file of listChangesetFiles()) {
  if (!addedFragments.includes(file)) {
    continue;
  }
  const result = parseChangeset(file, readFileSync(file, "utf8"));
  if (isChangesetError(result)) {
    console.error(`${file} : ${result.reason}`);
    failed = true;
    continue;
  }
  console.log(`OK   ${file} (bump: ${result.bump})`);
}

if (failed) {
  process.exit(1);
}
