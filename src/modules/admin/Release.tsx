// Mise en ligne depuis le tableau de bord, sans ticket : ce qui attend sur
// develop, « Lancer la release » (PR develop → main), puis son suivi jusqu'à la
// fusion, faite par le serveur dès que la CI est passée (worker/tickets.ts).
import { useCallback, useEffect, useState } from "react";
import Icon from "../../shared/components/Icon/Icon.tsx";
import { releaseState, startRelease, type ReleaseState } from "../tickets/api.ts";
import styles from "./Admin.module.css";

// Dernier état : affiché tout de suite au retour sur l'onglet
let last: ReleaseState | null = null;

// Sections du journal, comme scripts/changelogRelease.ts (le plus marquant d'abord)
const SECTIONS = [
  ["major", "Changements majeurs"],
  ["minor", "Nouveautés"],
  ["patch", "Correctifs"],
] as const;
const sinceText = (t: number) => {
  const days = Math.floor((Date.now() - t) / 86_400_000);
  return days < 1 ? "aujourd'hui" : days === 1 ? "depuis hier" : `depuis ${days} jours`;
};

export default function Release() {
  const [state, setState] = useState<ReleaseState | null>(last);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { release } = await releaseState();
      last = release;
      setState(release);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // Release en cours : nouvel état toutes les 20 s (le serveur fusionne dès que la CI est passée)
  const running = state?.pr?.state === "wait";
  useEffect(() => {
    void load();
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void load();
      }
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [load, running]);

  const launch = async () => {
    setBusy(true);
    try {
      const { release } = await startRelease();
      last = release;
      setState(release);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
    setConfirming(false);
  };

  const pr = state?.pr;
  const n = state?.pending.length ?? 0;
  // Admin, tickets, outillage : en ligne dès la fusion dans develop (Worker de l'admin), sans release
  const live = state?.live ?? [];
  return (
    <section aria-labelledby="dash-release" className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 id="dash-release">
          Mise en ligne{" "}
          {state?.version && <small className={styles.muted}>en ligne : v{state.version}</small>}
        </h2>
      </div>
      <div className={styles.card}>
        {!state && !error && <p className={styles.muted}>Chargement…</p>}
        {error && <p className={styles.error}>{error}</p>}
        {pr ? (
          <div className={styles.release}>
            <p className={pr.state === "fail" ? styles.warnText : styles.okText}>
              <b>Release #{pr.number}</b> · {pr.why}
            </p>
            <div className={styles.row}>
              <a
                className={styles.btn}
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Release #${pr.number} sur GitHub (nouvel onglet)`}
              >
                PR #{pr.number}
                <Icon name="external" size={16} className={styles.btnIconEnd} />
              </a>
              {pr.state !== "merged" && (
                <button type="button" className={styles.btn} onClick={() => void load()}>
                  Vérifier maintenant
                </button>
              )}
            </div>
          </div>
        ) : (
          state && (
            <div className={styles.release}>
              <p>
                {n
                  ? `${n} changement${n > 1 ? "s" : ""} sur develop pas encore en ligne${state.since ? ` (${sinceText(state.since)})` : ""}`
                  : live.length
                    ? "Le site est à jour : rien à mettre en ligne par une release"
                    : "Rien de nouveau sur develop : tout est en ligne"}
              </p>
              {n > 0 && state.next && (
                <p className={styles.releaseNext}>
                  Prochaine version : <b>v{state.next}</b>
                </p>
              )}
              {/* Ce qui partira dans le journal des versions (fragments .changeset) */}
              {n > 0 &&
                (state.notes.length ? (
                  <div className={styles.releaseNotes}>
                    {SECTIONS.map(([bump, title]) => {
                      const list = state.notes.filter((x) => x.bump === bump);
                      return (
                        list.length > 0 && (
                          <div key={bump}>
                            <h3>{title}</h3>
                            <ul>
                              {list.map((x, i) => (
                                <li key={i}>{x.summary}</li>
                              ))}
                            </ul>
                          </div>
                        )
                      );
                    })}
                  </div>
                ) : (
                  <p className={styles.warnText}>
                    Aucune entrée de journal sur develop : la CI de la release la refusera
                  </p>
                ))}
              {n > 0 && (
                <details className={styles.releaseCommits}>
                  <summary>À mettre en ligne ({n})</summary>
                  <ul className={styles.releaseList}>
                    {state.pending.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </details>
              )}
              {n > 0 &&
                (confirming ? (
                  <div className={styles.row}>
                    <span>Mettre ces changements en ligne ?</span>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={busy}
                      onClick={() => void launch()}
                    >
                      {busy ? "Lancement…" : "Oui, lancer"}
                    </button>
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={busy}
                      onClick={() => setConfirming(false)}
                    >
                      Annuler
                    </button>
                  </div>
                ) : (
                  <div className={styles.row}>
                    <button
                      type="button"
                      className={styles.primary}
                      onClick={() => setConfirming(true)}
                    >
                      Lancer la release
                    </button>
                    <span className={styles.muted}>
                      PR develop → main, fusionnée dès que la CI est passée
                    </span>
                  </div>
                ))}
              {live.length > 0 && (
                <details className={styles.releaseCommits}>
                  <summary>
                    Déjà en ligne sans release ({live.length}) : admin, tickets, outillage
                  </summary>
                  <ul className={styles.releaseList}>
                    {live.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )
        )}
      </div>
    </section>
  );
}
