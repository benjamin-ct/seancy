-- Jeu de données fictives "full" de l'environnement develop (voir ticket
-- Trello "Avenir du développement") : rejoué à chaque push sur la branche
-- `develop` (scripts/preview-d1.ts, provisionDevelop), en complément des
-- migrations. `INSERT OR IGNORE` partout : additif, ne touche jamais une
-- ligne déjà là (données de test modifiées manuellement entre deux pushs),
-- et suit les évolutions du schéma au fil des migrations sans jamais rien
-- écraser. Pour repartir d'une base vide, voir le workflow
-- `reset-develop-db.yml` (déclenché à la main uniquement).
--
-- Trois comptes de démo, avec des jetons de session en clair (hachés en
-- SHA-256 ci-dessous, jamais stockés en clair — voir worker/auth.ts,
-- hashToken), à poser comme cookie `seancy_session` :
--
--   seancy-develop-demo-1  (Alice, profil public, partage sa liste "Classiques")
--   seancy-develop-demo-2  (Benoit, suit Alice)
--   seancy-develop-demo-3  (Chloé, profil privé, aucune donnée de bibliothèque)

INSERT OR IGNORE INTO users (id, email, created_at, display_name, username, locale, region, share_slug)
VALUES
  (1, 'alice@develop.seancy.test', (unixepoch() * 1000), 'Alice', 'alice-demo', 'fr', 'FR', 'alice-demo'),
  (2, 'benoit@develop.seancy.test', (unixepoch() * 1000), 'Benoit', 'benoit-demo', 'fr', 'FR', NULL),
  (3, 'chloe@develop.seancy.test', (unixepoch() * 1000), 'Chloé', 'chloe-demo', 'en', 'US', NULL);

-- Hex SHA-256 de 'seancy-develop-demo-<n>'.
INSERT OR IGNORE INTO sessions (token, user_id, expires_at, created_at)
VALUES
  ('ae733958c91c0799b37f0de0207bf0538923351475e6d8ee0201a073d060159f', 1, (unixepoch() + 31536000) * 1000, (unixepoch() * 1000)),
  ('f1ac66b71a99647c6720d7252acac55472c0099ee7a05f47b22cca54bfee1eea', 2, (unixepoch() + 31536000) * 1000, (unixepoch() * 1000)),
  ('28138b4e8814a572f824af944c4dedc886422b81ea31669cb18fb22f2389b79d', 3, (unixepoch() + 31536000) * 1000, (unixepoch() * 1000));

-- Bibliothèque "vu" / "envie de voir" d'Alice et Benoit (posterPath à null :
-- repli sur le visuel par défaut, voir MediaCard — pas de dépendance à TMDB).
INSERT OR IGNORE INTO library_items (user_id, media_type, tmdb_id, status, data, updated_at) VALUES
  (1, 'movie', 603, 'watched', '{"id":603,"mediaType":"movie","title":"Matrix","posterPath":null,"date":"1999-03-30","addedAt":0,"rating":9}', (unixepoch() * 1000)),
  (1, 'movie', 27205, 'watchlist', '{"id":27205,"mediaType":"movie","title":"Inception","posterPath":null,"date":"2010-07-15","addedAt":0}', (unixepoch() * 1000)),
  (1, 'tv', 1396, 'watched', '{"id":1396,"mediaType":"tv","title":"Breaking Bad","posterPath":null,"date":"2008-01-20","addedAt":0,"rating":10}', (unixepoch() * 1000)),
  (2, 'movie', 157336, 'watched', '{"id":157336,"mediaType":"movie","title":"Interstellar","posterPath":null,"date":"2014-11-05","addedAt":0,"rating":8}', (unixepoch() * 1000)),
  (2, 'tv', 1399, 'watchlist', '{"id":1399,"mediaType":"tv","title":"Game of Thrones","posterPath":null,"date":"2011-04-17","addedAt":0}', (unixepoch() * 1000));

-- Listes perso : "Classiques" (Alice, partagée) et "A tester" (Benoit).
INSERT OR IGNORE INTO custom_lists (id, user_id, name, created_at) VALUES
  ('list-demo-classiques', 1, 'Classiques', (unixepoch() * 1000)),
  ('list-demo-a-tester', 2, 'A tester', (unixepoch() * 1000));

INSERT OR IGNORE INTO custom_list_items (user_id, list_id, media_type, tmdb_id, data, position) VALUES
  (1, 'list-demo-classiques', 'movie', 603, '{"id":603,"mediaType":"movie","title":"Matrix","posterPath":null}', 0),
  (1, 'list-demo-classiques', 'tv', 1396, '{"id":1396,"mediaType":"tv","title":"Breaking Bad","posterPath":null}', 1),
  (2, 'list-demo-a-tester', 'movie', 27205, '{"id":27205,"mediaType":"movie","title":"Inception","posterPath":null}', 0);

INSERT OR IGNORE INTO list_shares (slug, user_id, list_id, created_at)
VALUES ('classiques-demo', 1, 'list-demo-classiques', (unixepoch() * 1000));

-- Benoit suit Alice (profil public, share_slug non NULL — voir migration
-- 0011). Chloé reste sans abonnement, pour tester le cas "profil privé".
INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at)
VALUES (2, 1, (unixepoch() * 1000));

-- Préférences (genres exclus, plateformes/langues/pays favoris), pour
-- tester les écrans de réglages sans partir d'un compte vierge.
INSERT OR IGNORE INTO excluded_genre_prefs (user_id, genre_id) VALUES (1, 27); -- Horreur
INSERT OR IGNORE INTO favorite_provider_prefs (user_id, provider_id) VALUES
  (1, 8),   -- Netflix
  (1, 337), -- Disney+
  (2, 119); -- Prime Video
INSERT OR IGNORE INTO favorite_language_prefs (user_id, language_code) VALUES (1, 'fr'), (2, 'en');
INSERT OR IGNORE INTO favorite_country_prefs (user_id, country_code) VALUES (1, 'FR'), (2, 'US');
