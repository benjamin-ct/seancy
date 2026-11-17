// Quotas Cloudflare du compte sur le tableau de bord admin : jauges du jour
// (forfait gratuit, remis à zéro à minuit UTC), détail par Worker et par
// modèle d'IA, santé du Worker seancy et les 7 derniers jours. Données :
// GET /api/admin/usage (worker/cloudflare-usage.ts).
import { useEffect, useState } from "react";
import styles from "./Admin.module.css";

interface Usage {
  day: string;
  requests: number;
  byScript: { name: string; n: number }[];
  errors: number;
  exceededCpu: number;
  cpuMs: number;
  neurons: number;
  aiCalls: number;
  byModel: { name: string; neurons: number }[];
  rowsRead: number;
  rowsWritten: number;
  storage: number;
  prodStorage: number;
  databases: {
    id: string;
    name: string;
    prod: boolean;
    created: string;
    tables: number | null;
    size: number;
    rowsRead: number;
    rowsWritten: number;
  }[];
  dbNames: boolean;
  history: {
    date: string;
    requests: number;
    errors: number;
    neurons: number;
    rowsWritten: number;
  }[];
}
type Reply = { usage: Usage } | { error: string; missing?: boolean };

// Forfait gratuit Workers (mêmes valeurs que FREE dans worker/cloudflare-usage.ts)
const FREE = {
  requests: 100_000,
  neurons: 10_000,
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
  storage: 5 * 1024 ** 3,
  databases: 10,
};
const nf = new Intl.NumberFormat("fr-FR");
// Pages du tableau de bord Cloudflare (« :account » : le compte ouvert, choisi par Cloudflare)
const CF = "https://dash.cloudflare.com/?to=/:account";
const LINKS = {
  workers: `${CF}/workers-and-pages`,
  worker: `${CF}/workers/services/view/seancy/production`,
  secrets: `${CF}/workers/services/view/seancy/production/settings`,
  ai: `${CF}/ai/workers-ai`,
  d1: `${CF}/workers/d1`,
  billing: `${CF}/billing/billable-usage`,
  tokens: "https://dash.cloudflare.com/profile/api-tokens",
};
const ext = { target: "_blank", rel: "noopener noreferrer" } as const;
const mo = (b: number) =>
  b >= 1024 ** 3
    ? `${(b / 1024 ** 3).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} Go`
    : `${(b / 1024 ** 2).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
const dayName = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

function Meter({
  label,
  value,
  limit,
  show = nf.format,
  href,
}: {
  label: string;
  href: string;
  value: number;
  limit: number;
  show?: (n: number) => string;
}) {
  const pct = Math.min(100, (value / limit) * 100);
  const level = pct >= 90 ? styles.meterBad : pct >= 70 ? styles.meterWarn : "";
  return (
    <div className={`${styles.meter} ${level}`}>
      <div className={styles.meterHead}>
        <span>{label}</span>
        <b>{pct < 1 && value > 0 ? "< 1" : Math.round(pct)} %</b>
      </div>
      <div
        className={styles.meterBar}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(value, limit)}
        aria-valuetext={`${show(value)} sur ${show(limit)}`}
      >
        <i style={{ width: `${pct}%` }} />
      </div>
      <small>
        {show(value)} sur {show(limit)} · reste {show(Math.max(0, limit - value))}
      </small>
      <a className={styles.cfLink} href={href} {...ext} aria-label={`${label} sur Cloudflare`}>
        Voir sur Cloudflare ↗
      </a>
    </div>
  );
}

// Dernière réponse (le serveur relit Cloudflare au plus toutes les 2 minutes) : affichée tout de suite au retour
let lastReply: Reply | null = null;

export default function Quotas() {
  const [reply, setReply] = useState<Reply | null>(lastReply);
  useEffect(() => {
    fetch("/api/admin/usage")
      .then(async (r) => {
        const d = ((await r.json().catch(() => null)) as Reply) ?? { error: `Erreur ${r.status}` };
        // Erreur passagère : on garde les derniers chiffres plutôt que de les effacer
        if ("usage" in d || !lastReply) {
          lastReply = d;
          setReply(d);
        }
      })
      .catch(() => !lastReply && setReply({ error: "Serveur injoignable" }));
  }, []);

  // Minuit UTC, à l'heure de Paris (1 h en hiver, 2 h en été)
  const [reset] = useState(() =>
    new Date(new Date().setUTCHours(24, 0, 0, 0)).toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Paris",
    })
  );

  let body;
  if (!reply) {
    body = <p className={styles.muted}>Chargement des quotas…</p>;
  } else if ("error" in reply) {
    body = reply.missing ? (
      <div className={styles.card}>
        <h3>À régler une fois</h3>
        <ol className={styles.steps}>
          <li>
            Cloudflare →{" "}
            <a href={LINKS.tokens} {...ext}>
              Mon profil → Jetons d'API ↗
            </a>{" "}
            → Créer un jeton → <b>Jeton personnalisé</b> : autorisation{" "}
            <b>Compte · Account Analytics · Lecture</b> et <b>Compte · D1 · Lecture</b> (noms et
            tables des bases), sur le compte de Seancy.
          </li>
          <li>
            <a href={LINKS.secrets} {...ext}>
              Workers et Pages → seancy → Paramètres ↗
            </a>{" "}
            → Variables et secrets → ajouter le secret <code>CF_ANALYTICS_TOKEN</code> avec ce
            jeton.
          </li>
        </ol>
        <p className={styles.muted}>
          Lecture seule : le jeton ne peut rien modifier sur le compte.
        </p>
      </div>
    ) : (
      <p className={styles.error}>Quotas non chargés : {reply.error}</p>
    );
  } else {
    const u = reply.usage;
    body = (
      <>
        <div className={styles.meters}>
          <Meter
            label="Requêtes des Workers"
            value={u.requests}
            limit={FREE.requests}
            href={LINKS.workers}
          />
          <Meter
            label="Workers AI (neurones)"
            value={u.neurons}
            limit={FREE.neurons}
            href={LINKS.ai}
          />
          <Meter
            label="D1 · lignes lues"
            value={u.rowsRead}
            limit={FREE.rowsRead}
            href={LINKS.d1}
          />
          <Meter
            label="D1 · lignes écrites"
            value={u.rowsWritten}
            limit={FREE.rowsWritten}
            href={LINKS.d1}
          />
          <Meter
            label="D1 · stockage"
            value={u.storage}
            limit={FREE.storage}
            show={mo}
            href={LINKS.d1}
          />
          <Meter
            label="D1 · bases"
            value={u.databases.length}
            limit={FREE.databases}
            href={LINKS.d1}
          />
        </div>
        <div className={styles.configGrid}>
          <div className={styles.card}>
            <h3>
              Worker seancy aujourd'hui{" "}
              <a className={styles.cfLink} href={LINKS.worker} {...ext}>
                Métriques et journaux ↗
              </a>
            </h3>
            <ul className={styles.facts}>
              <li>
                <span>Erreurs</span>
                <b className={u.errors ? styles.warnText : ""}>{nf.format(u.errors)}</b>
              </li>
              <li>
                <span>Arrêtées (plus de 10 ms de calcul)</span>
                <b className={u.exceededCpu ? styles.warnText : ""}>{nf.format(u.exceededCpu)}</b>
              </li>
              <li>
                <span>Calcul moyen par requête</span>
                <b>{u.cpuMs.toLocaleString("fr-FR")} ms</b>
              </li>
              <li>
                <span>Base de prod</span>
                <b>{mo(u.prodStorage)}</b>
              </li>
            </ul>
          </div>
          <div className={styles.card}>
            <h3>Requêtes par Worker</h3>
            <ul className={styles.facts}>
              {u.byScript.map((s) => (
                <li key={s.name}>
                  <span>{s.name}</span>
                  <b>{nf.format(s.n)}</b>
                </li>
              ))}
              {!u.byScript.length && <li className={styles.muted}>Aucune aujourd'hui</li>}
            </ul>
          </div>
          <div className={styles.card}>
            <h3>
              Workers AI <small>{nf.format(u.aiCalls)} appels</small>
            </h3>
            <ul className={styles.facts}>
              {u.byModel.map((m) => (
                <li key={m.name}>
                  <span>{m.name}</span>
                  <b>{nf.format(m.neurons)}</b>
                </li>
              ))}
              {!u.byModel.length && <li className={styles.muted}>Pas d'appel aujourd'hui</li>}
            </ul>
          </div>
        </div>
        <div className={styles.card}>
          <h3>
            Bases D1{" "}
            <small>
              {u.databases.length} sur {FREE.databases}
            </small>
          </h3>
          {!u.dbNames && (
            <p className={styles.muted}>
              Ajoute la permission <b>D1 · Lecture</b> au jeton pour voir le nom et les tables de
              chaque base.
            </p>
          )}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Base</th>
                  <th scope="col">Tables</th>
                  <th scope="col">Taille</th>
                  <th scope="col">Lignes lues aujourd'hui</th>
                  <th scope="col">Lignes écrites aujourd'hui</th>
                  <th scope="col">Créée le</th>
                </tr>
              </thead>
              <tbody>
                {u.databases.map((d) => (
                  <tr key={d.id}>
                    <th scope="row">
                      <a href={`${LINKS.d1}/databases/${d.id}`} {...ext}>
                        {d.name || `${d.id.slice(0, 8)}…`}
                      </a>
                      {d.prod && <span className={styles.tag}>prod</span>}
                      {/^seancy-preview-pr-/.test(d.name) && (
                        <span className={styles.tag}>preview</span>
                      )}
                    </th>
                    <td>{d.tables ?? "–"}</td>
                    <td>{mo(d.size)}</td>
                    <td>{nf.format(d.rowsRead)}</td>
                    <td>{nf.format(d.rowsWritten)}</td>
                    <td>
                      {d.created
                        ? new Date(d.created).toLocaleDateString("fr-FR", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })
                        : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className={styles.card}>
          <h3>7 derniers jours</h3>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Jour (UTC)</th>
                  <th scope="col">Requêtes</th>
                  <th scope="col">Erreurs seancy</th>
                  <th scope="col">Neurones IA</th>
                  <th scope="col">Lignes D1 écrites</th>
                </tr>
              </thead>
              <tbody>
                {u.history.map((d) => (
                  <tr key={d.date}>
                    <th scope="row">{dayName(d.date)}</th>
                    <td>{nf.format(d.requests)}</td>
                    <td>{nf.format(d.errors)}</td>
                    <td>{nf.format(d.neurons)}</td>
                    <td>{nf.format(d.rowsWritten)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  }
  return (
    <section aria-labelledby="dash-quotas" className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 id="dash-quotas">
          Quotas Cloudflare{" "}
          <small className={styles.muted}>
            aujourd'hui · forfait gratuit, remis à zéro à {reset} (minuit UTC)
          </small>
        </h2>
        <div className={styles.row}>
          <a className={styles.btn} href={LINKS.workers} {...ext}>
            Ouvrir Cloudflare ↗
          </a>
          <a className={styles.btn} href={LINKS.billing} {...ext}>
            Utilisation du compte ↗
          </a>
        </div>
      </div>
      {body}
    </section>
  );
}
