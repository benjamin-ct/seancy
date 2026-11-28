# Changelog

Format libre, une entrée par release. Généré automatiquement au merge d'une release (voir .changeset/README.md).

## 0.3.1 — 2026-11-28

### Correctifs

- Espace admin : au rechargement d'une page, l'onglet affiche directement l'icône et le titre de l'admin, sans montrer d'abord ceux du site.
- Un clic sur une notification ouvre directement la page concernée, même quand l'application est déjà ouverte : elle ne reste plus sur la page où elle était.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.3.0 — 2026-11-27

### Nouveautés

- Vous pouvez désormais laisser un avis texte sur les titres que vous avez vus : il apparaît
  dans un onglet « Avis » de votre profil partagé et auprès des profils qui vous suivent. La
  suppression de compte demande maintenant une confirmation par email et laisse 7 jours avant
  la suppression effective, annulable à tout moment en vous reconnectant ; pendant ce délai,
  votre profil n'est plus visible des autres membres.
- Sur la fiche d'une série, touchez le titre d'un épisode pour lire son résumé, avec sa durée et sa
  note TMDB quand elles sont connues. Le détail reste replié par défaut pour ne rien dévoiler.
- Accueil : une fois connecté, le défilement ne s'arrête plus après la sélection « Pour toi ». Il continue avec des titres de tes genres préférés, sans tes genres écartés ni les titres déjà vus, dans ta liste ou écartés, et chacun garde le bouton « je ne veux pas voir ». Au rechargement de la page, les titres populaires ne s'affichent plus un instant avant ta sélection.
- Nouvelle rubrique « Suggestions » dans les réglages : proposez une fonctionnalité, une amélioration ou signalez un problème directement depuis l'application. Les suggestions sont envoyées de façon anonyme à l'équipe de Seancy.
- Page Tickets de l'espace admin : une idée, un ticket à faire ou un ticket fait peut être archivé. Il sort du tableau sans être supprimé et se retrouve avec la recherche.
- Page Tickets de l'espace admin : un bouton « Archivés » montre les cartes archivées (avec leur nombre), rangées dans leur colonne, pour les retrouver sans passer par la recherche.
- Page Tickets de l'espace admin : les suggestions des utilisateurs arrivent dans leur propre colonne « Suggestions », à part des idées de l'équipe. Elles se gardent en idée, deviennent un ticket ou s'archivent.

### Correctifs

- Sur le site de développement, le bouton « Ouvrir l'espace admin » du profil (et le lien Admin de la barre du haut) mène à l'espace admin du site de développement, et non plus à celui de la prod.
- Espace admin : quand la session Cloudflare Access a expiré, la page renvoie vers la connexion au lieu de rester bloquée sur « Serveur injoignable », et l'écran d'erreur propose un bouton « Réessayer ».
- Le lien vers le site de développement et son logo bleu utilisent maintenant la bonne adresse (seancy-develop.creusatbenjamin.workers.dev).
- Sur téléphone, le lien vers le site de développement est maintenant dans l'onglet Outils de l'espace admin.
- L'espace admin propose un lien vers le site de développement, dont le logo est désormais bleu.
- Les notifications ne se répètent plus : un titre déjà signalé comme disponible en streaming n'est
  plus renotifié les jours suivants, et une même sortie ne donne plus qu'une notification, même
  quand elle est à la fois dans vos genres préférés et dans les tendances.
- Le site de développement se distingue mieux de la prod : favicon et icône d'écran d'accueil au ticket bleu, appli installée nommée « Seancy Dev » et titre d'onglet précédé de « [Dev] ».
- Textes français plus soignés : les guillemets « » et les signes « ? ! : ; » ne se retrouvent plus seuls en bout de ligne, « e-mail » s'écrit partout de la même façon, « 1 épisode » n'est plus affiché « 1 épisodes » sur une fiche de série, et quelques formulations incohérentes sont harmonisées.
- Corrige une erreur ponctuelle de chargement des films actuellement au cinéma ou bientôt en salle, provoquée par un trop-plein de requêtes vers notre fournisseur de données.
- Sur la page Tickets, les boutons arrondis d'un ticket (Preview, PR, Partager…) sont mieux alignés : même hauteur, texte et icône centrés avec un espacement régulier.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.2.4 — 2026-11-19

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- L'icône Réglages est maintenant un vrai engrenage (elle ressemblait à un soleil).
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.2.3 — 2026-11-19

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.2.2 — 2026-11-18

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

## 0.2.1 — 2026-11-18

### Correctifs

- Améliorations internes de l'outillage de développement, sans changement visible sur le site.
- Améliorations internes de l'outillage de développement, sans changement visible sur le site.

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
