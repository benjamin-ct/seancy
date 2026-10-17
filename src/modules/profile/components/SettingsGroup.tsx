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
  /** Omis quand la ligne unique du groupe porte déjà son propre titre. */
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className={styles.group}>
      {title && <h2 className={styles.title}>{title}</h2>}
      {description && <p className={styles.description}>{description}</p>}
      <div className={styles.panel}>{children}</div>
    </section>
  );
}

// Une ligne : libellé et description à gauche (300 px) et contrôle à droite
// sur desktop ; description au-dessus du contrôle sur mobile.
// `wide` : le contrôle a besoin de toute la largeur du panneau plutôt que du
// 1fr restant à côté de la colonne de libellé de 300px (ex. grille de cases
// à cocher 2 colonnes — plateformes, langues, pays, genres à exclure — dont
// les 354px habituels tronquaient les noms, retour de review). Libellé et
// description passent au-dessus du contrôle, en pleine largeur, comme déjà
// le cas sur mobile.
export function SettingsRow({
  label,
  description,
  wide,
  children,
}: {
  /** Omis quand le titre du groupe porte déjà l'intitulé de cette unique ligne. */
  label?: ReactNode;
  description?: ReactNode;
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`${styles.row} ${wide ? styles.rowWide : ""}`}>
      {(label || description) && (
        <div className={styles.rowHead}>
          {label && <h3 className={styles.rowLabel}>{label}</h3>}
          {description && <p className={styles.rowDescription}>{description}</p>}
        </div>
      )}
      {children && <div className={styles.rowControl}>{children}</div>}
    </div>
  );
}
