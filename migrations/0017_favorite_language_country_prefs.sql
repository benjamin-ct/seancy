-- Langues et pays favoris synchronisés par compte, même principe que les
-- plateformes favorites (migration 0004) : pré-réglage réutilisable dans les
-- filtres de Nouveautés/Prochainement au lieu de resélectionner une langue/
-- un pays unique à chaque visite (voir FavoriteLanguagesContext /
-- FavoriteCountriesContext).
CREATE TABLE IF NOT EXISTS favorite_language_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  PRIMARY KEY (user_id, language_code)
);

CREATE TABLE IF NOT EXISTS favorite_country_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL,
  PRIMARY KEY (user_id, country_code)
);
