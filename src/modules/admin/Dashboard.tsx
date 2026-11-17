// Tableau de bord de l'espace admin : quelques chiffres du site, les quotas
// Cloudflare (Quotas.tsx), les tickets par colonne et l'état des réglages (secrets présents ou non, jamais leur
// valeur). Données : GET /api/admin/overview (worker/admin.ts).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { adminPrefix } from "../../core/lib/adminHost.ts";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import styles from "./Admin.module.css";
import Quotas from "./Quotas.tsx";

interface Overview {
  stats: Record<
    "users" | "usersWeek" | "activeMonth" | "subscriptions" | "libraryItems" | "customLists",
    number
  >;
  tickets: Partial<Record<"idea" | "todo" | "work" | "review" | "done", number>>;
  config: { group: string; items: { name: string; ok: boolean; help: string }[] }[];
}

const nf = new Intl.NumberFormat("fr-FR");
const STATS: [keyof Overview["stats"], string][] = [
  ["users", "Comptes"],
  ["usersWeek", "Nouveaux comptes (7 jours)"],
  ["activeMonth", "Comptes connectés (30 jours)"],
  ["subscriptions", "Appareils abonnés aux notifications"],
  ["libraryItems", "Titres dans les bibliothèques"],
  ["customLists", "Listes perso"],
];
const COLUMNS: [keyof Overview["tickets"], string][] = [
  ["idea", "Idées"],
  ["todo", "À faire"],
  ["work", "En cours"],
  ["review", "À valider"],
  ["done", "Faits"],
];

export default function Dashboard() {
  useDocumentTitle("Admin");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/admin/overview")
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as Overview & { error?: string };
        if (r.ok) {
          setData(d);
        } else {
          setError(d.error || `Erreur ${r.status}`);
        }
      })
      .catch(() => setError("Serveur injoignable"));
  }, []);

  if (error) {
    return <p className={styles.error}>Tableau de bord non chargé : {error}</p>;
  }
  if (!data) {
    return <p className={styles.muted}>Chargement…</p>;
  }
  const missing = data.config.flatMap((g) => g.items).filter((i) => !i.ok).length;
  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <p className={styles.eyebrow}>Espace admin</p>
        <h1 className={styles.title}>Tableau de bord</h1>
      </div>

      <section aria-labelledby="dash-site" className={styles.section}>
        <h2 id="dash-site">Le site</h2>
        <dl className={styles.tiles}>
          {STATS.map(([k, label]) => (
            <div key={k} className={styles.tile}>
              <dt>{label}</dt>
              <dd>{nf.format(data.stats[k])}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Quotas />

      <section aria-labelledby="dash-tickets" className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 id="dash-tickets">Tickets</h2>
          <Link to={`${adminPrefix()}/tickets`} className={styles.btn}>
            Ouvrir le tableau
          </Link>
        </div>
        <ol className={styles.pipeline}>
          {COLUMNS.map(([k, label]) => (
            <li key={k} className={styles[`col_${k}`]}>
              <span>{label}</span>
              <b>{nf.format(data.tickets[k] ?? 0)}</b>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="dash-config" className={styles.section}>
        <h2 id="dash-config">
          Réglages{" "}
          <small className={missing ? styles.warnText : styles.okText}>
            {missing ? `${missing} à faire` : "tout est en place"}
          </small>
        </h2>
        <div className={styles.configGrid}>
          {data.config.map((g) => (
            <div key={g.group} className={styles.card}>
              <h3>{g.group}</h3>
              <ul className={styles.checks}>
                {g.items.map((i) => (
                  <li key={i.name} className={i.ok ? styles.ok : styles.ko}>
                    <span aria-hidden="true">{i.ok ? "✓" : "✗"}</span>
                    <span>
                      <b>{i.name}</b>
                      <span className={styles.visuallyHidden}>
                        {i.ok ? " : en place" : " : manquant"}
                      </span>
                      <small>{i.help}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
