// Markdown des tickets (descriptions, comptes rendus de Claude, messages,
// commentaires Trello), découpé en blocs et en morceaux de texte : le rendu
// (Markdown.tsx) fabrique des éléments React, jamais de HTML brut. Couvre ce
// qu'écrivent Trello et Claude : titres, gras, italique, barré, code, listes
// (imbriquées, numérotées, cases à cocher), citations, tableaux, liens et
// adresses nues. Un retour à la ligne simple reste un retour à la ligne.

export type Inline =
  | string
  | { t: "code"; v: string }
  | { t: "b" | "i" | "s"; c: Inline[] }
  | { t: "a"; href: string; c: Inline[] }
  | { t: "img"; alt: string; src: string };

export interface ListItem {
  text: string;
  check: boolean | null;
  ordered: boolean;
  indent: number;
  children: ListItem[];
}
export type Block =
  | { k: "p"; lines: string[] }
  | { k: "h"; level: number; text: string }
  | { k: "code"; text: string }
  | { k: "quote"; text: string }
  | { k: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { k: "hr" }
  | { k: "table"; head: string[]; rows: string[][] };

/** Adresse autorisée dans un lien : web, courriel ou chemin du site (jamais javascript:, data:…). */
export function safeHref(url: string): string {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) || /^\/(?!\/)/.test(u) ? u : "";
}

const INLINE = new RegExp(
  [
    /\\([\\`*_{}[\]()#+\-.!~|>])/.source, // 1 caractère échappé
    /(`+)([^`][\s\S]*?)\2(?!`)/.source, // 2-3 code
    /!\[([^\]]*)\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/.source, // 4-5 image
    /\[((?:[^\]\\]|\\.)+)\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/.source, // 6-7 lien
    /<?(https?:\/\/[^\s<>"»]*[^\s<>).,;:!?»'"\]*_])>?/.source, // 8 adresse nue
    /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, // 9 gras
    /(?<![\p{L}\p{N}])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}])/u.source, // 10 gras
    /~~(?=\S)([\s\S]*?\S)~~/.source, // 11 barré
    /\*(?=[^\s*])([^*]*?[^\s*\\])\*/.source, // 12 italique
    /\*(?=[^\s*])([^\s*])\*/.source, // 13 italique d'une lettre
    /(?<![\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/u.source, // 14 italique
  ].join("|"),
  "gu"
);

/** Texte d'une ligne en morceaux (gras, liens…). */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (x: Inline) => {
    if (typeof x === "string" && typeof out.at(-1) === "string") {
      out[out.length - 1] = (out.at(-1) as string) + x;
    } else if (x !== "") {
      out.push(x);
    }
  };
  const re = new RegExp(INLINE.source, INLINE.flags);
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const g = m;
    if (g[1] !== undefined) {
      push(g[1]);
    } else if (g[3] !== undefined) {
      const v = g[3];
      push({ t: "code", v: /^ .* $/.test(v) ? v.slice(1, -1) : v });
    } else if (g[5] !== undefined) {
      const src = safeHref(g[5]);
      push(src ? { t: "img", alt: g[4], src } : g[0]);
    } else if (g[7] !== undefined) {
      const href = safeHref(g[7]);
      const c = parseInline(g[6]);
      if (href) {
        push({ t: "a", href, c });
      } else {
        c.forEach(push);
      }
    } else if (g[8] !== undefined) {
      push({ t: "a", href: g[8], c: [g[8]] });
    } else if (g[9] !== undefined || g[10] !== undefined) {
      push({ t: "b", c: parseInline(g[9] ?? g[10]) });
    } else if (g[11] !== undefined) {
      push({ t: "s", c: parseInline(g[11]) });
    } else {
      push({ t: "i", c: parseInline(g[12] ?? g[13] ?? g[14]) });
    }
  }
  push(text.slice(last));
  return out;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+•]|(\d{1,4})[.)])\s+(.*)$/;
const CHECK = /^\[([ xX])\]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
const isStart = (l: string, next = "") =>
  FENCE.test(l) ||
  HEADING.test(l) ||
  HR.test(l) ||
  QUOTE.test(l) ||
  ITEM.test(l) ||
  (l.includes("|") && TABLE_SEP.test(next) && next.includes("-"));

/** Texte en blocs (paragraphes, titres, listes…). */
export function parseBlocks(src: string): Block[] {
  const lines = String(src ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(l);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) {
        body.push(lines[i]);
      }
      i++;
      out.push({ k: "code", text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(l);
    if (h) {
      out.push({ k: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (HR.test(l)) {
      out.push({ k: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(l)) {
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) {
        body.push(QUOTE.exec(lines[i])![1]);
      }
      out.push({ k: "quote", text: body.join("\n") });
      continue;
    }
    if (l.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(l);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) {
        rows.push(cells(lines[i]));
      }
      out.push({ k: "table", head, rows });
      continue;
    }
    const first = ITEM.exec(l);
    if (first) {
      const ordered = first[3] !== undefined;
      const flat: ListItem[] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (m && m[1].length <= first[1].length && (m[3] !== undefined) !== ordered) {
          break; // autre sorte de liste
        }
        if (m) {
          const c = CHECK.exec(m[4]);
          flat.push({
            text: c ? c[2] : m[4],
            check: c ? c[1] !== " " : null,
            ordered: m[3] !== undefined,
            indent: m[1].replace(/\t/g, "    ").length,
            children: [],
          });
          i++;
        } else if (
          lines[i].trim() &&
          /^\s{2,}/.test(lines[i]) &&
          flat.length &&
          !isStart(lines[i].trim())
        ) {
          // Suite d'un élément (ligne décalée)
          flat[flat.length - 1].text += `\n${lines[i].trim()}`;
          i++;
        } else if (!lines[i].trim() && ITEM.test(lines[i + 1] ?? "")) {
          i++; // ligne vide entre deux éléments
        } else {
          break;
        }
      }
      out.push({
        k: "list",
        ordered,
        start: ordered ? Number(first[3]) : 1,
        items: nest(flat),
      });
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim(); i++) {
      if (para.length && isStart(lines[i], lines[i + 1])) {
        break;
      }
      para.push(lines[i].trim());
    }
    out.push({ k: "p", lines: para });
  }
  return out;
}

// Éléments à plat → arbre d'après leur décalage
function nest(flat: ListItem[]): ListItem[] {
  const root: ListItem[] = [];
  const stack: ListItem[] = [];
  for (const it of flat) {
    while (stack.length && stack.at(-1)!.indent >= it.indent) {
      stack.pop();
    }
    (stack.length ? stack.at(-1)!.children : root).push(it);
    stack.push(it);
  }
  return root;
}
