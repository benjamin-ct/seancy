# Changelog

Format libre, une entrée par release. Généré automatiquement au merge d'une release (voir .changeset/README.md).

## 0.1.0 — 2026-10-23

### Nouveautés

- Ajout d'une page « Changelog » publique, accessible depuis le pied de page, listant les releases du site.
- La section « Pour vous ce soir » de Découvrir propose désormais 10 suggestions personnalisées générées par IA (historique de visionnage, genres exclus, titres ignorés), avec repli automatique sur l'algorithme existant en cas de quota ou d'erreur.

### Correctifs

- Corrige « Pour vous ce soir » : une génération qui échoue (par exemple le binding Workers AI absent sur les environnements de prévisualisation des pull requests) bascule maintenant proprement sur le repli au lieu de planter, et le message « Pas encore de suggestions » n'affirme plus à tort que le profil n'a pas assez de films/séries notés.
- Corrige une erreur serveur qui pouvait empêcher la sauvegarde de la bibliothèque (vu, envie de voir, listes, genres exclus, plateformes favorites) sur les environnements de prévisualisation des pull requests.
- Corrige le calcul de ThumbHash à la demande pour les affiches dont la source TMDB est nativement en PNG (il échouait auparavant, puis était simplement ignoré) : l'affiche est maintenant décodée dans son vrai format au lieu de supposer du JPEG.
- Le chargement de « Pour vous ce soir » (en tête de Découvrir) affiche maintenant un vrai squelette animé (effet de balayage, comme sur les fiches détail et les grilles) à la place d'un bloc plat qui pulsait en opacité.

## v0 — 2026-10-11

Entrée rédigée à la main (pas générée par l'automatisation release, qui démarre à partir de
cette version) : résumé des grandes fonctionnalités déjà en place avant la mise en place du
changelog par release, pour que cette page ne démarre pas vide.

### Nouveautés

- Catalogue : parcourir et filtrer films/séries (genres, plateformes de streaming, pays, langue, année, note), nouveautés récentes et sorties à venir.
- Fiches détail : casting, bande-annonce, disponibilité en streaming/location/achat selon la région, titres similaires.
- « La roue de la séance » : tirage aléatoire dans le catalogue ou dans ses envies de voir.
- Recherche de films, séries, acteurs et réalisateurs.
- Compte : connexion par lien magique, Google ou Apple ; profil public partageable.
- Bibliothèque personnelle : envies de voir, déjà vu, listes personnalisées, recommandations « Pour toi ».
- Notifications push pour les sorties suivies.
- Application installable (PWA).
