// Outils de maintenance de l'espace admin : les actions qui demandaient
// jusqu'ici la clé de debug (/api/run-check, /api/test-error…), lancées en
// un clic par un administrateur connecté (POST /api/admin/tools/<outil>,
// worker/admin.ts). Celles qui touchent tous les abonnés demandent une
// confirmation.
import { useState } from "react";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import { DEV_HOSTNAME } from "../../shared/components/TicketLogo/TicketLogo.tsx";
import styles from "./Admin.module.css";

const TOOLS = [
  {
    id: "test-notification",
    name: "Notification de test",
    text: "Envoie une notification à tes propres appareils abonnés (aucun autre abonné), pour vérifier les notifications push.",
    confirm: "",
  },
  {
    id: "run-check",
    name: "Vérifier les nouveautés maintenant",
    text: "Lance tout de suite la vérification quotidienne de 7 h : sorties, plateformes, rappels. Des notifications peuvent partir vers les abonnés concernés.",
    confirm: "Lancer la vérification ? Les abonnés concernés peuvent recevoir des notifications.",
  },
  {
    id: "sync-search-index",
    name: "Resynchroniser la recherche",
    text: "Met à jour l'index local des titres populaires utilisé par la recherche (normalement chaque jour à 7 h 30).",
    confirm: "",
  },
  {
    id: "test-error",
    name: "Erreur de test Sentry",
    text: "Envoie une erreur de test à Sentry pour vérifier la remontée des erreurs du Worker.",
    confirm: "",
  },
  {
    id: "test-sentry-ticket",
    name: "Test ticket Sentry",
    text: "Envoie à Sentry une erreur marquée « Test ticket Sentry », nouvelle à chaque essai : l'alerte part sur Discord et sentry-triage (NAS) crée un ticket « À faire » (étiquettes Sentry et Test), à supprimer ensuite.",
    confirm: "",
  },
] as const;

export default function Tools() {
  useDocumentTitle("Outils · Admin");
  const [busy, setBusy] = useState("");
  const [asking, setAsking] = useState("");
  const [result, setResult] = useState<Record<string, { ok: boolean; text: string }>>({});

  const run = async (id: string) => {
    setAsking("");
    setBusy(id);
    try {
      const r = await fetch(`/api/admin/tools/${id}`, { method: "POST" });
      const d = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
      setResult((x) => ({
        ...x,
        [id]: { ok: r.ok, text: r.ok ? d.message || "Fait" : d.error || `Erreur ${r.status}` },
      }));
    } catch {
      setResult((x) => ({ ...x, [id]: { ok: false, text: "Serveur injoignable" } }));
    }
    setBusy("");
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <p className={styles.eyebrow}>Espace admin</p>
        <h1 className={styles.title}>Outils</h1>
      </div>
      <div className={styles.tools}>
        {/* Visible aussi sur téléphone, où l'en-tête n'a pas de lien */}
        <article className={styles.card}>
          <h2>Site de développement</h2>
          <p className={styles.muted}>
            La version de test du site, avec les changements pas encore en ligne.
          </p>
          <a
            href={`https://${DEV_HOSTNAME}/`}
            className={styles.primary}
            target="_blank"
            rel="noopener noreferrer"
          >
            Ouvrir
          </a>
        </article>
        {TOOLS.map((t) => (
          <article key={t.id} className={styles.card}>
            <h2>{t.name}</h2>
            <p className={styles.muted}>{t.text}</p>
            {asking === t.id ? (
              <div className={styles.row} role="group" aria-label="Confirmation">
                <span>{t.confirm}</span>
                <button type="button" className={styles.primary} onClick={() => run(t.id)}>
                  Lancer
                </button>
                <button type="button" className={styles.btn} onClick={() => setAsking("")}>
                  Annuler
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={styles.primary}
                disabled={!!busy}
                onClick={() => (t.confirm ? setAsking(t.id) : run(t.id))}
              >
                {busy === t.id ? "En cours…" : "Lancer"}
              </button>
            )}
            {result[t.id] && (
              <p className={result[t.id].ok ? styles.okText : styles.error} role="status">
                {result[t.id].text}
              </p>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
