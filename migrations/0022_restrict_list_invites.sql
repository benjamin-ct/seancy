-- Option de profil "seules les personnes que je suis peuvent m'ajouter à
-- une liste commune" (ticket Trello "Ma liste commune", retour du
-- 2026-10-11 : "il faudrait... bloquer l'ajout à des listes par des
-- personnes que je ne follow pas"). Désactivée par défaut (0) : l'ajout par
-- pseudo reste ouvert à tous comme avant ce ticket. Vérifiée côté
-- handlePostListMember via follows.isFollowing(memberId, ownerId) — la
-- cible doit suivre la personne qui l'ajoute, pas l'inverse.
ALTER TABLE users ADD COLUMN restrict_list_invites INTEGER NOT NULL DEFAULT 0;
