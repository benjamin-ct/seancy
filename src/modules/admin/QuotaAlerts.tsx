// Rappel en tête d'une carte du tableau de bord : quotas qui approchent de leur
// fin ou sont atteints (mêmes alertes que les notifications, worker/quota-alerts.ts).
import styles from "./Admin.module.css";

export interface QuotaAlert {
  key: string;
  level: "warn" | "bad";
  text: string;
}

export default function QuotaAlerts({ alerts }: { alerts?: QuotaAlert[] }) {
  if (!alerts?.length) {
    return null;
  }
  return (
    <ul className={styles.quotaAlerts} role="status">
      {alerts.map((a) => (
        <li key={a.key} className={a.level === "bad" ? styles.quotaBad : ""}>
          {/* « Cloudflare : … » / « Claude : … » : le nom de la carte suffit, la suite est le message */}
          {a.text.replace(/^(Cloudflare|Claude) : /, "").replace(/^./, (c) => c.toUpperCase())}
        </li>
      ))}
    </ul>
  );
}
