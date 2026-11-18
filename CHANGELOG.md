# Changelog

Format libre, une entrée par release. Généré automatiquement au merge d'une release (voir .changeset/README.md).

## 0.2.0 — 2026-11-18

### Nouveautés

- Sur la fiche d'une série, vous pouvez maintenant noter chaque épisode vu et chaque saison. La note
  d'une saison devient la moyenne de ses épisodes notés, et celle de la série la moyenne de ses
  saisons, mises à jour aussitôt et synchronisées entre vos appareils. Une note donnée à la main à une
  saison ou à la série revient si vous retirez les notes qui la remplacent.

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.22 — 2026-11-18

### Correctifs

- Quand le navigateur refuse l'activation des notifications push (par exemple Brave, ou un téléphone
  Android sans services Google), Seancy explique maintenant en clair quoi faire au lieu d'afficher
  le message d'erreur technique du navigateur.

## 0.1.21 — 2026-11-18

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.20 — 2026-11-18

### Correctifs

- Correction d'une erreur silencieuse dans le cron de notifications quotidien : un abonnement
  push expiré n'est plus réutilisé pour les vérifications suivantes de la même exécution une fois
  supprimé.

## 0.1.19 — 2026-11-18

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.18 — 2026-11-18

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.17 — 2026-11-17

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.16 — 2026-11-17

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.15 — 2026-11-17

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.14 — 2026-11-17

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.13 — 2026-11-17

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.12 — 2026-11-17

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.11 — 2026-11-17

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.10 — 2026-11-17

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.9 — 2026-11-17

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.8 — 2026-11-17

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.7 — 2026-11-17

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.6 — 2026-11-17

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Les notifications de nouveautés (sorties, nouveaux épisodes) sont de nouveau envoyées : elles ne partaient plus depuis plusieurs jours.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.5 — 2026-11-16

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.4 — 2026-11-16

### Correctifs

- Mises à jour techniques (bibliothèques du site et suivi des erreurs), sans changement visible.

## 0.1.3 — 2026-11-16

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.1.2 — 2026-10-30

### Correctifs

- Applebot ne crawle plus les fiches film/série ni les pages de filmographie : sa charge
  disproportionnée (près de la moitié du trafic réel du site) sature les quotas d'infrastructure
  sans gain d'indexation mesurable, les autres moteurs ne sont pas concernés.

## 0.1.1 — 2026-10-29

### Correctifs

- Réduction du crawl excessif de robots d'indexation sur les fiches film/série : les suggestions
  "Si vous avez aimé..." ne sont plus suivies automatiquement, et le sitemap référence davantage
  de titres pour compenser.

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
