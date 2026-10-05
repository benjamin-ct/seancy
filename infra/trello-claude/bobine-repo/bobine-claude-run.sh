#!/usr/bin/env bash
# Lance une exécution `claude -p` dans le clone de travail dédié de Claude.
# Appelé par le listener : docker exec --user claudeuser bobine-repo bobine-claude-run "<prompt>"
#
# - Claude ne travaille jamais dans le checkout du serveur (monté en $BOBINE_STACK_REPO) : il a
#   son propre clone ($BOBINE_WORKSPACE, volume Docker), qu'il peut changer de branche à volonté
#   sans empêcher un humain de faire `bobine-pull` / `bobine-rebuild` côté serveur.
# - Une seule exécution à la fois : verrou flock, libéré automatiquement à la fin du processus
#   (même en cas de crash). Code de sortie 75 si une exécution est déjà en cours ; bobine-shell.sh
#   teste ce même verrou avant de recréer le conteneur.
set -euo pipefail

WORKSPACE="${BOBINE_WORKSPACE:-/workspace}"
STACK_REPO="${BOBINE_STACK_REPO:-/srv/bobine}"
LOCK_FILE="${BOBINE_CLAUDE_LOCK:-/tmp/bobine-claude-run.lock}"
CLAUDE_MODEL="${CLAUDE_MODEL:-claude-sonnet-5}"
CLAUDE_EFFORT="${CLAUDE_EFFORT:-medium}"
TOKEN_FILE="${BOBINE_CLAUDE_TOKEN_FILE:-$HOME/.bobine-claude-token}"

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "Usage : bobine-claude-run \"<prompt>\"" >&2
  exit 64
fi
prompt="$1"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Une execution Claude est deja en cours dans bobine-repo." >&2
  exit 75
fi

# Premier lancement : le volume est vide, on clone depuis le même remote que le checkout serveur.
if [ ! -d "$WORKSPACE/.git" ]; then
  origin_url=$(git -C "$STACK_REPO" remote get-url origin)
  git clone --quiet "$origin_url" "$WORKSPACE"
fi

cd "$WORKSPACE"
git fetch --quiet --prune origin

# Une exécution précédente interrompue (coupure, crédits épuisés, rebuild --force…) a pu laisser
# du travail en cours : on le met de côté puis on le signale à Claude dans le prompt, pour que la
# règle de reprise du skill le retrouve au lieu de repartir de zéro.
resume_notes=()
branch=$(git branch --show-current || true)
if [ -n "$(git status --porcelain)" ]; then
  git stash push --quiet --include-untracked \
    -m "bobine-claude-run $(date -u +%Y-%m-%dT%H:%M:%SZ) (${branch:-HEAD détachée})"
  stash_msg=$(git stash list -1 --format=%gs)
  echo "Modifications non committées mises de côté : $stash_msg" >&2
  resume_notes+=("modifications non committées mises de côté dans stash@{0} ($stash_msg) : les relire avec git stash show -p stash@{0} et les réappliquer (git stash pop) sur la bonne branche si elles servent encore")
fi
if [ -n "$branch" ] && [ "$branch" != main ]; then
  unpushed=0
  if git rev-parse --quiet --verify "$branch@{upstream}" >/dev/null; then
    unpushed=$(git rev-list --count "$branch@{upstream}..$branch")
  elif [ -z "$(git config "branch.$branch.merge" || true)" ]; then
    # Jamais poussée. (Upstream configuré mais disparu = PR mergée/fermée : supprimée plus bas.)
    unpushed=$(git rev-list --count "origin/main..$branch")
  fi
  if [ "$unpushed" -gt 0 ]; then
    resume_notes+=("la branche locale $branch contient $unpushed commit(s) non poussé(s) : repartir de cette branche (git switch $branch) plutôt que de la recréer")
  fi
fi

# Jeton OAuth pour le développeur délégué (bobine-claude-dev) : Claude Code le retire de
# l'environnement des commandes qu'il lance. Réécrit à chaque exécution (suit le .env).
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  (umask 077 && printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" >"$TOKEN_FILE.tmp")
  mv -f "$TOKEN_FILE.tmp" "$TOKEN_FILE"
else
  rm -f "$TOKEN_FILE"
fi

# Chaque exécution part de main à jour (skills compris) ; les branches locales restent intactes.
git switch --quiet --force-create main origin/main

# Ménage, pour que le clone ne grossisse pas au fil des tickets (le verrou garantit qu'aucune
# autre exécution n'utilise ce qui est supprimé ici) :
# - worktrees de validation locale (/tmp/…, avec leurs node_modules) des exécutions précédentes ;
git worktree list --porcelain | sed -n 's/^worktree //p' | tail -n +2 | while read -r wt; do
  git worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
done
git worktree prune
# - branches locales dont la branche distante a été supprimée (PR mergée ou fermée) ;
git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads |
  awk '$2 == "[gone]" { print $1 }' | while read -r gone; do
    git branch --quiet -D "$gone"
  done
# - stashes de plus de 30 jours, puis compactage Git si nécessaire.
git reflog expire --expire=30.days refs/stash 2>/dev/null || true
git gc --auto --quiet

if [ ${#resume_notes[@]} -gt 0 ]; then
  note="REPRISE : l'exécution précédente s'est interrompue en cours de route."
  for n in "${resume_notes[@]}"; do note+=" - $n."; done
  prompt="$prompt $note"
  echo "$note" >&2
fi

# Pas d'`exec` et `9>&-` : le verrou reste tenu par ce script seul, pas par les processus que
# Claude laisserait tourner (ex. un `wrangler dev` orphelin), qui le bloqueraient indéfiniment.
status=0
claude --model "$CLAUDE_MODEL" --effort "$CLAUDE_EFFORT" -p "$prompt" \
  --dangerously-skip-permissions \
  --allowedTools 'Bash(git *)' 'Bash(curl *)' Read Write \
  9>&- || status=$?
exit "$status"
