$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
  $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $bundledNode) { $nodePath = $bundledNode }
}
if (-not $nodePath) { throw 'Zainstaluj Node.js 22 lub nowszy i uruchom ponownie.' }
Write-Host 'Identity Lab: http://127.0.0.1:8787'
Write-Host '27 dodatkowych portali: porty 8801-8827. Zatrzymanie: Ctrl+C.'
& $nodePath (Join-Path $PSScriptRoot 'server.mjs') --portals
