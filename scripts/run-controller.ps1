param(
  [switch]$NoPublish
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot ".runtime\logs"
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $runtimeDirectory "controller-$stamp.log"
$codexCandidate = Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin\codex.exe"
if (Test-Path -LiteralPath $codexCandidate) {
  $env:CODEX_EXECUTABLE = $codexCandidate
} elseif (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
  throw "Codex CLI was not found. Open Codex and confirm that the codex command is installed."
}

Push-Location $projectRoot
try {
  if ($NoPublish) {
    & npm run controller 2>&1 | Tee-Object -FilePath $logPath
  } else {
    & npm run controller -- --publish 2>&1 | Tee-Object -FilePath $logPath
  }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
