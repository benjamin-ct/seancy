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
--   seancy-develop-demo-1  (Alice, profil public, partage sa liste "Classiques", fan de SF)
--   seancy-develop-demo-2  (Benoit, suit Alice, fan de comédie)
--   seancy-develop-demo-3  (Chloé, profil privé, fan de comédies romantiques)
--
-- Chaque profil a au moins 5 films et 5 séries dans sa bibliothèque, dans le
-- genre qui lui est associé ci-dessus (demande TheApac, carte "Rejouer les
-- fixtures de seed...", commentaire du 2026-10-21 : pouvoir tester l'algo
-- "Pour toi" avec des goûts distincts et suffisamment de matière par profil).

-- Domaine `@exemple.test`, pas `@develop.seancy.test` : c'est l'adresse que les
-- testeurs tapent réellement dans le formulaire de connexion (voir ticket
-- Trello "Environnement de test" et le rapport de bug de ce ticket-ci) —
-- `findOrCreateUser` (worker/auth.ts) fait un match exact sur l'email, donc
-- toute adresse qui ne correspond pas mot pour mot crée un compte vide au
-- lieu de retomber sur celui-ci.
--
-- `ON CONFLICT DO UPDATE`, pas `OR IGNORE`, pour ces 3 lignes précises : ce
-- sont des comptes système (id fixe), pas des données de test qu'un humain
-- pourrait modifier à la main entre deux pushs (contrairement aux tables
-- suivantes) — un changement d'identité ici (comme ce renommage d'email)
-- doit se propager aux bases déjà provisionnées (preview en cours, `develop`
-- persistant), pas rester figé sur la valeur de la toute première exécution.
--
-- Nettoyage préalable : avant ce correctif, un testeur qui tapait l'une de
-- ces adresses dans le formulaire de connexion recevait un compte vide créé
-- à la volée par `findOrCreateUser` sous cet email (toujours vide, l'id fixe
-- ci-dessous n'étant pas celui-là) — email désormais déjà pris, ce qui ferait
-- échouer l'UPSERT ci-dessous (colonne UNIQUE). On retire ce compte
-- "squatteur" (et sa session, pas de ON DELETE CASCADE sur D1) pour que le
-- compte démo officiel puisse reprendre son adresse.
DELETE FROM sessions WHERE user_id IN (
  SELECT id FROM users WHERE id NOT IN (1, 2, 3)
    AND email IN ('alice@exemple.test', 'benoit@exemple.test', 'chloe@exemple.test')
);
DELETE FROM users WHERE id NOT IN (1, 2, 3)
  AND email IN ('alice@exemple.test', 'benoit@exemple.test', 'chloe@exemple.test');

INSERT INTO users (id, email, created_at, display_name, username, locale, region, share_slug)
VALUES
  (1, 'alice@exemple.test', (unixepoch() * 1000), 'Alice', 'alice-demo', 'fr', 'FR', 'alice-demo'),
  (2, 'benoit@exemple.test', (unixepoch() * 1000), 'Benoit', 'benoit-demo', 'fr', 'FR', NULL),
  (3, 'chloe@exemple.test', (unixepoch() * 1000), 'Chloé', 'chloe-demo', 'en', 'US', NULL)
ON CONFLICT(id) DO UPDATE SET
  email = excluded.email,
  display_name = excluded.display_name,
  username = excluded.username,
  locale = excluded.locale,
  region = excluded.region,
  share_slug = excluded.share_slug;

-- Hex SHA-256 de 'seancy-develop-demo-<n>'.
INSERT OR IGNORE INTO sessions (token, user_id, expires_at, created_at)
VALUES
  ('ae733958c91c0799b37f0de0207bf0538923351475e6d8ee0201a073d060159f', 1, (unixepoch() + 31536000) * 1000, (unixepoch() * 1000)),
  ('f1ac66b71a99647c6720d7252acac55472c0099ee7a05f47b22cca54bfee1eea', 2, (unixepoch() + 31536000) * 1000, (unixepoch() * 1000)),
  ('28138b4e8814a572f824af944c4dedc886422b81ea31669cb18fb22f2389b79d', 3, (unixepoch() + 31536000) * 1000, (unixepoch() * 1000));

-- Bibliothèque "vu" / "envie de voir" des 3 profils (posterPath à null :
-- repli sur le visuel par défaut, voir MediaCard — pas de dépendance à
-- TMDB). Au moins 5 films + 5 séries par profil, dans le genre de son
-- profil (SF pour Alice, comédie pour Benoit, comédie romantique pour
-- Chloé) : tmdb_id vérifiés réels (API TMDB), pour que le repli non-IA des
-- suggestions (`popular_titles`) et un futur enrichissement par genre aient
-- de vraies correspondances à exploiter. `library_items` n'a pas de ligne
-- "système" à upserter comme `users`, donc les deux anciens titres de
-- Benoit (SF/fantasy, hors thème comédie) sont retirés explicitement plutôt
-- que laissés par `OR IGNORE` sur une base déjà provisionnée.
DELETE FROM library_items
WHERE user_id = 2 AND ((media_type = 'movie' AND tmdb_id = 157336) OR (media_type = 'tv' AND tmdb_id = 1399));

INSERT OR IGNORE INTO library_items (user_id, media_type, tmdb_id, status, data, updated_at) VALUES
  -- Alice (SF)
  (1, 'movie', 603, 'watched', '{"id":603,"mediaType":"movie","title":"Matrix","posterPath":null,"date":"1999-03-30","addedAt":0,"rating":9}', (unixepoch() * 1000)),
  (1, 'movie', 27205, 'watchlist', '{"id":27205,"mediaType":"movie","title":"Inception","posterPath":null,"date":"2010-07-15","addedAt":0}', (unixepoch() * 1000)),
  (1, 'movie', 335984, 'watched', '{"id":335984,"mediaType":"movie","title":"Blade Runner 2049","posterPath":null,"date":"2017-10-04","addedAt":0,"rating":8}', (unixepoch() * 1000)),
  (1, 'movie', 329865, 'watchlist', '{"id":329865,"mediaType":"movie","title":"Premier Contact","posterPath":null,"date":"2016-11-10","addedAt":0}', (unixepoch() * 1000)),
  (1, 'movie', 438631, 'watched', '{"id":438631,"mediaType":"movie","title":"Dune","posterPath":null,"date":"2021-09-15","addedAt":0,"rating":9}', (unixepoch() * 1000)),
  (1, 'tv', 1396, 'watched', '{"id":1396,"mediaType":"tv","title":"Breaking Bad","posterPath":null,"date":"2008-01-20","addedAt":0,"rating":10}', (unixepoch() * 1000)),
  (1, 'tv', 66732, 'watched', '{"id":66732,"mediaType":"tv","title":"Stranger Things","posterPath":null,"date":"2016-07-15","addedAt":0,"rating":8}', (unixepoch() * 1000)),
  (1, 'tv', 42009, 'watchlist', '{"id":42009,"mediaType":"tv","title":"Black Mirror","posterPath":null,"date":"2011-12-04","addedAt":0}', (unixepoch() * 1000)),
  (1, 'tv', 70523, 'watched', '{"id":70523,"mediaType":"tv","title":"Dark","posterPath":null,"date":"2017-12-01","addedAt":0,"rating":9}', (unixepoch() * 1000)),
  (1, 'tv', 63639, 'watchlist', '{"id":63639,"mediaType":"tv","title":"The Expanse","posterPath":null,"date":"2015-12-14","addedAt":0}', (unixepoch() * 1000)),
  -- Benoit (comédie)
  (2, 'movie', 18785, 'watched', '{"id":18785,"mediaType":"movie","title":"Very Bad Trip","posterPath":null,"date":"2009-06-02","addedAt":0,"rating":7}', (unixepoch() * 1000)),
  (2, 'movie', 8363, 'watchlist', '{"id":8363,"mediaType":"movie","title":"SuperGrave","posterPath":null,"date":"2007-08-17","addedAt":0}', (unixepoch() * 1000)),
  (2, 'movie', 55721, 'watched', '{"id":55721,"mediaType":"movie","title":"Mes meilleures amies","posterPath":null,"date":"2011-05-13","addedAt":0,"rating":7}', (unixepoch() * 1000)),
  (2, 'movie', 8699, 'watchlist', '{"id":8699,"mediaType":"movie","title":"Présentateur vedette : La Légende de Ron Burgundy","posterPath":null,"date":"2004-06-28","addedAt":0}', (unixepoch() * 1000)),
  (2, 'movie', 9398, 'watched', '{"id":9398,"mediaType":"movie","title":"Zoolander","posterPath":null,"date":"2001-09-28","addedAt":0,"rating":6}', (unixepoch() * 1000)),
  (2, 'tv', 2316, 'watched', '{"id":2316,"mediaType":"tv","title":"The Office","posterPath":null,"date":"2005-03-24","addedAt":0,"rating":9}', (unixepoch() * 1000)),
  (2, 'tv', 48891, 'watchlist', '{"id":48891,"mediaType":"tv","title":"Brooklyn Nine-Nine","posterPath":null,"date":"2013-09-17","addedAt":0}', (unixepoch() * 1000)),
  (2, 'tv', 1668, 'watched', '{"id":1668,"mediaType":"tv","title":"Friends","posterPath":null,"date":"1994-09-22","addedAt":0,"rating":8}', (unixepoch() * 1000)),
  (2, 'tv', 8592, 'watchlist', '{"id":8592,"mediaType":"tv","title":"Parks and Recreation","posterPath":null,"date":"2009-04-09","addedAt":0}', (unixepoch() * 1000)),
  (2, 'tv', 1421, 'watched', '{"id":1421,"mediaType":"tv","title":"Modern Family","posterPath":null,"date":"2009-09-23","addedAt":0,"rating":7}', (unixepoch() * 1000)),
  -- Chloé (comédie romantique)
  (3, 'movie', 509, 'watched', '{"id":509,"mediaType":"movie","title":"Coup de foudre à Notting Hill","posterPath":null,"date":"1999-05-21","addedAt":0,"rating":8}', (unixepoch() * 1000)),
  (3, 'movie', 508, 'watched', '{"id":508,"mediaType":"movie","title":"Love Actually","posterPath":null,"date":"2003-09-07","addedAt":0,"rating":9}', (unixepoch() * 1000)),
  (3, 'movie', 4951, 'watchlist', '{"id":4951,"mediaType":"movie","title":"10 bonnes raisons de te larguer","posterPath":null,"date":"1999-03-30","addedAt":0}', (unixepoch() * 1000)),
  (3, 'movie', 18240, 'watchlist', '{"id":18240,"mediaType":"movie","title":"La Proposition","posterPath":null,"date":"2009-06-02","addedAt":0}', (unixepoch() * 1000)),
  (3, 'movie', 50646, 'watched', '{"id":50646,"mediaType":"movie","title":"Crazy, Stupid, Love.","posterPath":null,"date":"2011-07-29","addedAt":0,"rating":8}', (unixepoch() * 1000)),
  (3, 'tv', 1420, 'watched', '{"id":1420,"mediaType":"tv","title":"New Girl","posterPath":null,"date":"2011-09-20","addedAt":0,"rating":7}', (unixepoch() * 1000)),
  (3, 'tv', 1100, 'watched', '{"id":1100,"mediaType":"tv","title":"How I Met Your Mother","posterPath":null,"date":"2005-09-19","addedAt":0,"rating":8}', (unixepoch() * 1000)),
  (3, 'tv', 4586, 'watchlist', '{"id":4586,"mediaType":"tv","title":"Gilmore Girls","posterPath":null,"date":"2000-10-05","addedAt":0}', (unixepoch() * 1000)),
  (3, 'tv', 82596, 'watchlist', '{"id":82596,"mediaType":"tv","title":"Emily in Paris","posterPath":null,"date":"2020-10-02","addedAt":0}', (unixepoch() * 1000)),
  (3, 'tv', 61418, 'watched', '{"id":61418,"mediaType":"tv","title":"Jane the Virgin","posterPath":null,"date":"2014-10-13","addedAt":0,"rating":8}', (unixepoch() * 1000));

-- Listes perso : "Classiques" (Alice, partagée) et "A tester" (Benoit).
INSERT OR IGNORE INTO custom_lists (id, user_id, name, created_at) VALUES
  ('list-demo-classiques', 1, 'Classiques', (unixepoch() * 1000)),
  ('list-demo-a-tester', 2, 'A tester', (unixepoch() * 1000));

-- tmdb_id fait partie de la PK (user_id, list_id, media_type, tmdb_id) : un
-- changement d'item sur une ligne système (ci-dessous, Inception -> Very
-- Bad Trip pour recoller au thème "comédie" de Benoit) passe par un DELETE
-- explicite de l'ancien tmdb_id, sinon l'INSERT OR IGNORE ajouterait une
-- seconde ligne à la même position sur une base déjà provisionnée au lieu
-- de remplacer la première.
DELETE FROM custom_list_items
WHERE user_id = 2 AND list_id = 'list-demo-a-tester' AND media_type = 'movie' AND tmdb_id = 27205;

INSERT OR IGNORE INTO custom_list_items (user_id, list_id, media_type, tmdb_id, data, position) VALUES
  (1, 'list-demo-classiques', 'movie', 603, '{"id":603,"mediaType":"movie","title":"Matrix","posterPath":null}', 0),
  (1, 'list-demo-classiques', 'tv', 1396, '{"id":1396,"mediaType":"tv","title":"Breaking Bad","posterPath":null}', 1),
  (2, 'list-demo-a-tester', 'movie', 18785, '{"id":18785,"mediaType":"movie","title":"Very Bad Trip","posterPath":null}', 0);

INSERT OR IGNORE INTO list_shares (slug, user_id, list_id, created_at)
VALUES ('classiques-demo', 1, 'list-demo-classiques', (unixepoch() * 1000));

-- Benoit suit Alice (profil public, share_slug non NULL — voir migration
-- 0011). Chloé reste sans abonnement ni share_slug, pour tester le cas
-- "profil privé" (sa bibliothèque ci-dessus reste visible d'elle-même,
-- seul le partage public est désactivé).
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
