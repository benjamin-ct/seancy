-- Consommation de Claude par les tickets (worker/claude-usage.ts) : un passage
-- de Claude par ligne (jetons et coût estimé par modèle, état du quota relevé),
-- envoyé par le workflow « Tickets (Claude) » ; gardé 90 jours.
CREATE TABLE IF NOT EXISTS claude_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket TEXT NOT NULL DEFAULT '',
  run TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS claude_usage_at ON claude_usage (at);
