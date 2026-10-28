-- Compte de démo rejoué sur chaque preview de PR fraîchement provisionnée
-- (voir scripts/preview-d1.ts, provision) : permet de tester manuellement
-- les écrans qui dépendent d'un compte connecté (bibliothèque, profil...)
-- sans repasser par le lien magique à chaque preview. Jeton de session en
-- clair, à poser comme cookie `seancy_session` (voir worker/auth.ts) :
--
--   seancy-preview-demo
--
-- Haché en SHA-256 ci-dessous (sessions.token stocke un hachage, jamais le
-- jeton en clair, voir worker/auth.ts, hashToken). `INSERT OR IGNORE` :
-- sans danger à rejouer (la base de preview n'est provisionnée qu'une fois
-- par PR, mais mieux vaut rester idempotent).

INSERT OR IGNORE INTO users (id, email, created_at, display_name, locale, region)
VALUES (
  1,
  'demo@seancy.test',
  (unixepoch() * 1000),
  'Compte démo',
  'fr',
  'FR'
);

-- Hex SHA-256 de 'seancy-preview-demo'.
INSERT OR IGNORE INTO sessions (token, user_id, expires_at, created_at)
VALUES (
  '0e9773fda07d5085adaed0b01c6e943ae16f0c06a36f25eb54032e7865092c28',
  1,
  (unixepoch() + 31536000) * 1000,
  (unixepoch() * 1000)
);

-- Un titre "vu" et un "envie de voir", pour qu'il y ait quelque chose à
-- voir sur Ma liste / le profil sans dépendre d'une affiche TMDB précise
-- (posterPath à null : repli sur le visuel par défaut, voir MediaCard).
INSERT OR IGNORE INTO library_items (user_id, media_type, tmdb_id, status, data, updated_at)
VALUES (
  1,
  'movie',
  603,
  'watched',
  '{"id":603,"mediaType":"movie","title":"Matrix","posterPath":null,"date":"1999-03-30","addedAt":0}',
  (unixepoch() * 1000)
);

INSERT OR IGNORE INTO library_items (user_id, media_type, tmdb_id, status, data, updated_at)
VALUES (
  1,
  'movie',
  27205,
  'watchlist',
  '{"id":27205,"mediaType":"movie","title":"Inception","posterPath":null,"date":"2010-07-15","addedAt":0}',
  (unixepoch() * 1000)
);
