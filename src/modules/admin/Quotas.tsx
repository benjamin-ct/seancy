// Quotas Cloudflare du compte sur le tableau de bord admin : jauges de la
// période de facturation (forfait Workers Paid : volumes inclus par mois, coût
// estimé au-delà ; neurones Workers AI gratuits par jour), détail par Worker et
// par modèle d'IA, santé du Worker seancy et les 7 derniers jours. Données :
// GET /api/admin/usage (worker/cloudflare-usage.ts).
import { useEffect, useState } from "react";
import styles from "./Admin.module.css";
import QuotaAlerts, { type QuotaAlert } from "./QuotaAlerts";

interface Usage {
  day: string;
  month: {
    from: string;
    renews: string;
    requests: number;
    cpuMs: number;
    rowsRead: number;
    rowsWritten: number;
    neuronsBilled: number;
    cost: {
      requests: number;
      cpuMs: number;
      rowsRead: number;
      rowsWritten: number;
      storage: number;
      neurons: number;
      total: number;
    };
  };
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
type Reply = { usage: Usage; alerts?: QuotaAlert[] } | { error: string; missing?: boolean };

// Volumes inclus du forfait Workers Paid (mêmes valeurs que PAID dans worker/cloudflare-usage.ts)
const PAID = {
  fee: 5,
  requests: 10_000_000,
  cpuMs: 30_000_000,
  rowsRead: 25_000_000_000,
  rowsWritten: 50_000_000,
  storage: 5 * 1024 ** 3,
  neuronsPerDay: 10_000,
};
const nf = new Intl.NumberFormat("fr-FR");
// Grands nombres en abrégé (« 2,7 M », « 25 Md ») pour tenir sur un téléphone
const big = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} Md`
    : n >= 1e6
      ? `${(n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} M`
      : nf.format(n);
const usd = (n: number) =>
  `${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const dateFr = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
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
  show = big,
  href,
  cost,
}: {
  label: string;
  href: string;
  value: number;
  limit: number;
  show?: (n: number) => string;
  /** Coût estimé au-delà de l'inclus ($) ; absent : pas facturé à l'unité. */
  cost?: number;
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
        {show(value)} sur {show(limit)} inclus ·{" "}
        {value > limit
          ? `dépassé de ${show(value - limit)}${cost ? ` · ≈ ${usd(cost)}` : ""}`
          : `reste ${show(limit - value)}`}
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

  // Minuit UTC (neurones gratuits du jour), à l'heure de Paris (1 h en hiver, 2 h en été)
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
    const m = u.month;
    body = (
      <>
        <QuotaAlerts alerts={reply.alerts} />
        <p className={styles.muted}>
          Coût estimé au-delà de l'inclus depuis le {dateFr(m.from)} :{" "}
          <b className={m.cost.total ? styles.warnText : ""}>≈ {usd(m.cost.total)}</b>, en plus des{" "}
          {PAID.fee} $ du forfait.
        </p>
        <div className={styles.meters}>
          <Meter
            label="Requêtes des Workers"
            value={m.requests}
            limit={PAID.requests}
            cost={m.cost.requests}
            href={LINKS.workers}
          />
          <Meter
            label="Temps de calcul (ms)"
            value={m.cpuMs}
            limit={PAID.cpuMs}
            cost={m.cost.cpuMs}
            href={LINKS.workers}
          />
          <Meter
            label="Workers AI · neurones du jour"
            value={u.neurons}
            limit={PAID.neuronsPerDay}
            cost={u.neurons > PAID.neuronsPerDay ? m.cost.neurons : undefined}
            href={LINKS.ai}
          />
          <Meter
            label="D1 · lignes lues"
            value={m.rowsRead}
            limit={PAID.rowsRead}
            cost={m.cost.rowsRead}
            href={LINKS.d1}
          />
          <Meter
            label="D1 · lignes écrites"
            value={m.rowsWritten}
            limit={PAID.rowsWritten}
            cost={m.cost.rowsWritten}
            href={LINKS.d1}
          />
          <Meter
            label="D1 · stockage"
            value={u.storage}
            limit={PAID.storage}
            cost={m.cost.storage}
            show={mo}
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
                <span>Arrêtées (limite de calcul dépassée)</span>
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
              {u.databases.length} base{u.databases.length > 1 ? "s" : ""}
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
            forfait Workers Paid · période du{" "}
            {reply && "usage" in reply
              ? `${dateFr(reply.usage.month.from)}, remise à zéro le ${dateFr(reply.usage.month.renews)}`
              : "mois"}{" "}
            · neurones IA gratuits remis à zéro à {reset}
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
