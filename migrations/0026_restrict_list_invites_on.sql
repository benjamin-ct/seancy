-- Restriction des listes communes active pour tous les comptes existants
-- (retouche du 2026-11-28 : « seules les personnes que je suis peuvent
-- m'ajouter » activé par défaut). 0022_restrict_list_invites crée maintenant
-- la colonne à 1, mais la base de preview de la PR l'avait déjà appliquée avec
-- l'ancien défaut (0) : cette mise à jour aligne les comptes déjà créés. Sans
-- effet ailleurs, où 0022 vient d'être appliquée avec DEFAULT 1 (le réglage
-- n'a encore jamais pu être modifié).
UPDATE users SET restrict_list_invites = 1;
