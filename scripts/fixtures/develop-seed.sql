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

-- Index local de recherche / repli non-IA des algos de reco (voir
-- worker/search-index.ts, worker/recommendations.ts, worker/ai-suggestions.ts) :
-- en prod, cette table n'est alimentée que par le cron Cloudflare quotidien
-- (migration 0018), jamais sur `develop` ni sur les previews de PR (cron
-- actif uniquement sur le déploiement production, voir carte Trello
-- "Alimenter popular_titles sur develop et les previews de PR"). Snapshot
-- figé des 2 premières pages TMDB /movie/popular et /tv/popular (fr-FR) au
-- moment de l'écriture de ce fixture : assez pour tester le repli non-IA et
-- la recherche locale, pas une resynchronisation vivante (ni coût TMDB/D1
-- supplémentaire par preview de PR, contrairement à un cron dédié).
-- `INSERT OR IGNORE` comme le reste de ce fichier : additif, ne réécrase
-- jamais une ligne déjà là.
INSERT OR IGNORE INTO popular_titles
  (tmdb_id, media_type, title, normalized_title, release_date, poster_path, popularity, vote_average, genre_ids, original_language, updated_at)
VALUES
  (969681, 'movie', 'Spider-Man : Brand New Day', 'spider-man : brand new day', '2026-07-29', '/6OEtkkzoyusZDm2uMJojlWZSLR9.jpg', 1284.3495, 8.47, '[878,28,12]', 'en', (unixepoch() * 1000)),
  (687163, 'movie', 'Projet Dernière Chance', 'projet derniere chance', '2026-03-15', '/wzyy8ZrsuHfAt4iz4iH3rT0tdoT.jpg', 1080.0306, 8.636, '[878,12]', 'en', (unixepoch() * 1000)),
  (1003596, 'movie', 'Avengers : Doomsday', 'avengers : doomsday', '2026-12-16', '/cCUxE6EJ9zi1YfdsxU8rWLgqQnN.jpg', 817.934, 0, '[878,28,12]', 'en', (unixepoch() * 1000)),
  (1368337, 'movie', 'L''Odyssée', 'odyssee', '2026-07-15', '/kP8jJIkmX0vWEYiqQ9c5zU0dvcn.jpg', 450.0378, 8.014, '[12,28,14]', 'en', (unixepoch() * 1000)),
  (1058424, 'movie', 'Hope', 'hope', '2026-07-15', '/tGdFDoA9qyt0t6Qr9MFnOl8Z2Jz.jpg', 433.8407, 6.864, '[878,9648,28]', 'ko', (unixepoch() * 1000)),
  (1153576, 'movie', 'Street Fighter', 'street fighter', '2026-10-13', '/k53HHxQ4rQG0dME6nsofii3QNS7.jpg', 298.3684, 6.252, '[28,14]', 'en', (unixepoch() * 1000)),
  (1400837, 'movie', 'Malfaisante', 'malfaisante', '2026-10-07', '/wAofwsldMDNAIzGSEfMJMoUn1KB.jpg', 206.3415, 5.869, '[27]', 'en', (unixepoch() * 1000)),
  (1148365, 'movie', 'Matchbox – Le film', 'matchbox – le film', '2026-10-05', '/vSgnJDw404JUokiy5NDZgXOi01E.jpg', 259.6291, 7.794, '[28,35,12]', 'en', (unixepoch() * 1000)),
  (1291595, 'movie', 'Insidious : L''Invasion du Lointain', 'insidious : l''invasion du lointain', '2026-08-19', '/lGY2oK3D1xET2sDyKezYy6AYR32.jpg', 255.6412, 7.719, '[27,53]', 'en', (unixepoch() * 1000)),
  (1255833, 'movie', 'Englouti', 'englouti', '2026-10-14', '/qLt9F35AdGKDXPSJtqH5DERoigI.jpg', 202.0938, 6.5, '[53]', 'en', (unixepoch() * 1000)),
  (1101412, 'movie', 'Fall 2 : Deadpoint', 'fall 2 : deadpoint', '2026-09-01', '/glySqxnvhTYDmKqM1gFovrYUnQa.jpg', 257.6628, 7.274, '[53]', 'en', (unixepoch() * 1000)),
  (1561726, 'movie', 'Masterplan', 'masterplan', '2026-10-16', '/a13BTR3jJWr2ARoLvTC3f5gQhfw.jpg', 228.4251, 7.055, '[28,53]', 'en', (unixepoch() * 1000)),
  (1281331, 'movie', 'The Social Reckoning', 'social reckoning', '2026-10-07', '/tF1P9HZEBJQ8w1KyBlS3zMS2Ogp.jpg', 142.3928, 6.968, '[18,53]', 'en', (unixepoch() * 1000)),
  (1440050, 'movie', '‎Papa à plein temps', '‎papa a plein temps', '2026-05-29', '/gdzdo1Eph4xeB6SQBgtSsjXFsMM.jpg', 113.3894, 7.049, '[35,10751]', 'en', (unixepoch() * 1000)),
  (1284186, 'movie', 'Sacrifice', 'sacrifice', '2026-04-09', '/rjxBLWp9zeu5ls6Y9h7JwretMoQ.jpg', 153.5169, 5.097, '[12,35,28]', 'en', (unixepoch() * 1000)),
  (1228834, 'movie', 'The Fix', 'fix', '2026-09-10', '/jlP8XDjZN89GrpM3je5Uf8Grqx8.jpg', 188.1609, 6.549, '[28,53]', 'en', (unixepoch() * 1000)),
  (1248832, 'movie', 'Digger', 'digger', '2026-09-28', '/gPCCGMQCrrMNM3mR3vqIdbdJxJ5.jpg', 150.4584, 7.474, '[35,18]', 'en', (unixepoch() * 1000)),
  (1400940, 'movie', 'Clayface', 'clayface', '2026-10-19', '/5RzUMLAYw2xHsd98UKcMC9s0ZQ.jpg', 192.4303, 7.3, '[27,53,878]', 'en', (unixepoch() * 1000)),
  (1236045, 'movie', 'Animals', 'animals', '2026-10-09', '/33MhDOKB0S5VwuaD9lZyV0v0st0.jpg', 178.5958, 6.998, '[53,18]', 'en', (unixepoch() * 1000)),
  (1423191, 'movie', 'Resident Evil', 'resident evil', '2026-09-16', '/pICoWjcKSet6sA3yzxOkP8ChwYI.jpg', 171.0037, 7.296, '[27,878,12]', 'en', (unixepoch() * 1000)),
  (1377237, 'movie', 'Runner', 'runner', '2026-09-07', '/6DQkNOhW7p9PwxWTDuZy8tnXozK.jpg', 161.2283, 8.337, '[28,35]', 'en', (unixepoch() * 1000)),
  (1170608, 'movie', 'Dune : Troisième partie', 'dune : troisieme partie', '2026-12-15', '/zfI58QKzav88liXLsk0lvFSMCdr.jpg', 122.6492, 0, '[878,12]', 'en', (unixepoch() * 1000)),
  (1765072, 'movie', 'You Can See Everything', 'you can see everything', '2026-10-16', '/7nG1AFxnrh5KtgH3jA4uIsWmX95.jpg', 144.2124, 8.9, '[99]', 'en', (unixepoch() * 1000)),
  (1712451, 'movie', 'Resident Dead', 'resident dead', '2026-09-04', '/qKhMVWwFikSUzOpkhOl35GBLkGH.jpg', 154.2498, 6.318, '[27]', 'en', (unixepoch() * 1000)),
  (1302904, 'movie', 'Les Ensorceleuses 2', 'ensorceleuses 2', '2026-09-09', '/qU6bErj56ebypPwA7zaiTfKzemA.jpg', 152.3863, 7.053, '[10749,14,35]', 'en', (unixepoch() * 1000)),
  (1503762, 'movie', 'Raison et Sentiments', 'raison et sentiments', '2026-09-23', '/9XNEI2AYgQIIqXper5kOdGTnyf5.jpg', 124.2394, 7.4, '[18,10749]', 'en', (unixepoch() * 1000)),
  (1514026, 'movie', 'Buddy', 'buddy', '2026-08-27', '/lfdInOrdyTGXOuFBOLefamy6AgI.jpg', 155.5864, 7.128, '[27,35,14]', 'en', (unixepoch() * 1000)),
  (1375161, 'movie', 'Don''t Move', 'don''t move', '2026-09-11', '/uh0ZSdM8iOQgHwnUlhhanP8Dkl6.jpg', 130.2208, 5.321, '[27,53]', 'en', (unixepoch() * 1000)),
  (1084244, 'movie', 'Toy Story 5', 'toy story 5', '2026-06-17', '/5eqxQzAxennEKBAg147LUX4gVlS.jpg', 129.1428, 8.281, '[16,10751,35,12]', 'en', (unixepoch() * 1000)),
  (1294189, 'movie', 'The Mongoose', 'mongoose', '2026-10-29', '/eSS5mvSG84UUuvtbHel5Yu3Wik4.jpg', 122.5544, 0, '[28,53]', 'en', (unixepoch() * 1000)),
  (1232569, 'movie', 'Pinocchio : Déchaîné', 'pinocchio : dechaine', '2026-07-22', '/oru4SubtHlaGXEv9xtMPELYkGZf.jpg', 129.3748, 6.5, '[27,14,9648]', 'en', (unixepoch() * 1000)),
  (15196, 'movie', 'Cluedo', 'cluedo', '1985-12-13', '/o5mjpz2Mvx4v5vUEVdWclBurxuc.jpg', 73.6212, 7.217, '[35,80,9648]', 'en', (unixepoch() * 1000)),
  (1234139, 'movie', 'ஜெயிலர் 2', 'ஜெயிலர் 2', '2026-10-14', '/upwdEyhhYZ7pT2hD535fr2MGfpx.jpg', 99.6765, 8, '[28,35]', 'ta', (unixepoch() * 1000)),
  (1147572, 'movie', 'Narnia : Le neveu du magicien', 'narnia : le neveu du magicien', '2027-02-10', '/mnxWVLtpdHfkq3GblvaOoAnMkgZ.jpg', 105.2572, 0, '[14,12,10751]', 'en', (unixepoch() * 1000)),
  (1275779, 'movie', 'Disclosure Day', 'disclosure day', '2026-06-10', '/8GRMeKaDFnuzXBzqGiDMzCFDnwQ.jpg', 113.2009, 7.446, '[878,53]', 'en', (unixepoch() * 1000)),
  (1101383, 'movie', 'La Fin d''Oak Street', 'la fin d''oak street', '2026-08-12', '/yZINaQysj32K2DS2EW4Iy1bK4Bm.jpg', 101.9244, 7.084, '[878,9648,53]', 'en', (unixepoch() * 1000)),
  (1288069, 'movie', 'Tenzing : à la conquête de l’Everest', 'tenzing : a la conquete de l’everest', '2026-10-09', '/hKA6G4Dj0Uonghi6AUwmpIvCFo0.jpg', 109.6476, 8.4, '[18,36]', 'en', (unixepoch() * 1000)),
  (1339274, 'movie', 'No dejes a los niños solos', 'no dejes a los ninos solos', '2026-05-14', '/w01yTCLE2nCSj8IMxUjrc8vIwQ9.jpg', 100.132, 6.81, '[27,18,53]', 'es', (unixepoch() * 1000)),
  (1339713, 'movie', 'Obsession', 'obsession', '2026-05-13', '/mDCR1frpUvGfIKksuM440VLb7X9.jpg', 104.8298, 8.173, '[27,53]', 'en', (unixepoch() * 1000)),
  (460458, 'movie', 'Resident Evil : Bienvenue à Raccoon City', 'resident evil : bienvenue a raccoon city', '2021-11-24', '/huY3JAjrLdAOv6lq3m8kcTNJs8r.jpg', 97.6072, 5.945, '[28,27,878]', 'en', (unixepoch() * 1000)),
  (1396, 'tv', 'Breaking Bad', 'breaking bad', '2008-01-20', '/hVVxgGZFR3JaXmkstnG1IR9Qbt6.jpg', 1860.4866, 8.957, '[18,80]', 'en', (unixepoch() * 1000)),
  (41956, 'tv', 'Meurtres au paradis', 'meurtres au paradis', '2011-10-25', '/w5PFi8rrlThovLhupFEs5hCCqG4.jpg', 2884.4432, 7.5, '[35,80,18,9648]', 'en', (unixepoch() * 1000)),
  (83631, 'tv', 'What We Do in the Shadows', 'what we do in the shadows', '2019-03-27', '/wa3ZQE9kLnqwN3vQ0NNjg1NPsCa.jpg', 2082.2625, 7.999, '[35,10765]', 'en', (unixepoch() * 1000)),
  (549, 'tv', 'New York Police Judiciaire', 'new york police judiciaire', '1990-09-13', '/7ZFSCSIuW8wzXJL1JezrKcLzV4x.jpg', 1482.7516, 7.289, '[80,18]', 'en', (unixepoch() * 1000)),
  (136315, 'tv', 'The Bear', 'bear', '2022-06-23', '/iaJfffjCqXATU5msr4PAgOWLMl4.jpg', 1064.7589, 8.157, '[18,35]', 'en', (unixepoch() * 1000)),
  (2190, 'tv', 'South Park', 'south park', '1997-08-13', '/fgRCZiN3igJqtIAXrBm9S7BwLVp.jpg', 1544.6388, 8.3, '[35,16]', 'en', (unixepoch() * 1000)),
  (15325, 'tv', 'Dagsrevyen', 'dagsrevyen', '1958-12-02', '/5wGSp6VaXG406ZbgQoJizPKUE79.jpg', 670.1499, 8, '[]', 'no', (unixepoch() * 1000)),
  (1480, 'tv', 'Ally McBeal', 'ally mcbeal', '1997-09-08', '/weS8htxS2j0EQ6jorK3WOR1dZpH.jpg', 539.3453, 6.5, '[18,35]', 'en', (unixepoch() * 1000)),
  (22980, 'tv', 'Watch What Happens Live with Andy Cohen', 'watch what happens live with andy cohen', '2009-07-16', '/onSD9UXfJwrMXWhq7UY7hGF2S1h.jpg', 634.6469, 4.9, '[10767,35]', 'en', (unixepoch() * 1000)),
  (91759, 'tv', 'Come Home Love: Lo and Behold', 'come home love: lo and behold', '2017-02-20', '/lgD4j9gUGmMckZpWWRJjorWqGVT.jpg', 661.5724, 5.4, '[10751,35,18]', 'cn', (unixepoch() * 1000)),
  (18053, 'tv', 'Nurse Jackie', 'nurse jackie', '2009-06-08', '/efKrmVB9Jwmh6HxFjED6FyeOUpW.jpg', 247.4832, 7.094, '[18,35]', 'en', (unixepoch() * 1000)),
  (424, 'tv', 'Torchwood', 'torchwood', '2006-10-22', '/hbMHUru1AB09ROhHZBKFU3upgXX.jpg', 291.1574, 7.3, '[10765,10759,18]', 'en', (unixepoch() * 1000)),
  (2734, 'tv', 'New York Unité Spéciale', 'new york unite speciale', '1999-09-20', '/95flTYCxEPNFSdZVrHy9nMIeLbw.jpg', 426.3438, 7.961, '[80,18,9648]', 'en', (unixepoch() * 1000)),
  (2261, 'tv', 'The Tonight Show avec Johnny Carson', 'tonight show avec johnny carson', '1962-10-01', '/uSvET5YUvHNDIeoCpErrbSmasFb.jpg', 429.8418, 7.562, '[10767]', 'en', (unixepoch() * 1000)),
  (59941, 'tv', 'Le Tonight Show', 'tonight show', '2014-02-17', '/1g9k0mSogSkkC7aRZlrTvGYMudE.jpg', 404.5309, 5.789, '[35,10767]', 'en', (unixepoch() * 1000)),
  (213375, 'tv', 'VisionQuest', 'visionquest', '2026-10-13', '/bWPktguPGslrdM79SNQt4OWYyJS.jpg', 391.2253, 8.821, '[10765,18]', 'en', (unixepoch() * 1000)),
  (33238, 'tv', 'Running Man', 'running man', '2010-07-11', '/15SMnscZqd7HZ0bzruatOcKUlOV.jpg', 408.1234, 8.2, '[35,10764]', 'ko', (unixepoch() * 1000)),
  (2398, 'tv', 'Girlfriends', 'girlfriends', '2000-09-11', '/buFnsyWEg4pPR7dco5Vbsm6HCIY.jpg', 230.9315, 7.3, '[18,35]', 'en', (unixepoch() * 1000)),
  (4614, 'tv', 'NCIS : Enquêtes Spéciales', 'ncis : enquetes speciales', '2003-09-23', '/salC1Yhi3QW8DW5iIJGFQOzPWVQ.jpg', 367.4095, 7.6, '[80,18,10759]', 'en', (unixepoch() * 1000)),
  (63770, 'tv', 'The Late Show with Stephen Colbert', 'late show with stephen colbert', '2015-09-08', '/9jkThAGYj2yp8jsS6Nriy5mzKFT.jpg', 353.6402, 6.103, '[35,10767]', 'en', (unixepoch() * 1000)),
  (108978, 'tv', 'Reacher', 'reacher', '2022-02-03', '/qrJOCIAcvPmyZ63KajWTalQtqPT.jpg', 344.3295, 8.131, '[10759,80]', 'en', (unixepoch() * 1000)),
  (65733, 'tv', 'Doraemon', 'doraemon', '2005-04-22', '/9YqdMXlPTQGLIG67vqZdsPdPC4T.jpg', 340.8075, 8.1, '[10759,16,35,10765,10762,10751]', 'ja', (unixepoch() * 1000)),
  (1416, 'tv', 'Grey''s Anatomy', 'grey''s anatomy', '2005-03-27', '/meLc14IucQOzlqRn3ERCWjt5BEC.jpg', 337.2245, 8.205, '[18]', 'en', (unixepoch() * 1000)),
  (5920, 'tv', 'Mentalist', 'mentalist', '2008-09-23', '/dGRoQRWjGac97wqp6WuLnRsZDpc.jpg', 354.1675, 8.418, '[80,18,9648]', 'en', (unixepoch() * 1000)),
  (94722, 'tv', 'Tagesschau', 'tagesschau', '1952-12-26', '/7dFZJ2ZJJdcmkp05B9NWlqTJ5tq.jpg', 393.0009, 6.8, '[10763]', 'de', (unixepoch() * 1000)),
  (456, 'tv', 'Les Simpson', 'simpson', '1989-12-17', '/py1CAYqgpKKtLBdtctLIXfDYDjW.jpg', 363.2684, 8.026, '[16,35]', 'en', (unixepoch() * 1000)),
  (61818, 'tv', 'Late Night with Seth Meyers', 'late night with seth meyers', '2014-02-25', '/u0ttHM5ZQCvnfL0lkueEgS4h2nI.jpg', 319.638, 5.1, '[10767,35]', 'en', (unixepoch() * 1000)),
  (15226, 'tv', 'C.I.D.', 'c.i.d.', '1998-01-21', '/60ZxbAMk6QO8jMD0p8WrGHVCbyK.jpg', 333.0573, 5.75, '[10759,80,18,9648]', 'hi', (unixepoch() * 1000)),
  (1434, 'tv', 'Les Griffin', 'griffin', '1999-01-31', '/7nHl3OHUSTHgslQxJUzNSy9vxqo.jpg', 314.9582, 7.408, '[16,35]', 'en', (unixepoch() * 1000)),
  (2224, 'tv', 'Le Daily Show', 'daily show', '1996-07-22', '/np5l5SGS990ZV6FcP9CCRPq3hSe.jpg', 305.0622, 6.422, '[10763,35]', 'en', (unixepoch() * 1000)),
  (1622, 'tv', 'Supernatural', 'supernatural', '2005-09-13', '/iBR4U3MZelj5avBqqs1SJpIqArP.jpg', 297.7451, 8.3, '[18,9648,10765]', 'en', (unixepoch() * 1000)),
  (206559, 'tv', 'Binnelanders', 'binnelanders', '2005-10-13', '/3bzECfllho8PphdYujLUIuhncJD.jpg', 275.1155, 5.5, '[10766]', 'af', (unixepoch() * 1000)),
  (14424, 'tv', 'Malhação', 'malhacao', '1995-04-24', '/bF24r2FxsjzgkJcrbBU8RC9JVoU.jpg', 286.0234, 6.3, '[10766,35,18]', 'pt', (unixepoch() * 1000)),
  (4057, 'tv', 'Esprits criminels', 'esprits criminels', '2005-09-22', '/kRgsJq9dMz7bIciUEqwbmzFBwSL.jpg', 251.859, 8.3, '[80,18,9648]', 'en', (unixepoch() * 1000)),
  (72879, 'tv', 'Demain nous appartient', 'demain nous appartient', '2017-07-17', '/7BjipkA48xXLauTg45QKiOb144a.jpg', 267.6587, 6.3, '[80,18,10766]', 'fr', (unixepoch() * 1000)),
  (1431, 'tv', 'Les Experts', 'experts', '2000-10-06', '/fx304X0L9dykk0yZixBfhUDqH53.jpg', 256.5439, 7.607, '[80,18,9648]', 'en', (unixepoch() * 1000)),
  (2661, 'tv', 'Kamen Rider', 'kamen rider', '1971-04-03', '/fIJNVBa6MJStPiOvhLV69nAdu0e.jpg', 243.9334, 6.44, '[10759,10765,18]', 'ja', (unixepoch() * 1000)),
  (247718, 'tv', 'MobLand', 'mobland', '2025-03-30', '/fs1GCzfveWH8A8xG7UunUYNmQPP.jpg', 245.782, 8.531, '[80,18]', 'en', (unixepoch() * 1000)),
  (1433, 'tv', 'American Dad!', 'american dad!', '2005-02-06', '/eb9sH2am9IUSQ8GhXTNAVoujk8W.jpg', 248.1725, 7.019, '[16,35]', 'en', (unixepoch() * 1000)),
  (288673, 'tv', 'Carrie', 'carrie', '2026-10-07', '/dkDeQSeJGSfEBFavomS3LUci2VO.jpg', 227.9206, 8.328, '[9648,18,10765]', 'en', (unixepoch() * 1000));
