-- Cache des ThumbHash (voir ticket Trello "ThumbHash affiches") : une
-- empreinte perceptuelle ~20-30 octets par affiche, décodable côté client
-- en une image floue à afficher pendant le chargement de la vraie affiche,
-- au lieu du shimmer gris générique actuel (skeleton.module.css).
--
-- Clé = poster_path seul (pas tmdb_id/media_type) : un même poster_path TMDB
-- identifie la même image quel que soit le titre qui la référence, donc un
-- seul calcul par affiche suffit, réutilisable partout où elle apparaît.
--
-- Rempli uniquement par scripts/generate-thumbhashes.ts, en CI (voir
-- .github/workflows/thumbhash-sync.yml) : décoder un JPEG et calculer le
-- ThumbHash dépasse largement le budget CPU du plan Workers gratuit
-- (10 ms/requête) sur lequel tourne seancy aujourd'hui, donc jamais fait
-- depuis le Worker lui-même (ni à la requête, ni dans un cron).
CREATE TABLE IF NOT EXISTS poster_thumbhashes (
  poster_path TEXT PRIMARY KEY,
  thumbhash TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);
