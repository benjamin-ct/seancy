// Lecture/validation des fragments de changelog (.changeset/*.md, voir
// .changeset/README.md) — partagée entre le script CI qui exige leur
// présence (check-changeset.ts) et, plus tard, le compilateur de release
// (ticket Trello "Épique git-flow : release develop→main automatisée").

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Bump = "patch" | "minor" | "major";

const VALID_BUMPS: ReadonlySet<string> = new Set(["patch", "minor", "major"]);

export interface Changeset {
  file: string;
  bump: Bump;
  summary: string;
}

export interface ChangesetError {
  file: string;
  reason: string;
}

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

// Résultat discriminé plutôt qu'une exception : check-changeset.ts doit
// pouvoir rapporter toutes les erreurs d'un coup (un échec par fragment
// invalide, pas juste le premier rencontré).
export function parseChangeset(file: string, content: string): Changeset | ChangesetError {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    return {
      file,
      reason:
        'frontmatter manquant ou mal formé (attendu "---\\nbump: patch\\n---\\n<description>")',
    };
  }
  const [, frontmatter, body] = match;
  const bumpMatch = frontmatter.match(/^bump:\s*(\S+)\s*$/m);
  const bump = bumpMatch?.[1];
  if (!bump || !VALID_BUMPS.has(bump)) {
    return { file, reason: `"bump" invalide (${bump ?? "absent"}), attendu patch, minor ou major` };
  }
  const summary = body.trim();
  if (!summary) {
    return { file, reason: "description vide" };
  }
  return { file, bump: bump as Bump, summary };
}

export function isChangesetError(result: Changeset | ChangesetError): result is ChangesetError {
  return "reason" in result;
}

export function listChangesetFiles(dir = ".changeset"): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((name) => join(dir, name));
}

export function readChangesets(dir = ".changeset"): (Changeset | ChangesetError)[] {
  return listChangesetFiles(dir).map((file) => parseChangeset(file, readFileSync(file, "utf8")));
}
