import { useEffect, useRef, type ReactNode } from "react";
import styles from "./TicketsPage.module.css";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  label: string;
  wide?: boolean;
  children: ReactNode;
}

/** Modale native (<dialog>) de la page Tickets : Échap et clic sur le fond la ferment. */
export default function Dialog({ open, onClose, label, wide = false, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) {
      return;
    }
    if (open && !d.open) {
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`${styles.dialog} ${wide ? styles.dialogWide : ""}`}
      aria-label={label}
      // Seulement sa propre fermeture (celle d'une modale imbriquée, la visionneuse, remonte aussi ici)
      onClose={(e) => {
        if (e.target === ref.current) {
          onClose();
        }
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          onClose();
        }
      }}
    >
      {open && (
        <div className={styles.dialogBody}>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Fermer">
            ×
          </button>
          {children}
        </div>
      )}
    </dialog>
  );
}
