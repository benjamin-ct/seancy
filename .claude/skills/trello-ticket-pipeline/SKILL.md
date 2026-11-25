---
name: trello-ticket-pipeline
description: Ancien pilote du board Trello de Seancy, remplacé par la page Tickets (skill ticket). Ne l'utilise que si un prompt demande explicitement « le skill trello-ticket-pipeline » (webhook Trello du NAS encore branché) ; pour traiter, reprendre ou faire avancer des tickets, utilise le skill ticket.
---

# Board Trello : remplacé par la page Tickets

Depuis le 17 novembre 2026, les tickets de Seancy vivent sur la page Tickets de l'espace admin (`worker/tickets.ts`),
plus sur Trello : toutes les cartes y ont été importées (`scripts/trello-import.ts`). Les règles de ce skill (colonnes,
règle d'or de reprise, feature ou hotfix, contrôles, changelog, CGU, revues, attente de la CI, blocage, limite
d'usage) sont reprises et adaptées dans le skill **`ticket`** (`.claude/skills/ticket/SKILL.md`).

Si ce skill est lancé (le listener du NAS reçoit encore les webhooks Trello) :

1. Ne rien modifier sur Trello, dans le dépôt ni sur GitHub.
2. Si `DISCORD_TOKEN` et `DISCORD_CHANNEL_ID` sont définis, poster un seul message par l'API REST Discord :
   « ℹ️ Webhook Trello reçu, mais Trello n'est plus utilisé : les tickets sont sur la page Tickets. Couper le webhook
   Trello du NAS (README, « Bascule depuis Trello »). » et vérifier que la requête a réussi.
3. S'arrêter.
