-- Listes communes (ticket Trello "Ma liste commune") : une liste perso
-- existante (custom_lists) devient collaborative dès qu'elle a au moins un
-- membre en plus de son propriétaire — pas de nouveau type de liste, "les
-- mêmes listes, juste certaines seront personnelles et d'autres
-- collaboratives" (cadrage du 2026-10-10).
--
-- Invitation directe par pseudo, effet immédiat (pas d'acceptation), comme
-- follows (0011) plutôt que list_shares (0010) : ce n'est pas un lien public,
-- c'est le propriétaire qui choisit explicitement qui rejoint.
--
-- Pas de FK vers custom_lists, pour la même raison que list_shares :
-- upsertCustomListForUser/deleteCustomListForUser (et le remplacement complet
-- replaceCustomListsForUser) ne connaissent que le propriétaire, pas ses
-- membres. Une ligne dont la liste a disparu devient simplement une liste
-- introuvable (404) côté API — deleteCustomListForUser nettoie explicitement
-- cette table pour ne pas laisser de ligne orpheline derrière une suppression
-- normale.
CREATE TABLE IF NOT EXISTS list_members (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL,
  member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, list_id, member_id),
  CHECK (member_id <> owner_id)
);
CREATE INDEX IF NOT EXISTS list_members_member_id ON list_members(member_id);
