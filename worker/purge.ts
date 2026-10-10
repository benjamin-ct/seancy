// Purge quotidienne des tables qui ne font que grossir (audit M5) : sans
// elle, chaque requête de connexion, chaque fenêtre de limitation de débit
// et chaque notification envoyée laissent une ligne en base pour toujours.
import { logError } from "./logger.ts";

const DAY_MS = 24 * 60 * 60_000;
// Plus longue fenêtre passée à checkRateLimit (24 h) : on garde une marge
// pour ne jamais effacer le compteur d'une fenêtre encore en cours.
const RATE_LIMIT_RETENTION_MS = 2 * DAY_MS;
// Les sorties notifiées ne servent qu'à ne pas renotifier un titre. Toutes
// les raisons ne regardent que des sorties de quelques jours (genres,
// tendances, rappels), donc un titre notifié il y a 90 jours ne peut plus
// revenir.
const NOTIFIED_RELEASES_RETENTION_MS = 90 * DAY_MS;

export async function purgeExpiredRows(db: D1Database, now = Date.now()): Promise<void> {
  const statements: [string, D1PreparedStatement][] = [
    [
      "rate_limits",
      db
        .prepare("DELETE FROM rate_limits WHERE window_start < ?")
        .bind(now - RATE_LIMIT_RETENTION_MS),
    ],
    // Un lien ou un code expiré est refusé de toute façon (voir auth.ts).
    ["magic_links", db.prepare("DELETE FROM magic_links WHERE expires_at < ?").bind(now)],
    ["email_changes", db.prepare("DELETE FROM email_changes WHERE expires_at < ?").bind(now)],
    ["oauth_states", db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now)],
    ["sessions", db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now)],
    [
      "notified_releases",
      db
        .prepare("DELETE FROM notified_releases WHERE notified_at < ?")
        .bind(now - NOTIFIED_RELEASES_RETENTION_MS),
    ],
    [
      "user_notified_releases",
      db
        .prepare("DELETE FROM user_notified_releases WHERE notified_at < ?")
        .bind(now - NOTIFIED_RELEASES_RETENTION_MS),
    ],
  ];
  // Une requête à la fois : l'échec d'une purge ne doit pas empêcher les
  // autres.
  for (const [table, statement] of statements) {
    try {
      const { meta } = await statement.run();
      if (meta.changes > 0) {
        console.log(`Purge ${table} : ${meta.changes} ligne(s) supprimée(s).`);
      }
    } catch (err) {
      logError(`Purge ${table} en échec :`, err);
    }
  }
}
