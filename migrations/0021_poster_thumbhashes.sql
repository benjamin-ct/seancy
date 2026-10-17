-- Cache des ThumbHash (voir ticket Trello "ThumbHash affiches") : une
-- empreinte perceptuelle ~20-30 octets par affiche, décodable côté client
-- en une image floue à afficher pendant le chargement de la vraie affiche,
-- au lieu du shimmer gris générique actuel (skeleton.module.css).
--
-- Clé = poster_path seul (pas tmdb_id/media_type) : un même poster_path TMDB
-- identifie la même image quel que soit le titre qui la référence, donc un
-- seul calcul par affiche suffit, réutilisable partout où elle apparaît.
--
-- Rempli par deux voies : le batch quotidien scripts/generate-thumbhashes.ts
-- en CI (voir .github/workflows/thumbhash-sync.yml, décodage via `sharp`,
-- réservé au CI car `sharp` dépend de bindings natifs indisponibles dans le
-- runtime Workers), et depuis le Worker lui-même en fire-and-forget
-- (`ctx.waitUntil`, voir worker/images/posterThumbhash.ts) pour les affiches
-- pas encore connues de ce batch (ex. nouvelle entrée dans `popular_titles`
-- avant le prochain run) — décodage WASM pur (`@jsquash/*`) dans ce second
-- cas, jamais `sharp`.
CREATE TABLE IF NOT EXISTS poster_thumbhashes (
  poster_path TEXT PRIMARY KEY,
  thumbhash TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);
