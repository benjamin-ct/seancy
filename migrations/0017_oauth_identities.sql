-- Connexion avec Google / Apple (ticket « Option de connexion »), en plus du
-- lien magique, qui reste toujours disponible : l'adresse email du compte
-- ne change pas, ces identités ne sont que des moyens de connexion
-- supplémentaires rattachés au compte (voir worker/oauth.ts).
--
-- `subject` = identifiant stable du compte chez le fournisseur (claim `sub`
-- de l'id_token), jamais l'email, qui peut changer chez lui. Un seul
-- compte de chaque fournisseur par utilisateur.
CREATE TABLE IF NOT EXISTS auth_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Email renvoyé par le fournisseur à l'association, affiché seulement
  -- dans Profil → Compte pour reconnaître le compte associé.
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identities_user_provider
  ON auth_identities(user_id, provider);

-- Parcours OAuth en cours (10 minutes) : `state` (haché) protège le retour
-- du fournisseur contre la falsification de requête, `code_verifier` (PKCE)
-- et `nonce` lient le code et l'id_token à ce parcours. `user_id` non nul =
-- association depuis un compte déjà connecté, plutôt qu'une connexion.
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT,
  expires_at INTEGER NOT NULL
);
