import type { ReactNode } from "react";
import styles from "./SettingsGroup.module.css";

// Nouvelle DA (onglets Compte et Préférences) : un groupe de réglages = un
// titre, sa description, puis un seul bloc Surface 1 découpé en lignes
// séparées par un filet.
export function SettingsGroup({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className={styles.group}>
      <h2 className={styles.title}>{title}</h2>
      {description && <p className={styles.description}>{description}</p>}
      <div className={styles.panel}>{children}</div>
    </section>
  );
}

// Une ligne : libellé et description à gauche (300 px) et contrôle à droite
// sur desktop ; description au-dessus du contrôle sur mobile.
export function SettingsRow({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <h3 className={styles.rowLabel}>{label}</h3>
        {description && <p className={styles.rowDescription}>{description}</p>}
      </div>
      {children && <div className={styles.rowControl}>{children}</div>}
    </div>
  );
}
