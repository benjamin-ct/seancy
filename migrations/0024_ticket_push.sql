-- Notifications push des tickets (espace admin, worker/tickets.ts) : appareils des
-- administrateurs abonnés depuis la page Tickets (Réglages), à part des abonnements
-- des utilisateurs du site (table subscriptions, nouveautés et rappels).
CREATE TABLE IF NOT EXISTS ticket_push (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
