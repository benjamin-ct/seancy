-- Index local des titres (films + séries) les plus populaires, synchronisé
-- quotidiennement depuis TMDB (voir worker/search-index.ts, cron dédié
-- "30 7 * * *" dans wrangler.jsonc). Complète la recherche TMDB pour les
-- requêtes courtes (2-3 lettres) : TMDB n'y fait pas de recherche par
-- préfixe et peut ne jamais renvoyer un titre pourtant très populaire (ex.
-- "Bat" ne renvoie jamais "Batman", même après 500 pages) — voir carte
-- Trello "Ajuster les recherches". `normalized_title` est en minuscules et
-- sans accents pour un filtre "commence par" insensible à la casse/accents.
CREATE TABLE IF NOT EXISTS popular_titles (
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  release_date TEXT,
  poster_path TEXT,
  popularity REAL NOT NULL DEFAULT 0,
  vote_average REAL,
  genre_ids TEXT NOT NULL DEFAULT '[]',
  original_language TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tmdb_id, media_type)
);

CREATE INDEX IF NOT EXISTS idx_popular_titles_normalized_title
  ON popular_titles (normalized_title);
