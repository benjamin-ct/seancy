// Mise en ligne depuis le tableau de bord, sans ticket : ce qui attend sur
// develop, « Lancer la release » (PR develop → main), puis son suivi jusqu'à la
// fusion, faite par le serveur dès que la CI est passée (worker/tickets.ts).
import { useCallback, useEffect, useState } from "react";
import Icon from "../../shared/components/Icon/Icon.tsx";
import { releaseState, startRelease, type ReleaseState } from "../tickets/api.ts";
import styles from "./Admin.module.css";

// Dernier état : affiché tout de suite au retour sur l'onglet
let last: ReleaseState | null = null;

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
                  ? `${n} changement${n > 1 ? "s" : ""} sur develop pas encore en ligne`
                  : "Rien de nouveau sur develop : tout est en ligne"}
              </p>
              {n > 0 && (
                <ul className={styles.releaseList}>
                  {state.pending.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
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
            </div>
          )
        )}
      </div>
    </section>
  );
}
