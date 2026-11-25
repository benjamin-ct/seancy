// Consommation de Claude par les tickets, sur le tableau de bord : quota de
// l'abonnement relevé au dernier passage (fenêtre de 5 h, semaine), jetons et
// coût estimé (aujourd'hui, 7 et 30 jours), par modèle et par ticket.
// Données : GET /api/tickets/usage (worker/claude-usage.ts), envoyées par le
// workflow « Tickets (Claude) » à la fin de chaque passage.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { adminPrefix } from "../../core/lib/adminHost.ts";
import { claudeUsage, type ClaudeUsage as Usage } from "../tickets/api.ts";
import QuotaAlerts from "./QuotaAlerts";
import styles from "./Admin.module.css";

let last: Usage | null = null;

const WINDOWS: Record<string, string> = {
  five_hour: "Session (5 h)",
  seven_day: "Semaine",
  seven_day_opus: "Semaine · Opus",
  seven_day_sonnet: "Semaine · Sonnet",
  overage: "Dépassement",
};
const STATUS: Record<string, string> = {
  allowed: "OK",
  allowed_warning: "bientôt atteint",
  rejected: "atteint",
};
const nf = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const usd = (n: number) => `≈ ${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} $`;
const when = (t: number) =>
  new Date(t).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const ago = (t: number) => {
  const min = Math.round((Date.now() - t) / 60_000);
  return min < 1
    ? "à l'instant"
    : min < 60
      ? `il y a ${min} min`
      : min < 1440
        ? `il y a ${Math.round(min / 60)} h`
        : `il y a ${Math.round(min / 1440)} j`;
};

export default function ClaudeUsage() {
  const [usage, setUsage] = useState<Usage | null>(last);
  const [error, setError] = useState("");
  useEffect(() => {
    claudeUsage()
      .then(({ usage: u }) => {
        last = u;
        setUsage(u);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const totals =
    usage &&
    ([
      ["Aujourd'hui", usage.today],
      ["7 jours", usage.week],
      ["30 jours", usage.month],
    ] as const);
  return (
    <section aria-labelledby="dash-claude" className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 id="dash-claude">
          Claude{" "}
          {usage?.last ? (
            <small className={styles.muted}>dernier passage {ago(usage.last)}</small>
          ) : null}
        </h2>
      </div>
      {!usage && !error && <p className={styles.muted}>Chargement…</p>}
      {error && <p className={styles.error}>Consommation non chargée : {error}</p>}
      {usage && (
        <>
          <QuotaAlerts alerts={usage.alerts} />
          {usage.limits.length > 0 ? (
            <div className={styles.meters}>
              {usage.limits.map((l) => {
                const pct = l.used ?? (l.status === "rejected" ? 100 : null);
                const level =
                  l.status === "rejected" || (pct ?? 0) >= 90
                    ? styles.meterBad
                    : l.status === "allowed_warning" || (pct ?? 0) >= 70
                      ? styles.meterWarn
                      : "";
                return (
                  <div key={l.type} className={`${styles.meter} ${level}`}>
                    <div className={styles.meterHead}>
                      <span>Quota · {WINDOWS[l.type] ?? l.type}</span>
                      <b>
                        {pct === null ? (STATUS[l.status] ?? l.status) : `${Math.round(pct)} %`}
                      </b>
                    </div>
                    {pct !== null && (
                      <div
                        className={styles.meterBar}
                        role="meter"
                        aria-label={`Quota ${WINDOWS[l.type] ?? l.type}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={pct}
                      >
                        <i style={{ width: `${pct}%` }} />
                      </div>
                    )}
                    <small>
                      {/* Claude ne donne le pourcentage qu'à l'approche de la limite */}
                      {pct === null && l.status === "allowed"
                        ? "sous le seuil d'alerte (Claude ne donne le pourcentage qu'à l'approche de la limite) · "
                        : ""}
                      {l.resetsAt ? `remis à zéro ${when(l.resetsAt)} · ` : ""}relevé {ago(l.at)}
                    </small>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className={styles.muted}>
              Quota de l'abonnement : pas encore de relevé (il arrive avec le prochain passage de
              Claude sur un ticket).
            </p>
          )}
          <div className={styles.configGrid}>
            <div className={styles.card}>
              <h3>Jetons utilisés</h3>
              <ul className={styles.facts}>
                {totals?.map(([label, t]) => (
                  <li key={label}>
                    <span>
                      {label} · {t.runs} passage{t.runs > 1 ? "s" : ""}
                    </span>
                    <b>
                      {nf.format(t.tokens)} <small className={styles.muted}>{usd(t.cost)}</small>
                    </b>
                  </li>
                ))}
              </ul>
              <p className={styles.muted}>
                Coût estimé au prix public : l'abonnement ne le facture pas, c'est un repère de
                consommation.
              </p>
            </div>
            <div className={styles.card}>
              <h3>Par modèle · 30 jours</h3>
              <ul className={styles.facts}>
                {usage.byModel.map((m) => (
                  <li key={m.model}>
                    <span>{m.model.replace(/^claude-/, "")}</span>
                    <b>{nf.format(m.tokens)}</b>
                  </li>
                ))}
                {!usage.byModel.length && <li className={styles.muted}>Aucun passage relevé</li>}
              </ul>
            </div>
            <div className={styles.card}>
              <h3>Tickets les plus gourmands · 30 jours</h3>
              <ul className={styles.facts}>
                {usage.byTicket.map((t) => (
                  <li key={t.ticket}>
                    <span>
                      <Link to={`${adminPrefix()}/tickets/${t.ticket}`}>{t.title || t.ticket}</Link>
                    </span>
                    <b>{nf.format(t.tokens)}</b>
                  </li>
                ))}
                {!usage.byTicket.length && <li className={styles.muted}>Aucun passage relevé</li>}
              </ul>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
