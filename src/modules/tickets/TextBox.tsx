// Zone de texte des tickets sans champ de formulaire : un bloc éditable en texte
// brut (contenteditable « plaintext-only ») au lieu d'un <textarea>. Safari sur
// iPhone propose « Préremplir le contact » (adresses) à la place des mots suggérés
// sur tout champ de formulaire, en ignorant autocomplete="off" ; un bloc éditable
// n'en est pas un, le clavier y garde ses suggestions. Navigateur sans
// « plaintext-only » : <textarea> comme avant.
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEventHandler,
  type KeyboardEventHandler,
} from "react";
import styles from "./TicketsPage.module.css";
import { TYPING } from "./typing.ts";

export interface TextBoxHandle {
  focus(): void;
  /** Sélection (début, fin) en caractères du texte. */
  selection(): [number, number];
  /** Remplace le texte de a à b (annulable avec Ctrl+Z quand le navigateur le permet), puis sélectionne de `from` à `to`. */
  replace(a: number, b: number, text: string, from: number, to: number): void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  "aria-label"?: string;
  autoFocus?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  onPaste?: ClipboardEventHandler<HTMLElement>;
}

let plainOnly: boolean | null = null;
const supportsPlainOnly = () => {
  if (plainOnly === null) {
    try {
      const d = document.createElement("div");
      d.contentEditable = "plaintext-only";
      plainOnly = d.contentEditable === "plaintext-only";
    } catch {
      plainOnly = false;
    }
  }
  return plainOnly;
};

/** Morceaux du texte dans l'ordre : nœuds texte, <br> (retour à la ligne), début d'un bloc (<div>, <p>). */
type Piece = { node: Node; start: number; text: string };

function pieces(root: HTMLElement): Piece[] {
  const out: Piece[] = [];
  let pos = 0;
  let text = "";
  const push = (node: Node, t: string) => {
    out.push({ node, start: pos, text: t });
    pos += t.length;
    text += t;
  };
  const visit = (n: Node) => {
    for (const c of n.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) {
        push(c, (c as Text).data);
      } else if (c.nodeName === "BR") {
        push(c, "\n");
      } else {
        if ((c.nodeName === "DIV" || c.nodeName === "P") && text && !text.endsWith("\n")) {
          push(c, "\n");
        }
        visit(c);
      }
    }
  };
  visit(root);
  // <br> final après un retour à la ligne (ou seul) : support de la dernière ligne vide, pas un caractère
  const last = out.at(-1);
  if (last?.node.nodeName === "BR" && (last.start === 0 || text[last.start - 1] === "\n")) {
    last.text = "";
  }
  return out;
}

const textOf = (root: HTMLElement) =>
  pieces(root)
    .map((p) => p.text)
    .join("");

/** Position (nœud, décalage) du DOM → rang dans le texte. */
function toOffset(root: HTMLElement, node: Node, offset: number): number {
  const list = pieces(root);
  if (node.nodeType === Node.TEXT_NODE) {
    const p = list.find((x) => x.node === node);
    return p ? p.start + Math.min(offset, p.text.length) : 0;
  }
  // Position entre deux enfants d'un élément : texte de tout ce qui précède le offset-ième enfant
  const marker = node.childNodes[offset];
  if (!marker) {
    const inside = list.filter((p) => node === p.node || node.contains(p.node));
    const end = inside.at(-1);
    return end ? end.start + end.text.length : root === node ? textOf(root).length : 0;
  }
  const first = list.find((p) => p.node === marker || marker.contains(p.node));
  return first ? first.start : textOf(root).length;
}

/** Rang dans le texte → position (nœud, décalage) du DOM. */
function toPoint(root: HTMLElement, off: number): [Node, number] {
  for (const p of pieces(root)) {
    if (off <= p.start + p.text.length && p.node.nodeType === Node.TEXT_NODE) {
      return [p.node, Math.max(0, off - p.start)];
    }
    if (off <= p.start && p.node.parentNode) {
      const parent = p.node.parentNode;
      return [parent, [...parent.childNodes].indexOf(p.node as ChildNode)];
    }
  }
  return [root, root.childNodes.length];
}

/** DOM réduit à un seul nœud texte (et un <br> qui porte une dernière ligne vide). */
function render(root: HTMLElement, value: string) {
  root.replaceChildren(
    ...(value ? [document.createTextNode(value)] : []),
    ...(value.endsWith("\n") ? [document.createElement("br")] : [])
  );
}

function setSelection(root: HTMLElement, a: number, b: number) {
  const sel = root.ownerDocument.getSelection();
  if (!sel) {
    return;
  }
  const r = root.ownerDocument.createRange();
  r.setStart(...toPoint(root, a));
  r.setEnd(...toPoint(root, b));
  sel.removeAllRanges();
  sel.addRange(r);
}

export const TextBox = forwardRef<TextBoxHandle, Props>(function TextBox(
  { value, onChange, rows = 3, placeholder, autoFocus, onKeyDown, onPaste, ...aria },
  handle
) {
  const plain = supportsPlainOnly();
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  // Dernier texte connu du DOM : une valeur venue d'ailleurs (remise à zéro après l'envoi…) le remplace
  const shown = useRef<string | null>(null);

  useEffect(() => {
    const el = box.current;
    if (el && shown.current !== value) {
      render(el, value);
      shown.current = value;
    }
  }, [value]);

  // Après l'ouverture d'une fenêtre (showModal, qui place le focus de son côté)
  useEffect(() => {
    if (!autoFocus) {
      return;
    }
    const id = requestAnimationFrame(() => (box.current ?? area.current)?.focus());
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);

  useImperativeHandle(handle, () => ({
    focus: () => (box.current ?? area.current)?.focus(),
    selection: () => {
      const ta = area.current;
      if (ta) {
        return [ta.selectionStart, ta.selectionEnd];
      }
      const el = box.current;
      const sel = el?.ownerDocument.getSelection();
      if (!el || !sel?.rangeCount || !el.contains(sel.anchorNode)) {
        const end = value.length;
        return [end, end];
      }
      const r = sel.getRangeAt(0);
      return [
        toOffset(el, r.startContainer, r.startOffset),
        toOffset(el, r.endContainer, r.endOffset),
      ];
    },
    replace: (a, b, text, from, to) => {
      const ta = area.current;
      const el = box.current;
      const next = value.slice(0, a) + text + value.slice(b);
      if (ta) {
        onChange(next);
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(from, to);
        });
        return;
      }
      if (!el) {
        return;
      }
      el.focus();
      setSelection(el, a, b);
      // insertText garde l'annulation (Ctrl+Z) ; s'il échoue ou se trompe, le texte est réécrit
      const done = el.ownerDocument.execCommand("insertText", false, text);
      if (!done || textOf(el) !== next) {
        render(el, next);
      }
      shown.current = next;
      onChange(next);
      setSelection(el, from, to);
    },
  }));

  if (!plain) {
    return (
      <textarea
        {...TYPING}
        ref={area}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        {...aria}
      />
    );
  }
  return (
    <div
      ref={box}
      className={styles.textBox}
      contentEditable="plaintext-only"
      role="textbox"
      aria-multiline="true"
      aria-placeholder={placeholder}
      data-placeholder={placeholder}
      data-empty={value ? undefined : ""}
      tabIndex={0}
      autoCorrect={TYPING.autoCorrect}
      autoCapitalize={TYPING.autoCapitalize}
      spellCheck
      style={{ minHeight: `calc(${rows} * 1.45em + 20px)` }}
      onInput={(e) => {
        const el = e.currentTarget;
        const next = textOf(el);
        // Balises ajoutées par le navigateur (bloc, plusieurs <br>…) : texte simple, curseur gardé
        if ([...el.childNodes].some((c) => c.nodeType !== Node.TEXT_NODE && c.nodeName !== "BR")) {
          const [a] = (() => {
            const sel = el.ownerDocument.getSelection();
            return sel?.rangeCount
              ? [toOffset(el, sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset)]
              : [next.length];
          })();
          render(el, next);
          setSelection(el, a, a);
        }
        shown.current = next;
        onChange(next);
      }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      {...aria}
    />
  );
});
