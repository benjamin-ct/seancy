-- Suggestions « Pour vous ce soir » générées par Workers AI (voir
-- worker/ai-suggestions.ts et carte Trello "Worker AI pour l'algo V2").
-- La section existait déjà côté client (tirage du jour parmi les films
-- populaires) ; elle est désormais alimentée par un LLM à partir de
-- l'historique de l'utilisateur, et l'algo heuristique "Pour toi" (v1,
-- worker/recommendations.ts) ne sert plus ici que de repli.
--
-- Un lot par utilisateur et par jour, généré à la demande en arrière-plan
-- (`ctx.waitUntil`) : le quota gratuit Workers AI (~10 000 neurones/jour,
-- partagé par tout le compte Cloudflare) ne tient qu'environ 250
-- générations par jour, donc jamais plus d'une par utilisateur actif. Les
-- lots des jours précédents sont gardés une semaine, le temps de servir
-- de liste « déjà proposés » au prompt du lendemain (sans elle, le modèle
-- redonne en grande partie les mêmes titres d'un jour à l'autre).
--
-- `status` : 'pending' sert aussi de verrou (une seule génération à la fois
-- par utilisateur, même avec plusieurs onglets qui interrogent en même
-- temps), avec une `expires_at` courte pour qu'un Worker coupé en pleine
-- génération ne bloque pas la journée entière. 'fallback' = lot rempli par
-- l'algo v1 (quota dépassé, erreur IA, profil trop maigre) : sa durée de vie
-- est plus courte que celle d'un lot 'ready', pour retenter l'IA dès que
-- possible. `prompt_tokens`/`completion_tokens` remplacent une table de
-- suivi de consommation dédiée (écartée sur la carte) : de quoi recalculer
-- les neurones consommés si besoin, le dashboard Cloudflare restant la
-- référence pour le quota.
CREATE TABLE IF NOT EXISTS ai_suggestion_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'fallback')),
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_suggestion_batches_user
  ON ai_suggestion_batches (user_id, created_at);

-- `media_type` indispensable à côté de `tmdb_id` : les identifiants TMDB des
-- films et des séries se chevauchent (le film 1399 n'est pas la série 1399).
CREATE TABLE IF NOT EXISTS ai_suggestion_titles (
  batch_id INTEGER NOT NULL REFERENCES ai_suggestion_batches(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  PRIMARY KEY (batch_id, rank)
);

-- « Autre suggestion » sur un titre proposé par l'IA. Volontairement séparé
-- de `not_interested` (migration 0019) : ce dernier est un signal négatif
-- permanent qui pèse sur le scoring de genre/décennie de l'algo v1, alors
-- qu'un skip ici veut juste dire « pas ce soir ». Il expire au bout de 6 mois
-- (décision produit sur la carte) : le titre redevient alors proposable.
-- D1 n'ayant pas de TTL natif, l'expiration se fait au `SELECT`
-- (`expires_at > now`), sans purge dédiée.
CREATE TABLE IF NOT EXISTS ai_suggestion_skips (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  skipped_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_type, tmdb_id)
);

-- Titre original (et titre français) des titres cités dans le prompt. Les
-- benchmarks de la carte ont montré que le modèle ne fait pas toujours le
-- lien entre un titre traduit et l'original (« Les Infiltrés » / « The
-- Departed ») et re-propose alors un titre déjà vu ou ignoré ; or la
-- bibliothèque ne stocke que le titre dans la langue de l'interface au
-- moment de l'ajout. Rempli au fil des générations (résolutions TMDB des
-- titres proposés, plus quelques fiches TMDB par génération pour les titres
-- de la bibliothèque encore inconnus) et partagé entre utilisateurs, comme
-- `poster_thumbhashes` : un titre original n'a rien de personnel.
CREATE TABLE IF NOT EXISTS tmdb_title_labels (
  media_type TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  title TEXT,
  original_title TEXT,
  original_language TEXT,
  release_year INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (media_type, tmdb_id)
);
