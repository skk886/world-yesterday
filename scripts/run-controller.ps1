param(
  [switch]$NoPublish
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot ".runtime\logs"
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Get-ChildItem -LiteralPath $runtimeDirectory -Filter "controller-*.log" -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
  Remove-Item -Force
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
  $controllerCommand = if ($NoPublish) {
    "npm run controller -- --candidate-limit 60 --reasoning-effort medium"
  } else {
    "npm run controller -- --publish --candidate-limit 60 --reasoning-effort medium"
  }
  # Windows PowerShell 5 turns normal native stderr (for example Git's
  # "Everything up-to-date") into an ErrorRecord when piped. Merge the two
  # streams inside cmd.exe so only the real process exit code controls failure.
  & $env:ComSpec /d /s /c "$controllerCommand 2>&1" | Tee-Object -FilePath $logPath
  $controllerExitCode = $LASTEXITCODE
  if ($controllerExitCode -ne 0) { exit $controllerExitCode }
} finally {
  Pop-Location
}
