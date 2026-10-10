---
name: sentry-triage
description: Traite une alerte Sentry reçue par le webhook de infra/trello-claude/listener/server.js (endpoint /sentry-webhook). Récupère le détail complet de l'issue via l'API Sentry, évalue sa sévérité et sa pertinence, puis décide d'ignorer, de corriger directement (PR), ou de créer un ticket Trello dans "A faire" si une décision humaine est nécessaire. Utilise ce skill dès qu'un prompt fournit un payload brut de webhook Sentry à traiter — jamais pour du travail Trello classique (voir trello-ticket-pipeline pour ça).
---

# Triage automatique des alertes Sentry

Ce skill traite une alerte Sentry unique, reçue via le webhook `/sentry-webhook` du listener
(`infra/trello-claude/listener/server.js`). Il s'exécute dans le même conteneur `seancy-repo` que
le skill `trello-ticket-pipeline`, dans un processus `claude -p` one-shot : mêmes contraintes
(pas de reprise automatique après la sortie, pas de délégation d'attente à un sous-agent,
notification Discord finale obligatoire).

## Ce que reçoit ce skill

Le prompt qui déclenche ce skill contient le payload JSON brut envoyé par la règle d'alerte
Sentry ("Send a notification via a webhook"). Ce payload peut prendre plusieurs formes selon la
configuration Sentry (issue alert classique vs intégration interne) — ne pas supposer un schéma
strict. Chercher dans l'ordre un identifiant ou une URL d'issue exploitable :
`data.issue.id` / `data.issue.web_url`, `data.event.issue_id`, ou tout champ `url`/`web_url`
présent. Si aucun identifiant exploitable n'est trouvable dans le payload, arrêter le traitement,
poster un résumé Discord expliquant que le payload n'a pas pu être interprété (en citant sa
forme brute), et terminer — ne jamais deviner un ID d'issue.

## Configuration requise

- `SENTRY_AUTH_TOKEN` (scope minimal `event:read`) : obligatoire pour lire le détail d'une issue.
- `SENTRY_ORG_SLUG` : slug de l'organisation Sentry.
- `SENTRY_PROJECT_SLUG` : slug du projet Sentry (si le payload ne le fournit pas déjà).

Si `SENTRY_AUTH_TOKEN` est absent de l'environnement, ne pas tenter d'appeler l'API Sentry :
poster directement un résumé Discord signalant l'alerte reçue (titre/lien tels que présents dans
le payload brut, sans détail enrichi) et l'absence de credential empêchant l'enrichissement, puis
terminer.

## Étapes

1. **Récupérer le détail complet de l'issue** via l'API Sentry
   (`GET https://sentry.io/api/0/organizations/{org_slug}/issues/{issue_id}/`, header
   `Authorization: Bearer $SENTRY_AUTH_TOKEN`) : titre, culprit, niveau (`level`), nombre
   d'occurrences, première/dernière occurrence, stacktrace du dernier événement
   (`.../issues/{issue_id}/events/latest/`), tags pertinents (environnement, release).
2. **Chercher du contexte additionnel si utile** : issues similaires ou déjà connues sur le même
   projet (`GET .../issues/?query=...`), historique de résolution si l'issue a déjà été vue.
3. **Évaluer la pertinence et la sévérité** :
   - Bruit attendu / non actionnable (ex. erreurs connues liées au cycle de vie normal des
     bases de preview, timeouts réseau ponctuels sans pattern) : ignorer sans action Sentry
     destructive — ne pas résoudre automatiquement une issue sans être certain qu'elle est
     inoffensive, se contenter de ne pas agir dessus si le doute persiste.
   - Bug réel, cause claire, correctif simple et bien délimité : passer à l'étape 4a.
   - Cause ambiguë, correctif risqué/structurant, ou nécessitant une décision produit : passer à
     l'étape 4b.
4. **Agir** :
   - **4a. Corriger directement** : suivre exactement le flux de développement du skill
     `trello-ticket-pipeline` (étape 2c) — créer une branche nommée clairement
     (`fix/<description-courte>`), corriger, committer, ouvrir une PR avec un lien vers l'issue
     Sentry en description. Ne pas créer de carte Trello dans ce cas (la PR suffit ; un humain la
     review normalement via GitHub). Commenter sur l'issue Sentry (`POST
.../issues/{issue_id}/comments/`) avec un lien vers la PR ouverte.
   - **4b. Créer un ticket Trello** : ajouter une carte dans la liste "A faire" du board Bobine,
     avec un titre clair et une description reprenant le lien de l'issue Sentry, le résumé du
     problème, les hypothèses envisagées et pourquoi une décision humaine est nécessaire. Cette
     carte entre alors dans le pipeline normal de `trello-ticket-pipeline` lors d'une prochaine
     exécution. Commenter sur l'issue Sentry avec un lien vers la carte créée.
   - Dans les deux cas 4a/4b, ne jamais résoudre (`status: resolved`) l'issue Sentry tant que le
     correctif n'est pas mergé — un simple commentaire de suivi suffit à ce stade.
5. **Notifier Discord** (obligatoire, avant de terminer) : résumé de l'alerte traitée (titre,
   lien Sentry), sévérité estimée, action prise (ignorée / PR ouverte avec lien / carte Trello
   créée avec lien), en suivant le même format REST Discord que `trello-ticket-pipeline`
   (`DISCORD_TOKEN` / `DISCORD_CHANNEL_ID`).

## Règles d'or (reprises de trello-ticket-pipeline)

- Ne jamais quitter en disant qu'un sous-agent ou une notification reprendra la main plus tard.
- Toujours envoyer le résumé Discord avant de terminer, même en cas d'échec ou d'ambiguïté.
- Tous les commentaires postés sur Trello ou sur l'issue Sentry par ce skill sont préfixés par
  `🤖 [Claude]`.
- En cas d'incertitude sur l'architecture ou les credentials disponibles, ne pas deviner : décrire
  précisément le blocage dans le résumé Discord plutôt que d'agir à l'aveugle.
- Si une action humaine est nécessaire sur le serveur (NAS), citer les commandes `seancy-*`
  (`seancy-status`, `seancy-pull`, `seancy-rebuild`, `seancy-deploy`, `seancy-logs`, voir
  `infra/trello-claude/README.md`, « Commandes serveur ») plutôt que les commandes Docker/Git brutes.
