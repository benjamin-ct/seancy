// Règles du tableau des tickets : colonnes, déplacements permis (glisser-
// déposer ou boutons de la fiche), états affichés. Même fonctionnement que la
// page Tickets de Paddock Live : la colonne d'arrivée fait l'action (envoi à
// Claude, annulation, validation, retouche, réouverture).
import { createContext } from "react";
import type { Effort, LabelDef, Ticket, TicketFile, TicketStatus } from "./api.ts";

/** Étiquettes de la page (Labels.tsx) : définies, puis celles des tickets sans définition. */
export const LabelsContext = createContext<{ defs: LabelDef[]; names: string[] }>({
  defs: [],
  names: [],
});
/** Pièce jointe ouverte dans la visionneuse (images et vidéos). */
export const viewable = (f: TicketFile) => /^(image|video)\//.test(f.type);

export const COLUMNS: { key: TicketStatus; name: string; empty: string }[] = [
  {
    key: "suggestion",
    name: "Suggestions",
    empty:
      "Les suggestions des utilisateurs (Réglages › Suggestions) arrivent ici ; glisse-les dans « Idées » ou « À faire ».",
  },
  {
    key: "idea",
    name: "Idées",
    empty: "Note une idée ici ; glisse-la dans « À faire » pour en faire un ticket.",
  },
  {
    key: "todo",
    name: "À faire",
    empty: "Glisse une carte vers « En cours » pour l'envoyer à Claude.",
  },
  { key: "work", name: "En cours", empty: "Rien en cours : Claude attend." },
  { key: "review", name: "À valider", empty: "Rien à valider." },
  { key: "done", name: "Faits", empty: "Rien de fait pour le moment." },
];
export const columnName = (k: TicketStatus) => COLUMNS.find((c) => c.key === k)?.name ?? "";

const MOVES: Record<TicketStatus, TicketStatus[]> = {
  suggestion: ["idea", "todo", "work"],
  idea: ["suggestion", "todo", "work"],
  todo: ["suggestion", "idea", "work"],
  work: ["todo"],
  review: ["done", "work"],
  done: ["work"],
};
/** Colonnes où l'on range les cartes à la main (ordre gardé par le serveur). */
export const SORTABLE = new Set<TicketStatus>(["suggestion", "idea", "todo"]);
/**
 * Étiquette des suggestions des utilisateurs (FEEDBACK_LABEL, worker/tickets-logic.ts) : pas
 * montrée sur les cartes de la colonne Suggestions, gardée quand la carte en sort.
 */
export const SUGGESTION_LABEL = "Suggestion";
export const canMove = (t: Ticket, to: TicketStatus) =>
  t.status === to
    ? SORTABLE.has(to)
    : MOVES[t.status].includes(to) && !(to === "done" && t.queued > 0);
export const refusal = (t: Ticket, to: TicketStatus) =>
  to === "done" && t.queued
    ? "Déjà validé : la fusion se fait toute seule"
    : `Pas de passage de « ${columnName(t.status)} » à « ${columnName(to)} »`;

export const EFFORT_NAMES: Record<Effort, string> = {
  low: "Faible",
  medium: "Moyen",
  high: "Élevé",
  xhigh: "Très élevé",
  max: "Maximum",
};
export const modelName = (m: string) => (m === "sonnet" ? "Sonnet" : "Opus");

export const STEPS = ["Envoyé", "Démarré", "Au travail", "À valider"];
/** Avancement noté depuis le dernier envoi (sinon : celui d'un passage précédent). */
export const fresh = (t: Ticket) => !!t.stage && t.progressAt >= t.sent;
export const stepOf = (t: Ticket) => (!fresh(t) ? 0 : t.stage === "work" ? 2 : 1);

export const prNumber = (url: string) => /\/pull\/(\d+)/.exec(url || "")?.[1] ?? "";

export function ago(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) {
    return "à l'instant";
  }
  if (m < 60) {
    return `il y a ${m} min`;
  }
  if (m < 48 * 60) {
    return `il y a ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
  }
  return `il y a ${Math.floor(m / 1440)} j`;
}
export const when = (ms: number) =>
  ms
    ? new Date(ms).toLocaleString("fr-FR", {
        timeZone: "Europe/Paris",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
export const day = (ms: number) =>
  ms
    ? new Date(ms).toLocaleDateString("fr-FR", {
        timeZone: "Europe/Paris",
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";

export const DONE_SHOWN = 60;

/** Carte qu'on peut archiver (sortir du tableau sans la supprimer) : suggestion, idée, à faire ou faite. */
export const archivable = (t: Ticket) =>
  !t.archived && (SORTABLE.has(t.status) || t.status === "done");
/** Message après le passage d'une carte d'une colonne rangée à la main à une autre. */
export function movedText(from: TicketStatus, to: TicketStatus): string {
  if (to === "suggestion") {
    return "Remise dans les suggestions";
  }
  if (to === "idea") {
    return from === "suggestion" ? "Suggestion gardée dans les idées" : "Remise dans les idées";
  }
  return `${from === "suggestion" ? "Suggestion" : "Idée"} passée dans « À faire »`;
}

/**
 * Cartes de chaque colonne, dans leur ordre (faits : les plus récents d'abord, 60 au plus).
 * Tableau : les cartes archivées n'y sont que pendant une recherche.
 * Vue des archives (bouton « Archivés ») : seulement elles, recherche comprise.
 */
export function columns(
  tickets: Ticket[],
  query = "",
  archives = false
): Record<TicketStatus, Ticket[]> {
  const q = plain(query.trim());
  const by: Record<TicketStatus, Ticket[]> = {
    suggestion: [],
    idea: [],
    todo: [],
    work: [],
    review: [],
    done: [],
  };
  for (const t of tickets) {
    const found = !q || plain(`${t.title} ${t.detail} ${t.labels.join(" ")}`).includes(q);
    if (archives ? t.archived && found : q ? found : !t.archived) {
      by[t.status].push(t);
    }
  }
  for (const k of SORTABLE) {
    by[k].sort((a, b) => a.position - b.position);
  }
  by.work.sort((a, b) => a.sent - b.sent);
  by.review.sort(
    (a, b) => (a.queued || Infinity) - (b.queued || Infinity) || b.progressAt - a.progressAt
  );
  by.done = by.done.sort((a, b) => b.doneAt - a.doneAt).slice(0, q || archives ? 200 : DONE_SHOWN);
  return by;
}
export const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Lignes d'un texte (compte rendu de Claude, description) : intitulés courants remis à la ligne. */
export function lines(text: string): string[] {
  return String(text || "")
    .replace(/\s+(Ce qui a changé|Pour vérifier|Limites|Revue)\s?:/g, "\n$1 :")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()));
}
