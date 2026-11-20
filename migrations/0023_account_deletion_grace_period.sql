-- Suppression de compte avec délai de grâce (ticket « Amélioration de la
-- page de profil utilisateur ») : remplace la suppression immédiate (audit
-- M14) par une confirmation par code envoyé par email (même mécanique que
-- le changement d'adresse, voir email_changes) puis un délai de 7 jours
-- avant la suppression effective. Se reconnecter pendant ce délai annule la
-- suppression (voir cancelPendingDeletion, appelé après chaque connexion
-- réussie). NULL = pas de suppression en attente (défaut).
-- Numéro 0023 partagé avec 0023_tickets.sql (comme les deux 0017) : nom gardé
-- tel quel car déjà joué sur la base de preview de la PR ; wrangler suit les
-- migrations par nom de fichier, l'ordre n'a pas d'importance ici.
ALTER TABLE users ADD COLUMN pending_deletion_at INTEGER;

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
