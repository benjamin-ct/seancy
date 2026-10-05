-- Requêtes sociales (audit M6), sans pagination :
-- - compteurs « N vus · N en commun » des listes d'abonnés/abonnements et de
--   la recherche de profils : comptés sur cet index, sans lire les lignes ;
-- - fil d'activité : les entrées les plus récentes de chaque profil suivi
--   sont lues dans l'ordre de l'index, au lieu de toute sa bibliothèque.
CREATE INDEX IF NOT EXISTS idx_library_items_user_status
  ON library_items(user_id, status, media_type, tmdb_id);
CREATE INDEX IF NOT EXISTS idx_library_items_user_updated
  ON library_items(user_id, updated_at);
