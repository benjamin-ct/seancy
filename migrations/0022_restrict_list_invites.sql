-- Option de profil "seules les personnes que je suis peuvent m'ajouter à
-- une liste commune" (ticket Trello "Ma liste commune", retour du
-- 2026-10-11 : "il faudrait... bloquer l'ajout à des listes par des
-- personnes que je ne follow pas"). Activée par défaut (1, retouche du
-- 2026-11-28) : seules les personnes qu'on suit peuvent nous ajouter, il faut
-- désactiver le réglage pour ouvrir l'ajout à tous. Les comptes créés ensuite
-- reçoivent aussi 1 explicitement (worker/auth.ts, findOrCreateUser). Vérifiée
-- côté handlePostListMember via follows.isFollowing(memberId, ownerId) — la
-- cible doit suivre la personne qui l'ajoute, pas l'inverse.
ALTER TABLE users ADD COLUMN restrict_list_invites INTEGER NOT NULL DEFAULT 1;
