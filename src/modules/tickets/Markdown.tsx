import { Fragment, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from "react";
import { parseBlocks, parseInline, type Inline, type ListItem } from "./markdown.ts";
import styles from "./TicketsPage.module.css";

const ext = { target: "_blank", rel: "noopener noreferrer" } as const;

/** Champ de texte libre : sans ces attributs, Safari sur iPhone y propose
 * « Préremplir le contact » (adresses) à la place des mots suggérés. */
export const TYPING = {
  autoComplete: "off",
  autoCorrect: "on",
  autoCapitalize: "sentences",
  spellCheck: true,
} as const;

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (typeof n === "string") {
      return n;
    }
    switch (n.t) {
      case "code":
        return <code key={i}>{n.v}</code>;
      case "b":
        return <strong key={i}>{inline(n.c)}</strong>;
      case "i":
        return <em key={i}>{inline(n.c)}</em>;
      case "s":
        return <del key={i}>{inline(n.c)}</del>;
      case "a":
        return (
          <a key={i} href={n.href} {...ext}>
            {inline(n.c)}
          </a>
        );
      // Image distante (souvent derrière la connexion de Trello) : lien, pas d'image chargée
      case "img":
        return (
          <a key={i} href={n.src} {...ext}>
            🖼 {n.alt || "image"}
          </a>
        );
    }
  });
}

// Lignes d'un paragraphe ou d'un élément : un retour à la ligne reste un retour à la ligne
const lines = (text: string) =>
  text.split("\n").map((l, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {inline(parseInline(l))}
    </Fragment>
  ));

function List({
  items,
  ordered,
  start = 1,
}: {
  items: ListItem[];
  ordered: boolean;
  start?: number;
}) {
  const body = items.map((it, i) => (
    <li key={i} className={it.check !== null ? styles.task : undefined}>
      {it.check !== null && (
        <input
          type="checkbox"
          checked={it.check}
          disabled
          aria-label={it.check ? "Fait" : "À faire"}
        />
      )}
      <span>{lines(it.text)}</span>
      {it.children.length > 0 && <List items={it.children} ordered={it.children[0].ordered} />}
    </li>
  ));
  return ordered ? <ol start={start}>{body}</ol> : <ul>{body}</ul>;
}

/** Texte en Markdown (descriptions, comptes rendus, messages) rendu sans HTML brut. */
export default function Markdown({ text }: { text: string }) {
  return (
    <div className={styles.md}>
      {parseBlocks(text).map((b, i) => {
        switch (b.k) {
          case "p":
            return <p key={i}>{lines(b.lines.join("\n"))}</p>;
          case "h": {
            const H = b.level <= 2 ? "h4" : b.level === 3 ? "h5" : "h6";
            return <H key={i}>{inline(parseInline(b.text))}</H>;
          }
          case "code":
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case "quote":
            return (
              <blockquote key={i}>
                <Markdown text={b.text} />
              </blockquote>
            );
          case "list":
            return <List key={i} items={b.items} ordered={b.ordered} start={b.start} />;
          case "hr":
            return <hr key={i} />;
          case "table":
            return (
              <div key={i} className={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j}>{inline(parseInline(c))}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {b.head.map((_, k) => (
                          <td key={k}>{inline(parseInline(r[k] ?? ""))}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}

const TOOLS: { label: string; text: string; wrap?: [string, string]; line?: string }[] = [
  { label: "Gras", text: "B", wrap: ["**", "**"] },
  { label: "Italique", text: "I", wrap: ["*", "*"] },
  { label: "Code", text: "</>", wrap: ["`", "`"] },
  { label: "Lien", text: "🔗", wrap: ["[", "](https://)"] },
  { label: "Liste", text: "•", line: "- " },
  { label: "Liste numérotée", text: "1.", line: "1. " },
  { label: "Case à cocher", text: "☐", line: "- [ ] " },
  { label: "Titre", text: "H", line: "## " },
];

/** Zone de texte en Markdown : barre d'outils (gras, listes, lien…) et aperçu du rendu. */
export function MarkdownInput({
  value,
  onChange,
  ...rest
}: { value: string; onChange: (v: string) => void } & Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange"
>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  const apply = (tool: (typeof TOOLS)[number]) => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const { selectionStart: a, selectionEnd: b } = el;
    let next: string;
    let from: number;
    let to: number;
    if (tool.wrap) {
      const [l, r] = tool.wrap;
      const sel = value.slice(a, b) || (tool.label === "Lien" ? "texte" : tool.label.toLowerCase());
      next = value.slice(0, a) + l + sel + r + value.slice(b);
      from = a + l.length;
      to = from + sel.length;
    } else {
      // Préfixe au début de chaque ligne choisie
      const start = value.lastIndexOf("\n", a - 1) + 1;
      const block = value.slice(start, b);
      const out = block
        .split("\n")
        .map((ln, i) => (tool.line === "1. " ? `${i + 1}. ` : tool.line) + ln)
        .join("\n");
      next = value.slice(0, start) + out + value.slice(b);
      from = to = start + out.length;
    }
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(from, to);
    });
  };
  return (
    <div className={styles.mdInput}>
      <div className={styles.mdTools} role="toolbar" aria-label="Mise en forme">
        {TOOLS.map((t) => (
          <button
            key={t.label}
            type="button"
            title={t.label}
            aria-label={t.label}
            disabled={preview}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => apply(t)}
          >
            {t.text}
          </button>
        ))}
        <button
          type="button"
          className={styles.mdPreviewBtn}
          aria-pressed={preview}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "Écrire" : "Aperçu"}
        </button>
      </div>
      {preview ? (
        <div className={styles.mdPreview}>
          {value.trim() ? (
            <Markdown text={value} />
          ) : (
            <p className={styles.muted}>Rien à afficher.</p>
          )}
        </div>
      ) : (
        <textarea
          {...TYPING}
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            const k = e.key.toLowerCase();
            if ((e.ctrlKey || e.metaKey) && (k === "b" || k === "i")) {
              e.preventDefault();
              apply(TOOLS[k === "b" ? 0 : 1]);
            }
          }}
          {...rest}
        />
      )}
    </div>
  );
}
