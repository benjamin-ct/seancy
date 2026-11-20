// Visionneuse des pièces jointes d'un ticket (images et vidéos) : plein écran
// dans une modale native au-dessus de la fiche, image ajustée à l'écran ou à
// sa vraie taille (clic sur l'image ou bouton), flèches et glissement d'un
// doigt pour passer d'une pièce à l'autre, Échap pour fermer.
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { fileUrl, type TicketFile } from "./api.ts";
import styles from "./TicketsPage.module.css";

export default function Viewer({
  files,
  start,
  onClose,
}: {
  files: TicketFile[];
  start: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [i, setI] = useState(start);
  const [full, setFull] = useState(false);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const f = files[i];
  const go = (d: number) => {
    setFull(false);
    setI((x) => (x + d + files.length) % files.length);
  };

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  if (!f) {
    return null;
  }
  const image = /^image\//.test(f.type);
  const down = (e: PointerEvent) => {
    swipe.current = full || e.pointerType === "mouse" ? null : { x: e.clientX, y: e.clientY };
  };
  const up = (e: PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (s && files.length > 1) {
      const dx = e.clientX - s.x;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.5) {
        go(dx < 0 ? 1 : -1);
      }
    }
  };

  return (
    <dialog
      ref={ref}
      className={styles.viewer}
      aria-label={`${f.name} (${i + 1} sur ${files.length})`}
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          go(e.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      <div className={styles.viewerBar}>
        <span className={styles.viewerName}>
          {files.length > 1 && (
            <small>
              {i + 1} / {files.length}
            </small>
          )}
          {f.name}
        </span>
        {image && (
          <button
            type="button"
            className={styles.viewerBtn}
            aria-pressed={full}
            onClick={() => setFull(!full)}
          >
            {full ? "Ajuster" : "Taille réelle"}
          </button>
        )}
        <a
          className={styles.viewerBtn}
          href={fileUrl(f)}
          download={f.name}
          target="_blank"
          rel="noopener noreferrer"
        >
          Télécharger
        </a>
        <button
          type="button"
          className={styles.viewerBtn}
          aria-label="Fermer la visionneuse"
          onClick={() => ref.current?.close()}
          autoFocus
        >
          ×
        </button>
      </div>
      <div
        className={`${styles.viewerStage} ${full ? styles.viewerFull : ""}`}
        onPointerDown={down}
        onPointerUp={up}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            ref.current?.close();
          }
        }}
      >
        {image ? (
          <img
            key={f.id}
            src={fileUrl(f)}
            alt={f.name}
            draggable={false}
            onClick={() => setFull(!full)}
          />
        ) : (
          <video key={f.id} src={fileUrl(f)} controls playsInline />
        )}
      </div>
      {files.length > 1 && (
        <>
          <button
            type="button"
            className={`${styles.viewerNav} ${styles.viewerPrev}`}
            aria-label="Pièce précédente"
            onClick={() => go(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className={`${styles.viewerNav} ${styles.viewerNext}`}
            aria-label="Pièce suivante"
            onClick={() => go(1)}
          >
            ›
          </button>
        </>
      )}
    </dialog>
  );
}
