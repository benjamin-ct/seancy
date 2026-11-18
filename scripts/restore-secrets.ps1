# Équivalent Windows (PowerShell 5.1 ou 7) de scripts/restore-secrets.sh :
# remet en place les secrets GitHub Actions et Cloudflare Workers à partir
# d'un fichier JSON local { "NOM": "valeur", ... }.
#
# Usage (à lancer sur ton poste, jamais en CI) :
#   powershell -ExecutionPolicy Bypass -File scripts\restore-secrets.ps1 -Target github -File github-secrets.json
#   powershell -ExecutionPolicy Bypass -File scripts\restore-secrets.ps1 -Target cloudflare -File seancy.json -Worker seancy -AccountId 96a41a5c3797a592a91ab5263c395f91
#
# Les clés à valeur vide ("") sont ignorées. Le fichier de valeurs ne doit
# JAMAIS être commité : garde-le hors du dépôt (ou supprime-le juste après).
param(
  [Parameter(Mandatory = $true)][ValidateSet('github', 'cloudflare')][string]$Target,
  [Parameter(Mandatory = $true)][string]$File,
  [string]$Repo = 'benjamin-ct/seancy',
  [string]$Worker,
  [string]$AccountId
)
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $File)) { throw "Fichier introuvable : $File" }

git ls-files --error-unmatch -- $File 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { throw "$File est suivi par git : sors-le du dépôt avant de continuer." }

$json = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $File), $utf8NoBom) | ConvertFrom-Json
$secrets = [ordered]@{}
foreach ($p in $json.PSObject.Properties) {
  if ($p.Value -isnot [string]) { throw "$File doit être un objet JSON { `"NOM`": `"valeur`" } (valeurs en texte) : $($p.Name) ne l'est pas." }
  if ($p.Value -ne '') { $secrets[$p.Name] = $p.Value }
}
if ($secrets.Count -eq 0) { throw "Aucune valeur renseignée dans $File." }

switch ($Target) {
  'github' {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "gh (GitHub CLI) est requis : winget install GitHub.cli" }
    foreach ($name in $secrets.Keys) {
      # Valeur passée par un fichier temporaire sur l'entrée standard (via
      # cmd) : évite les problèmes de guillemets, d'encodage et de retours
      # à la ligne de PowerShell avec les valeurs multilignes (clés privées).
      $tmp = [System.IO.Path]::GetTempFileName()
      try {
        [System.IO.File]::WriteAllText($tmp, $secrets[$name], $utf8NoBom)
        cmd /c "gh secret set $name --repo $Repo < `"$tmp`""
        if ($LASTEXITCODE -ne 0) { throw "Échec pour $name" }
        Write-Host "OK $name ($Repo)"
      } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      }
    }
  }
  'cloudflare' {
    if (-not $Worker) { throw "Précise le Worker avec -Worker (ex. seancy, seancy-develop)." }
    if ($AccountId) { $env:CLOUDFLARE_ACCOUNT_ID = $AccountId }
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
      [System.IO.File]::WriteAllText($tmp, ($secrets | ConvertTo-Json -Depth 2), $utf8NoBom)
      npx wrangler secret bulk $tmp --name $Worker
      if ($LASTEXITCODE -ne 0) { throw "Échec de wrangler secret bulk." }
    } finally {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
  }
}
