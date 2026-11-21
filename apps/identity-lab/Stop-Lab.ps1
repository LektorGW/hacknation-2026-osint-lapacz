$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'data\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host 'Brak zapisanego procesu w tle. Dla Start-Lab.cmd użyj Ctrl+C w jego oknie.'
  exit 0
}
$labProcessId = [int](Get-Content -LiteralPath $pidFile -Raw)
$labProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $labProcessId"
$serverPath = Join-Path $PSScriptRoot 'server.mjs'
if ($labProcess -and $labProcess.Name -eq 'node.exe' -and $labProcess.CommandLine.Contains($serverPath)) {
  Stop-Process -Id $labProcessId
  Write-Host 'Zatrzymano Identity Lab i 27 portali.'
} elseif ($labProcess) {
  throw 'PID wskazuje inny proces. Nie został zatrzymany.'
} else {
  Write-Host 'Identity Lab jest już zatrzymane.'
}
Remove-Item -LiteralPath $pidFile -Force
