# ssh-keys/

Ce dossier est monté dans le conteneur `seancy-repo` sur `/home/claudeuser/.ssh`, pour lui
permettre de cloner/pousser sur GitHub via SSH.

Il ne doit **jamais** contenir de clé privée versionnée dans git (voir `.gitignore` à la racine
du repo). À générer une seule fois sur le serveur, en dehors de tout commit :

```bash
ssh-keygen -t ed25519 -f id_rsa_theapac -C "<email associé>" -N ""
ssh-keyscan github.com >> known_hosts
```

Puis ajouter la clé publique (`id_rsa_theapac.pub`) comme deploy key (ou clé SSH du compte) côté
GitHub.

Le fichier `config` (celui-ci versionné, il ne contient aucun secret) référence ces deux fichiers
générés localement :

```
Host github.com
    HostName github.com
    User git
    IdentityFile /home/claudeuser/.ssh/id_rsa_theapac
    IdentitiesOnly yes
```
