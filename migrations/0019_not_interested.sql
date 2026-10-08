-- Signal négatif "pas intéressé" pour les recommandations personnalisées
-- (voir worker/recommendations.ts et ticket Trello "Recommandations
-- personnalisées « Pour toi »"). Table séparée de library_items (qui ne
-- modélise que vu/envie de voir) plutôt qu'un 3e statut : un titre "pas
-- intéressé" n'est ni vu ni en envie de voir, et ce signal n'a aucun des
-- champs de library_items (note, épisodes vus...).
--
-- `genre_ids`/`release_date` sont dupliqués depuis la carte cliquée (fournis
-- par le client, comme `data` sur library_items) plutôt que re-résolus
-- depuis TMDB : un titre "pas intéressé" peut provenir de n'importe quelle
-- grille, pas seulement du cache local `popular_titles`, et ce signal doit
-- rester exploitable pour le scoring de genre/décennie même si le titre n'y
-- figure jamais.
CREATE TABLE IF NOT EXISTS not_interested (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  genre_ids TEXT NOT NULL DEFAULT '[]',
  release_date TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_type, tmdb_id)
);
