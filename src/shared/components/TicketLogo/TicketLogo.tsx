import styles from "./TicketLogo.module.css";

// Environnement develop persistant (même adresse que worker/hostnames.ts).
export const DEV_HOSTNAME = "seancy-develop.creusatbenjamin.workers.dev";
const isDevSite = typeof window !== "undefined" && window.location.hostname === DEV_HOSTNAME;

// « S » italique de Fraunces 500 vectorisé (même placement que le <text>
// x=44 y=56 font-size=46 de la maquette), pour ne pas dépendre du
// chargement de la police. Même tracé dans public/favicon.svg et
// scripts/generate-icons.ts.
export const TICKET_S_PATH =
  "M43.2 56.5Q41.2 56.5 39.9 56.1Q38.6 55.7 37.8 55.1Q37 54.6 36.6 54.1Q36.2 53.7 36 53.7Q35.7 53.7 35.3 54.1Q34.9 54.5 34.5 54.9Q34 55.4 33.6 55.8Q33.2 56.2 32.9 56.2Q32.5 56.2 32.4 55.9Q32.2 55.7 32.2 55.3L33.6 46.6Q33.6 46.1 33.8 45.9Q34.1 45.6 34.4 45.6Q34.7 45.6 34.9 45.9Q35.1 46.1 35.2 46.5L35.7 49.4Q36.1 52.2 37.9 53.6Q39.6 55.1 42 55.1Q43.7 55.1 44.9 54.4Q46.2 53.8 47 52.7Q47.7 51.5 47.9 50.1Q48.3 48 47.3 46.2Q46.3 44.4 43.4 42.4Q40.1 40.1 38.7 37.9Q37.4 35.7 37.7 32.8Q37.9 30.3 39.4 28.1Q40.9 26 43.6 24.6Q46.3 23.2 50 23.2Q53.1 23.2 55.1 24.2Q57.2 25.2 58.2 26.8Q59.2 28.4 59.1 30.2Q59 31.5 58.4 32.2Q57.9 33 56.9 33Q56.1 33 55.6 32.5Q55.2 32 54.9 30.9L54.5 29Q54 26.6 52.7 25.5Q51.5 24.5 49.6 24.5Q47.7 24.5 46.2 25.3Q44.8 26.1 43.9 27.4Q43.1 28.7 42.9 30.3Q42.6 32.6 43.7 34.4Q44.8 36.3 47.6 38.4Q50.2 40.2 51.5 41.9Q52.9 43.5 53.3 45.1Q53.7 46.7 53.5 48.4Q53.3 50.9 51.8 52.7Q50.4 54.5 48.2 55.5Q45.9 56.5 43.2 56.5Z";

// Symbole « Ticket » de Seancy : ticket de cinéma découpé corail, ligne de
// perforation couleur du fond (effet découpe, suit le thème) et « S » clair.
export default function TicketLogo({ className }: { className?: string }) {
  return (
    <svg
      className={`${styles.ticket} ${isDevSite ? styles.dev : ""} ${className ?? ""}`}
      viewBox="0 0 120 80"
      aria-hidden="true"
    >
      <path
        d="M0 0 H120 V30 A10 10 0 0 0 120 50 V80 H0 V50 A10 10 0 0 0 0 30 Z"
        className={styles.body}
      />
      <line
        x1="86"
        y1="8"
        x2="86"
        y2="72"
        className={styles.perforation}
        strokeWidth="3"
        strokeDasharray="5 5"
      />
      <path d={TICKET_S_PATH} fill="#F5F8FF" />
    </svg>
  );
}
