-- Cache du calcul de recommandations "Pour toi" (voir worker/recommendations.ts
-- et retour de review sur la carte Trello "Recommandations personnalisées") :
-- buildTasteProfile/rankRecommendations lisent toute la bibliothèque de
-- l'utilisateur et jusqu'à 400 lignes de popular_titles, un coût trop élevé
-- pour tourner à chaque ouverture de la page d'accueil. On précalcule un lot
-- (RECOMMENDATION_CACHE_SIZE côté worker) par utilisateur et par scope de
-- type (movie/tv/all, un par onglet de Découvrir), servi tel quel pendant
-- RECOMMENDATION_CACHE_TTL_MS, et recalculé seulement si la carte TTL est
-- dépassée ou si la demande dépasse ce qui a été mis en cache.
CREATE TABLE IF NOT EXISTS recommendation_cache (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_scope TEXT NOT NULL,
  items TEXT NOT NULL,
  cold_start INTEGER NOT NULL DEFAULT 0,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_scope)
);
