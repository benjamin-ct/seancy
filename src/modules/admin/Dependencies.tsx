// Mises à jour de Dependabot sur le tableau de bord : les PR ouvertes vers
// develop avec l'état de leur CI, et « Fusionner » quand elle est passée
// (worker/release.ts : refusé si la CI échoue ou si ce n'est pas Dependabot).
import { useCallback, useEffect, useState } from "react";
import Icon from "../../shared/components/Icon/Icon.tsx";
import { listDeps, mergeDep, type DepPr } from "../tickets/api.ts";
import styles from "./Admin.module.css";

let last: DepPr[] | null = null;

const STATE: Record<DepPr["state"], [string, string]> = {
  ok: ["CI passée", "okText"],
  wait: ["CI en cours", "muted"],
  fail: ["CI en échec", "warnText"],
};

export default function Dependencies() {
  const [deps, setDeps] = useState<DepPr[] | null>(last);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await listDeps();
      last = r.deps;
      setDeps(r.deps);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const merge = async (n: number) => {
    setBusy(n);
    try {
      const r = await mergeDep(n);
      last = r.deps;
      setDeps(r.deps);
      setMessage(r.message);
    } catch (err) {
      setMessage((err as Error).message);
    }
    setBusy(0);
  };

  return (
    <section aria-labelledby="dash-deps" className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 id="dash-deps">
          Dépendances{" "}
          {deps && (
            <small className={styles.muted}>
              {deps.length ? `${deps.length} mise${deps.length > 1 ? "s" : ""} à jour` : "à jour"}
            </small>
          )}
        </h2>
      </div>
      <div className={styles.card}>
        {!deps && !message && <p className={styles.muted}>Chargement…</p>}
        {message && (
          <p className={styles.muted} role="status">
            {message}
          </p>
        )}
        {deps && !deps.length && (
          <p className={styles.muted}>Aucune mise à jour de Dependabot en attente.</p>
        )}
        {deps && deps.length > 0 && (
          <ul className={styles.depList}>
            {deps.map((p) => (
              <li key={p.number}>
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${p.title}, PR #${p.number} sur GitHub (nouvel onglet)`}
                >
                  {p.title.replace(/^chore\(deps(-dev)?\):\s*/i, "")}
                  <Icon name="external" size={14} className={styles.btnIconEnd} />
                </a>
                <span className={styles[STATE[p.state][1]]}>{STATE[p.state][0]}</span>
                {p.state === "ok" && (
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={busy !== 0}
                    onClick={() => void merge(p.number)}
                  >
                    {busy === p.number ? "Fusion…" : "Fusionner"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {deps?.some((p) => p.state === "fail") && (
          <p className={styles.muted}>
            CI en échec : souvent deux mises à jour qui vont ensemble (comme i18next et
            react-i18next) ; à regrouper dans une session Claude.
          </p>
        )}
      </div>
    </section>
  );
}
