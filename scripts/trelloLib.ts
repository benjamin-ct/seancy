// Conversion des cartes Trello en tickets de la page /tickets (import unique,
// scripts/trello-import.ts). Logique pure, testée par scripts/verify-tickets.ts.
//
// Listes du board (noms comparés sans accents ni majuscules) :
//   Idées → idea · A faire → todo · En cours → todo (étiquette « Était en
//   cours sur Trello » : rien ne tourne chez Claude après l'import, à renvoyer
//   à la main) · A valider → review · To merge / A merger → review (étiquette
//   « Prêt à fusionner (Trello) ») · Done → done · autre liste → idea
//   (étiquette « Liste <nom> »).
// Réglages repris des étiquettes et de la description, comme le skill Trello :
// model:sonnet|opus, effort:<niveau>, Hotfix (étiquette ou « Hotfix: oui »),
// « Modèle: … », « Effort: … ».

export interface TrelloLabel {
  name: string;
  color: string | null;
}
export interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
  mimeType: string | null;
  bytes: number | null;
  isUpload: boolean;
}
export interface TrelloChecklist {
  name: string;
  checkItems: { name: string; state: string; pos: number }[];
}
export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  pos: number;
  shortUrl: string;
  dateLastActivity: string;
  labels: TrelloLabel[];
  attachments?: TrelloAttachment[];
  checklists?: TrelloChecklist[];
}
export interface TrelloComment {
  cardId: string;
  at: number;
  author: string;
  text: string;
}
export type Status = "idea" | "todo" | "work" | "review" | "done";

export interface ImportedTicket {
  trelloId: string;
  status: Status;
  position: number;
  title: string;
  detail: string;
  labels: string[];
  links: { url: string; title: string }[];
  model: "opus" | "sonnet";
  effort: string;
  urgent: boolean;
  answer: string;
  pr: string;
  doneAt: number;
  history: { at: number; who: "moi" | "claude"; kind: string; text?: string; pr?: string }[];
  trello: { url: string; list: string; comments: { at: number; author: string; text: string }[] };
  /** Créateur de la carte sur Trello (nom affiché), auteur du ticket. */
  author: string;
}

export const FILE_MAX = 1_500_000;
export const FILE_TYPES =
  /^(image\/(png|jpeg|webp|gif)|application\/pdf|video\/(mp4|webm|quicktime))$/;

const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** Étiquettes du board avec leur couleur (celles des réglages de Claude, modèle, effort et hotfix, mises à part). */
export function labelDefsOf(labels: TrelloLabel[]): { name: string; color: string }[] {
  return labels
    .map((l) => ({ name: (l.name || "").trim(), color: l.color ?? "" }))
    .filter((l) => l.name && !/^(model|effort):/i.test(l.name) && plain(l.name) !== "hotfix");
}

/** Colonne d'arrivée d'une liste Trello, et l'étiquette ajoutée pour garder la trace de la liste d'origine. */
export function statusOfList(name: string): { status: Status; label: string; rank: number } {
  const n = plain(name);
  if (/idee/.test(n)) {
    return { status: "idea", label: "", rank: 0 };
  }
  if (/^(a faire|todo|to do)$/.test(n)) {
    return { status: "todo", label: "", rank: 1 };
  }
  if (/en cours/.test(n)) {
    return { status: "todo", label: "Était en cours sur Trello", rank: 0 };
  }
  if (/a valider/.test(n)) {
    return { status: "review", label: "", rank: 1 };
  }
  if (/(to|a) merge/.test(n)) {
    return { status: "review", label: "Prêt à fusionner (Trello)", rank: 0 };
  }
  if (/^(done|fait|faits|termine)s?$/.test(n)) {
    return { status: "done", label: "", rank: 0 };
  }
  return { status: "idea", label: `Liste ${name.trim()}`.slice(0, 50), rank: 1 };
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function checklistText(lists: TrelloChecklist[] = []): string {
  return lists
    .map((c) =>
      [
        `${c.name} :`,
        ...[...c.checkItems]
          .sort((a, b) => a.pos - b.pos)
          .map((i) => `- [${i.state === "complete" ? "x" : " "}] ${i.name}`),
      ].join("\n")
    )
    .join("\n\n");
}

/** Ticket d'une carte (sans ses fichiers, envoyés à part) ; `comments` : ceux de la carte, du plus ancien au plus récent. */
export function cardToTicket(
  card: TrelloCard,
  listName: string,
  comments: TrelloComment[],
  creator = ""
): ImportedTicket {
  const { status, label } = statusOfList(listName);
  const names = card.labels.map((l) => (l.name || "").trim()).filter(Boolean);
  const lower = names.map(plain);
  const desc = card.desc || "";
  const model =
    lower.includes("model:sonnet") || /mod(è|e)le\s*:\s*sonnet/i.test(desc) ? "sonnet" : "opus";
  const effort =
    lower.map((l) => /^effort:(\w+)$/.exec(l)?.[1]).find((e) => e && EFFORTS.includes(e)) ??
    EFFORTS.find((e) => new RegExp(`effort\\s*:\\s*${e}\\b`, "i").test(desc)) ??
    "high";
  const urgent = lower.includes("hotfix") || /hotfix\s*:\s*oui/i.test(desc);
  const labels = [
    ...names.filter((n) => !/^(model|effort):/i.test(n) && plain(n) !== "hotfix"),
    ...(label ? [label] : []),
  ].slice(0, 20);
  const sorted = [...comments].sort((a, b) => a.at - b.at);
  const prs = [desc, ...sorted.map((c) => c.text)].join("\n").match(PR_URL) ?? [];
  const pr = prs.at(-1) ?? "";
  const lastClaude = [...sorted].reverse().find((c) => /^\s*🤖\s*\[Claude\]/.test(c.text));
  const at = Date.parse(card.dateLastActivity) || Date.now();
  const history: ImportedTicket["history"] = [];
  let answer = "";
  if (status === "review") {
    answer = (
      lastClaude?.text.replace(/^\s*🤖\s*\[Claude\]\s*/, "") ||
      "Ticket repris de Trello (pas de compte rendu de Claude sur la carte) : voir la carte d'origine et la PR."
    ).slice(0, 8000);
    history.push({ at: lastClaude?.at ?? at, who: "claude", kind: "reponse", text: answer, pr });
  }
  if (status === "done") {
    history.push({ at, who: "moi", kind: "valide", pr });
  }
  const links = (card.attachments ?? [])
    .filter((a) => !isImportableFile(a))
    .map((a) => ({ url: a.url, title: (a.name || a.url).slice(0, 200) }))
    .filter((l) => /^https?:\/\//.test(l.url));
  const checklists = checklistText(card.checklists);
  return {
    trelloId: card.id,
    status,
    position: 0,
    title: (card.name || "Sans titre").slice(0, 200),
    detail: [desc.trim(), checklists].filter(Boolean).join("\n\n").slice(0, 40000),
    labels,
    links,
    model,
    effort,
    urgent,
    answer,
    pr,
    doneAt: status === "done" ? at : 0,
    history,
    trello: {
      url: card.shortUrl,
      list: listName,
      comments: sorted.map((c) => ({ at: c.at, author: c.author, text: c.text })),
    },
    author: creator,
  };
}

/** Pièce jointe recopiée dans le ticket (fichier envoyé sur Trello, type et taille acceptés), sinon gardée en lien. */
export const isImportableFile = (a: TrelloAttachment) =>
  a.isUpload && !!a.mimeType && FILE_TYPES.test(a.mimeType) && (a.bytes ?? Infinity) <= FILE_MAX;

/**
 * Tickets de tout le board, rangés comme sur Trello : dans chaque colonne,
 * les listes dans l'ordre de `rank` (« En cours » avant « A faire »), puis
 * les cartes dans leur ordre.
 */
export function boardToTickets(
  lists: { id: string; name: string; pos: number }[],
  cards: TrelloCard[],
  comments: TrelloComment[],
  creators: Map<string, string> = new Map()
): ImportedTicket[] {
  const listOf = new Map(lists.map((l) => [l.id, l]));
  const byCard = new Map<string, TrelloComment[]>();
  for (const c of comments) {
    byCard.set(c.cardId, [...(byCard.get(c.cardId) ?? []), c]);
  }
  const rows = cards
    .filter((c) => listOf.has(c.idList))
    .map((c) => {
      const list = listOf.get(c.idList)!;
      return {
        card: c,
        list,
        rank: statusOfList(list.name).rank,
        ticket: cardToTicket(c, list.name, byCard.get(c.id) ?? [], creators.get(c.id) ?? ""),
      };
    });
  rows.sort((a, b) => a.rank - b.rank || a.list.pos - b.list.pos || a.card.pos - b.card.pos);
  const next: Record<string, number> = {};
  for (const r of rows) {
    next[r.ticket.status] = (next[r.ticket.status] ?? 0) + 1024;
    r.ticket.position = next[r.ticket.status];
  }
  return rows.map((r) => r.ticket);
}
