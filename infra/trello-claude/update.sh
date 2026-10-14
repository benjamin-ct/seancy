#!/usr/bin/env bash
# Met a jour et relance le listener webhook Trello -> Claude -> Discord.
# A lancer depuis le serveur, dans le dossier de la stack (ex: /Volume2/config/trello-claude),
# apres avoir edite listener/server.js ou recupere les derniers changements via `git pull`.
set -euo pipefail

cd "$(dirname "$0")"
docker-compose -f docker-compose-seancy.yml up -d --build --force-recreate webhook-listener
