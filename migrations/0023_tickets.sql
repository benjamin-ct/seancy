-- Tickets de développement envoyés à Claude (page /tickets, réservée aux
-- administrateurs : secret TICKETS_ADMIN_EMAILS). Remplace le board Trello :
-- voir worker/tickets.ts et la section « Tickets (Claude) » du README.
--
-- Un ticket = une ligne. `status` fixe sa colonne (idea, todo, work, review,
-- done) et `position` son ordre dans la colonne ; tout le reste (titre,
-- description, compte rendu de Claude, PR, avancement, historique…) vit dans
-- `data` (JSON nettoyé par cleanTicket, worker/tickets-logic.ts), pour ne pas
-- demander une migration à chaque champ ajouté. `version` sert aux écritures
-- conditionnelles (deux onglets, ou la page et le workflow en même temps).
-- `trello_id` : carte Trello d'origine (import unique, scripts/trello-import.ts).
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'todo',
  position REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  trello_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_trello ON tickets (trello_id) WHERE trello_id IS NOT NULL;

-- Pièces jointes (captures, photos) : gardées en base, 1,5 Mo au plus chacune
-- (limite de taille d'une ligne D1), effacées avec leur ticket.
CREATE TABLE IF NOT EXISTS ticket_files (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_files_ticket ON ticket_files (ticket_id);

-- Réglages : empreinte de la clé des sessions Claude (k = 'key'), dernier
-- passage des tâches planifiées.
CREATE TABLE IF NOT EXISTS ticket_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
