// Étiquettes colorées des tickets, façon Trello : définitions partagées
// (nom → couleur, serveur : worker/tickets.ts, route /labels), pastilles sur
// les cartes et dans la fiche, sélecteur avec recherche, création,
// modification et suppression (appliquées à tous les tickets).
import { useContext, useState, type KeyboardEvent } from "react";
import { saveLabel, type LabelDef } from "./api.ts";
import { LabelsContext } from "./board.ts";
import type { Run } from "./TicketSheet.tsx";
import styles from "./TicketsPage.module.css";

// Couleurs de Trello : fond, texte (sombre sur les teintes claires, blanc sur les foncées)
const HUES = [
  ["green", "vert", "#BAF3DB", "#4BCE97", "#1F845A"],
  ["yellow", "jaune", "#F8E6A0", "#F5CD47", "#946F00"],
  ["orange", "orange", "#FEDEC8", "#FEA362", "#C25100"],
  ["red", "rouge", "#FFD5D2", "#F87168", "#C9372C"],
  ["purple", "violet", "#DFD8FD", "#9F8FEF", "#6E5DC6"],
  ["blue", "bleu", "#CCE0FF", "#579DFF", "#0C66E4"],
  ["sky", "ciel", "#C6EDFB", "#6CC3E0", "#227D9B"],
  ["lime", "citron vert", "#D3F1A7", "#94C748", "#5B7F24"],
  ["pink", "rose", "#FDD0EC", "#E774BB", "#AE4787"],
  ["black", "gris", "#DCDFE4", "#8590A2", "#626F86"],
] as const;
const SHADES = [
  ["_light", "clair"],
  ["", ""],
  ["_dark", "foncé"],
] as const;
const COLORS = new Map<string, { bg: string; fg: string; name: string }>(
  HUES.flatMap(([key, name, ...bg]) =>
    SHADES.map(([suffix, shade], i) => [
      key + suffix,
      { bg: bg[i], fg: i === 2 ? "#FFFFFF" : "#172B4D", name: shade ? `${name} ${shade}` : name },
    ])
  )
);
// Grille du sélecteur comme Trello : 5 teintes par ligne, des plus claires aux plus foncées
const GRID = [HUES.slice(0, 5), HUES.slice(5)].flatMap((row) =>
  SHADES.flatMap(([suffix]) => row.map(([key]) => key + suffix))
);

const colorOf = (defs: LabelDef[], name: string) =>
  COLORS.get(defs.find((d) => d.name.toLowerCase() === name.toLowerCase())?.color ?? "");

/** Pastille d'une étiquette, à sa couleur (grise sans couleur). */
export function Label({ name, big = false }: { name: string; big?: boolean }) {
  const c = colorOf(useContext(LabelsContext).defs, name);
  return (
    <span
      className={`${styles.lab} ${big ? styles.labBig : ""}`}
      style={c ? { background: c.bg, color: c.fg } : undefined}
    >
      {name}
    </span>
  );
}

/** Sélecteur d'étiquettes d'un ticket : recherche, cases à cocher, création et modification. */
export function LabelPicker({
  value,
  onChange,
  run,
  onClose,
}: {
  value: string[];
  onChange: (labels: string[]) => void;
  run: Run;
  onClose: () => void;
}) {
  const { defs, names } = useContext(LabelsContext);
  const [q, setQ] = useState("");
  // Étiquette en cours de création (from vide) ou de modification
  const [edit, setEdit] = useState<{ from: string; name: string; color: string } | null>(null);
  const has = (n: string) => value.some((v) => v.toLowerCase() === n.toLowerCase());
  const shown = names.filter((n) => n.toLowerCase().includes(q.trim().toLowerCase()));
  const onKey = (e: KeyboardEvent) => {
    // Échap ferme le sélecteur, pas la fiche
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (edit) {
        setEdit(null);
      } else {
        onClose();
      }
    }
  };

  if (edit) {
    const c = COLORS.get(edit.color);
    const name = edit.name.trim();
    const save = async () => {
      if (
        await run(
          () => saveLabel({ from: edit.from || undefined, name, color: edit.color }),
          edit.from ? "Étiquette modifiée" : "Étiquette créée"
        )
      ) {
        if (!edit.from && !has(name)) {
          onChange([...value, name]);
        }
        setEdit(null);
      }
    };
    return (
      <div className={styles.picker} role="group" aria-label="Étiquette" onKeyDown={onKey}>
        <div className={styles.pickerHead}>
          <button type="button" className={styles.link} onClick={() => setEdit(null)}>
            ‹ Retour
          </button>
          <b>{edit.from ? "Modifier l'étiquette" : "Créer une étiquette"}</b>
        </div>
        <div className={styles.pickerPreview}>
          <span
            className={`${styles.lab} ${styles.labBig}`}
            style={c ? { background: c.bg, color: c.fg } : undefined}
          >
            {name || "Aperçu"}
          </span>
        </div>
        <label className={styles.pickerField}>
          Titre
          <input
            value={edit.name}
            maxLength={50}
            autoFocus
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name) {
                e.preventDefault();
                void save();
              }
            }}
          />
        </label>
        <p className={styles.pickerLabel}>Sélectionner une couleur</p>
        <div className={styles.swatches} role="radiogroup" aria-label="Couleur">
          {GRID.map((k) => {
            const s = COLORS.get(k)!;
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={edit.color === k}
                aria-label={s.name}
                title={s.name}
                className={styles.swatch}
                style={{ background: s.bg }}
                onClick={() => setEdit({ ...edit, color: k })}
              />
            );
          })}
        </div>
        <button
          type="button"
          className={styles.btn}
          disabled={!edit.color}
          onClick={() => setEdit({ ...edit, color: "" })}
        >
          × Retirer la couleur
        </button>
        <div className={styles.pickerFoot}>
          <button type="button" className={styles.primary} disabled={!name} onClick={save}>
            {edit.from ? "Enregistrer" : "Créer"}
          </button>
          {edit.from && (
            <button
              type="button"
              className={styles.danger}
              onClick={async () => {
                if (
                  await run(
                    () => saveLabel({ from: edit.from, remove: true }),
                    "Étiquette retirée de tous les tickets"
                  )
                ) {
                  setEdit(null);
                }
              }}
            >
              Supprimer
            </button>
          )}
        </div>
        {edit.from && (
          <p className={styles.hint}>Le changement s'applique à tous les tickets qui l'ont.</p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.picker} role="group" aria-label="Étiquettes" onKeyDown={onKey}>
      <div className={styles.pickerHead}>
        <b>Étiquettes</b>
        <button type="button" className={styles.link} onClick={onClose}>
          Fermer
        </button>
      </div>
      <input
        className={styles.pickerSearch}
        placeholder="Rechercher des étiquettes…"
        aria-label="Rechercher des étiquettes"
        value={q}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className={styles.pickerList}>
        {shown.map((n) => {
          const c = colorOf(defs, n);
          const def = defs.find((d) => d.name.toLowerCase() === n.toLowerCase());
          return (
            <li key={n}>
              <label>
                <input
                  type="checkbox"
                  checked={has(n)}
                  onChange={() =>
                    onChange(
                      has(n)
                        ? value.filter((v) => v.toLowerCase() !== n.toLowerCase())
                        : [...value, n]
                    )
                  }
                />
                <span
                  className={styles.pickerBar}
                  style={c ? { background: c.bg, color: c.fg } : undefined}
                >
                  {n}
                </span>
              </label>
              <button
                type="button"
                className={styles.pickerEdit}
                aria-label={`Modifier ${n}`}
                title="Modifier"
                onClick={() => setEdit({ from: n, name: n, color: def?.color ?? "" })}
              >
                ✎
              </button>
            </li>
          );
        })}
        {!shown.length && <li className={styles.muted}>Aucune étiquette</li>}
      </ul>
      <button
        type="button"
        className={styles.btn}
        onClick={() => setEdit({ from: "", name: q.trim(), color: "green" })}
      >
        Créer une nouvelle étiquette
      </button>
    </div>
  );
}
