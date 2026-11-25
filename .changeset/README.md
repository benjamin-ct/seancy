# Fragments de changelog

Chaque PR qui modifie du code produit (`src/`, `worker/` ou `migrations/`) ajoute ici un
fichier `<slug>.md` décrivant le changement pour le changelog public. Les fragments sont
compilés en `CHANGELOG.md` + bump de version au moment de la release `develop` → `main` (voir
ticket Trello "Épique git-flow : release develop→main automatisée").

Les PR purement infra/outillage/doc (aucun fichier sous `src/`, `worker/` ou `migrations/`)
n'ont rien à ajouter ici : la CI ne le demande que si le diff touche l'un de ces dossiers.

## Format

```md
---
bump: patch
---

Description courte, au présent, destinée aux utilisateurs du site (pas un résumé technique de
la PR). Un paragraphe suffit.
```

`bump` vaut `patch`, `minor` ou `major` :

- `patch` : correctif, pas de nouveau comportement visible (`fix`, `perf`, `chore`...).
- `minor` : nouvelle fonctionnalité ou amélioration visible, rétrocompatible (`feat`).
- `major` : changement cassant pour un usage existant (suppression/changement de comportement
  qu'un utilisateur pourrait remarquer négativement).

Nom de fichier libre (ex. `filtre-en-salle.md`), tant qu'il est unique dans ce dossier — il est
supprimé après compilation à la release, donc aucune convention de nommage à retenir sur la
durée.
