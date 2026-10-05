#!/usr/bin/env bash
# Lance le développeur délégué (`claude -p --model … --effort …`, voir « Modèle et effort par
# ticket » dans le skill trello-ticket-pipeline) avec le jeton OAuth du compte.
#
# Claude Code retire CLAUDE_CODE_OAUTH_TOKEN de l'environnement des commandes qu'il lance : un
# `claude -p` lancé depuis l'outil Bash retomberait sur ~/.claude/.credentials.json, expiré.
# bobine-claude-run écrit donc le jeton dans un fichier (chmod 600) avant chaque exécution, et ce
# script le relit. Choix assumé (carte Trello « test », option 1) : le jeton devient lisible par
# les commandes lancées par Claude.
set -euo pipefail

TOKEN_FILE="${BOBINE_CLAUDE_TOKEN_FILE:-$HOME/.bobine-claude-token}"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "bobine-claude-dev : jeton introuvable ($TOKEN_FILE). Il est écrit par bobine-claude-run ;" \
    "vérifier CLAUDE_CODE_OAUTH_TOKEN dans le .env du serveur puis bobine-rebuild claude." >&2
  exit 78
fi

CLAUDE_CODE_OAUTH_TOKEN=$(cat "$TOKEN_FILE")
export CLAUDE_CODE_OAUTH_TOKEN
exec claude "$@"
