# Fonctions shell pour piloter la stack Trello → Claude depuis le serveur (NAS).
# À charger depuis ~/.bashrc (voir README.md, « Commandes serveur ») :
#
#   source /Volume2/config/trello-claude/bobine/infra/trello-claude/seancy-shell.sh
#
# seancy-pull    checkout serveur propre ? puis git fetch + git pull --ff-only
# seancy-main    checkout serveur propre et tout poussé ? puis bascule sur main à jour
# seancy-rebuild [all|listener|claude] rebuild + recréation (vérifie qu'aucune exécution
#                Claude n'est en cours avant de toucher à seancy-repo ; --force pour passer outre)
# seancy-deploy  seancy-pull, puis seancy-rebuild (mêmes arguments)
# seancy-status  branches/commits (checkout serveur et clone de Claude), exécution en cours, Docker
# seancy-logs    suit les logs du listener Trello/Sentry
#
# Le checkout serveur est monté dans seancy-repo en /srv/seancy ; Claude travaille dans son
# propre clone (/workspace, volume claude-workspace) et ne change donc jamais sa branche.

# Dossier de la stack (docker-compose-seancy.yml) sur le serveur. Le chemin
# par défaut pointe encore vers le dossier physique `bobine/` du NAS : ce
# nom de dossier n'est pas du code versionné, ce script ne peut donc pas le
# renommer lui-même. Si vous renommez ce dossier sur le NAS, mettez à jour
# la valeur par défaut ci-dessous (ou surchargez SEANCY_STACK_DIR avant de
# sourcer ce fichier).
SEANCY_STACK_DIR="${SEANCY_STACK_DIR:-/Volume2/config/trello-claude/bobine/infra/trello-claude}"

seancy-pull() {
  docker exec --user claudeuser seancy-repo bash -lc '
    set -e
    cd /srv/seancy

    echo "=== Branche courante ==="
    git branch --show-current

    echo
    echo "=== Etat Git ==="
    git status --short

    if [ -n "$(git status --porcelain)" ]; then
      echo
      echo "ABANDON : le checkout contient des modifications non committees."
      echo "Inspecte-les avec : docker exec --user claudeuser seancy-repo bash -lc '\''cd /srv/seancy && git status && git diff'\''"
      exit 1
    fi

    echo
    echo "=== Mise a jour ==="
    git fetch origin
    git pull --ff-only

    echo
    echo "=== Commit actif ==="
    git log -1 --oneline
  '
}

seancy-main() {
  docker exec --user claudeuser seancy-repo bash -lc '
    set -e
    cd /srv/seancy

    echo "=== Branche courante ==="
    git branch --show-current

    echo
    echo "=== Etat Git ==="
    git status --short

    # Modifications non committées, y compris fichiers non suivis.
    if [ -n "$(git status --porcelain)" ]; then
      echo
      echo "ABANDON : le checkout contient des modifications non committees."
      echo "Inspecte-les avec : docker exec --user claudeuser seancy-repo bash -lc '\''cd /srv/seancy && git status && git diff'\''"
      exit 1
    fi

    git fetch origin

    # Commits locaux absents du remote : ils seraient difficiles à retrouver
    # une fois sur main (branche sans upstream, ou en avance sur lui).
    if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
      unpushed=$(git rev-list --count "@{u}..HEAD")
    else
      unpushed=$(git rev-list --count HEAD --not --remotes=origin)
    fi
    if [ "$unpushed" -gt 0 ]; then
      echo
      echo "ABANDON : $unpushed commit(s) de la branche courante ne sont pas pousses :"
      git log --oneline -n 10 HEAD --not --remotes=origin
      exit 1
    fi

    echo
    echo "=== Bascule sur main ==="
    git switch main
    git pull --ff-only origin main

    echo
    echo "=== Etat final ==="
    git status --short --branch
    git log -1 --oneline
  '
}

# Verrou posé par seancy-claude-run pendant une exécution Claude (voir seancy-repo/).
SEANCY_CLAUDE_LOCK="/tmp/seancy-claude-run.lock"

# 0 si une exécution Claude tourne dans seancy-repo. flock -E 75 distingue « verrou pris »
# d'un conteneur arrêté (docker exec échoue alors avec un autre code).
seancy-claude-busy() {
  docker exec --user claudeuser seancy-repo \
    flock -n -E 75 "$SEANCY_CLAUDE_LOCK" true >/dev/null 2>&1
  [ $? -eq 75 ]
}

# seancy-rebuild [all|listener|claude] [--force]
#   listener : toujours sans risque, une exécution Claude en cours continue dans seancy-repo
#              (seul son log /tmp/claude-last-run.log est perdu).
#   claude   : seancy-repo seul ; refusé si une exécution Claude est en cours.
#   all      : les deux (défaut) ; même vérification.
seancy-rebuild() {
  local target="all" force=""
  local arg
  for arg in "$@"; do
    case "$arg" in
      all | listener | claude) target="$arg" ;;
      --force) force=1 ;;
      *)
        echo "Usage : seancy-rebuild [all|listener|claude] [--force]" >&2
        return 64
        ;;
    esac
  done

  local services
  case "$target" in
    listener) services="webhook-listener" ;;
    claude) services="seancy-repo" ;;
    all) services="seancy-repo webhook-listener" ;;
  esac

  if [ "$target" != "listener" ] && [ -z "$force" ] && seancy-claude-busy; then
    echo "ABANDON : une execution Claude est en cours dans seancy-repo."
    echo "Relance plus tard, ou 'seancy-rebuild listener' pour ne mettre a jour que le listener."
    echo "(--force pour recreer quand meme et interrompre Claude.)"
    return 1
  fi

  (
    set -e
    cd "$SEANCY_STACK_DIR"

    # shellcheck disable=SC2086 # liste de services volontairement découpée
    docker-compose -f docker-compose-seancy.yml \
      up -d --build --force-recreate $services

    echo
    docker-compose -f docker-compose-seancy.yml ps

    echo
    echo "=== Derniers logs du listener ==="
    docker logs --tail 20 trello-claude-listener
  )
}

# `&&` plutôt qu'un `set -e` : dans une fonction chargée par ~/.bashrc, un
# `set -e` s'appliquerait au shell interactif lui-même, qui se fermerait dès
# que seancy-pull échoue (checkout modifié).
seancy-deploy() {
  seancy-pull && seancy-rebuild "$@"
}

seancy-status() {
  echo "=== Git (checkout serveur) ==="
  docker exec --user claudeuser seancy-repo bash -lc '
    cd /srv/seancy
    git status --short
    echo "Branche : $(git branch --show-current)"
    echo "Commit  : $(git log -1 --oneline)"
  '

  echo
  echo "=== Claude (clone de travail) ==="
  docker exec --user claudeuser seancy-repo bash -lc '
    if [ -d /workspace/.git ]; then
      cd /workspace
      echo "Branche : $(git branch --show-current)"
      echo "Commit  : $(git log -1 --oneline)"
    else
      echo "Pas encore cloné (créé à la première exécution)."
    fi
  '
  if seancy-claude-busy; then
    echo "Exécution : en cours"
  else
    echo "Exécution : aucune"
  fi

  echo
  echo "=== Docker ==="
  (
    cd "$SEANCY_STACK_DIR"
    docker-compose -f docker-compose-seancy.yml ps
  )
}

seancy-logs() {
  docker logs -f --tail 100 trello-claude-listener
}
