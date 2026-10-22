// Parties pures des suggestions IA « Pour vous ce soir » (voir
// ai-suggestions.ts) : lecture de la sortie du modèle, comparaison de titres
// et bornes de journée. Sans dépendance au runtime Workers (ni D1, ni env),
// pour être testées par scripts/verify-ai-suggestions.ts sous Node.

// Articles en tête ignorés à la comparaison (« The Departed » = « Departed »),
// même idée que normalizeSearchText (search-index.ts), sur des titres
// complets plutôt que des préfixes de recherche.
const LEADING_ARTICLE_RE = /^(?:the|a|an|le|la|les|l|un|une|des) /;

/** Titre comparable : sans accents, casse ni ponctuation. */
export function normalizeTitle(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(LEADING_ARTICLE_RE, "");
}

/** Une ligne « 1. Titre (2019) » par suggestion ; tolère puces, gras
 * markdown et années de série en plage (« (2008-2013) »). Les lignes sans
 * année (phrase d'introduction, commentaire) sont ignorées. */
export function parseSuggestions(
  content: string,
  max: number
): Array<{ title: string; year: number }> {
  const seen = new Set<string>();
  const parsed: Array<{ title: string; year: number }> = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine
      .replace(/^\s*(?:[-*•]\s*)?(?:\d+[.)]\s*)?/, "")
      .replace(/\*\*/g, "")
      .trim();
    const match = line.match(/^(.*?)\s*\((\d{4})(?:\s*[-–]\s*(?:\d{4})?)?\)\s*$/);
    if (!match || !match[1]) {
      continue;
    }
    const title = match[1].replace(/^["«\s]+|["»\s]+$/g, "");
    const dedupeKey = `${normalizeTitle(title)}|${match[2]}`;
    if (!title || seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    parsed.push({ title, year: Number(match[2]) });
  }
  return parsed.slice(0, max);
}

/** Prochain minuit à Paris (usage du soir, utilisateurs français d'abord) :
 * `Intl` donne l'heure locale, l'écart avec l'UTC donne le décalage du
 * moment (les changements d'heure ont lieu à 2-3 h, après minuit, donc ce
 * décalage vaut aussi pour le minuit visé). */
export function nextParisMidnight(now: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(now))
      .map((part) => [part.type, Number(part.value)])
  );
  const parisWallClock = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  const offset = parisWallClock - (now - (now % 1000));
  return Date.UTC(parts.year, parts.month - 1, parts.day + 1) - offset;
}

/** Prochain minuit UTC : remise à zéro du quota gratuit Workers AI (soit
 * 1 h ou 2 h à Paris) — retenter avant ne ferait que reprendre la même
 * erreur. */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}
