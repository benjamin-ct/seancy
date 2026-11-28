-- Fiches TMDB des titres de la bibliothèque et des listes perso (voir
-- worker/title-metadata.ts, ticket « Réhydrater la bibliothèque depuis
-- TMDB ») : à l'écriture, le titre, l'affiche et les genres envoyés par le
-- client sont remplacés par ceux de TMDB, et un identifiant inconnu de TMDB
-- est écarté. Partagée entre comptes, comme `tmdb_title_labels` (migration
-- 0022) : une fiche TMDB n'a rien de personnel, elle ne part donc pas avec
-- un compte supprimé.
--
-- Une ligne par langue de l'app (`fr-FR`, `en-US`) : le titre et l'affiche
-- dépendent de la langue. `found` = 0 garde aussi les 404 de TMDB, pour
-- qu'un identifiant inexistant renvoyé en boucle ne coûte pas un appel à
-- chaque écriture. `genre_ids` : tableau JSON d'ids de genres TMDB.
-- `fetched_at` sert à relire une fiche au bout d'un mois (un 404 dès le
-- lendemain), quand une écriture la touche.
CREATE TABLE IF NOT EXISTS tmdb_titles (
  media_type TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  language TEXT NOT NULL,
  found INTEGER NOT NULL,
  title TEXT,
  poster_path TEXT,
  genre_ids TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (media_type, tmdb_id, language)
);
