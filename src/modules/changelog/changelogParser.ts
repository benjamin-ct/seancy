// Lecture de CHANGELOG.md (généré par scripts/changelogRelease.ts, voir
// formatChangelogEntry) pour la page changelog publique — ticket Trello
// "Épique git-flow : page changelog publique sur le site". Logique pure,
// testable sans navigateur (voir scripts/verify-changelog-parser.ts) :
// aucune dépendance au DOM ni à `import.meta.env`.

export interface ChangelogSection {
  title: string;
  items: string[];
}

export interface ChangelogRelease {
  version: string;
  date: string;
  sections: ChangelogSection[];
}

const RELEASE_HEADER = /^## (\S+) — (\d{4}-\d{2}-\d{2})\s*$/;
const SECTION_HEADER = /^### (.+)$/;
const LIST_ITEM = /^- (.*)$/;
// Ligne de suite d'un point de liste multi-lignes (voir
// formatChangelogEntry côté scripts/changelogRelease.ts : indentée de 2
// espaces, rattachée au `-` précédent).
const CONTINUATION = /^ {2}(.*)$/;

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let currentRelease: ChangelogRelease | null = null;
  let currentSection: ChangelogSection | null = null;

  for (const line of markdown.split("\n")) {
    const releaseMatch = line.match(RELEASE_HEADER);
    if (releaseMatch) {
      currentRelease = { version: releaseMatch[1], date: releaseMatch[2], sections: [] };
      releases.push(currentRelease);
      currentSection = null;
      continue;
    }
    // Le texte d'en-tête avant la première release (titre, intro) n'a pas de
    // structure à parser.
    if (!currentRelease) {
      continue;
    }
    const sectionMatch = line.match(SECTION_HEADER);
    if (sectionMatch) {
      currentSection = { title: sectionMatch[1], items: [] };
      currentRelease.sections.push(currentSection);
      continue;
    }
    if (!currentSection) {
      continue;
    }
    const itemMatch = line.match(LIST_ITEM);
    if (itemMatch) {
      currentSection.items.push(itemMatch[1]);
      continue;
    }
    const continuationMatch = line.match(CONTINUATION);
    if (continuationMatch && currentSection.items.length > 0) {
      const lastIndex = currentSection.items.length - 1;
      currentSection.items[lastIndex] += `\n${continuationMatch[1]}`;
    }
  }
  return releases;
}
