#!/usr/bin/env bash
# Remet en place les secrets GitHub Actions et Cloudflare Workers à partir
# d'un fichier JSON local { "NOM": "valeur", ... }.
#
# Usage (à lancer sur ton poste, jamais en CI) :
#   scripts/restore-secrets.sh github <fichier.json> [owner/repo]
#   scripts/restore-secrets.sh cloudflare <fichier.json> <worker> [account_id]
#
# Exemples :
#   scripts/restore-secrets.sh github github-secrets.json
#   scripts/restore-secrets.sh cloudflare seancy.json seancy 96a41a5c3797a592a91ab5263c395f91
#
# Les clés à valeur vide ("") sont ignorées : on peut partir de
# scripts/secrets.template.json et ne remplir que ce qu'on veut remettre.
# Le fichier de valeurs ne doit JAMAIS être commité : garde-le hors du
# dépôt (ou supprime-le juste après).
set -euo pipefail

die() { echo "Erreur : $*" >&2; exit 1; }
command -v jq >/dev/null || die "jq est requis."

target=${1:-}
file=${2:-}
[ -n "$target" ] && [ -n "$file" ] || die "usage : $0 github|cloudflare <fichier.json> ..."
[ -f "$file" ] || die "fichier introuvable : $file"
jq -e 'type == "object" and all(.[]; type == "string")' "$file" >/dev/null \
  || die "$file doit être un objet JSON { \"NOM\": \"valeur\" } (valeurs en texte)."

if git ls-files --error-unmatch "$file" >/dev/null 2>&1; then
  die "$file est suivi par git : sors-le du dépôt avant de continuer."
fi

case "$target" in
  github)
    command -v gh >/dev/null || die "gh (GitHub CLI) est requis."
    repo=${3:-benjamin-ct/seancy}
    jq -r 'to_entries[] | select(.value != "") | .key' "$file" | while IFS= read -r name; do
      # -j : pas de retour à la ligne ajouté à la valeur.
      jq -j --arg k "$name" '.[$k]' "$file" | gh secret set "$name" --repo "$repo"
      echo "✓ $name ($repo)"
    done
    ;;
  cloudflare)
    worker=${3:-}
    [ -n "$worker" ] || die "précise le nom du Worker (ex. seancy, seancy-develop)."
    [ -n "${4:-}" ] && export CLOUDFLARE_ACCOUNT_ID=$4
    tmp=$(mktemp)
    trap 'rm -f "$tmp"' EXIT
    jq 'with_entries(select(.value != ""))' "$file" > "$tmp"
    npx wrangler secret bulk "$tmp" --name "$worker"
    ;;
  *)
    die "cible inconnue : $target (github ou cloudflare)."
    ;;
esac
