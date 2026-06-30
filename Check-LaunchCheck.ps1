param(
  [string]$WatchDir = $(if ($env:LAUNCHCHECK_WATCH_DIR) { $env:LAUNCHCHECK_WATCH_DIR } else { Join-Path $HOME "Downloads" }),
  [switch]$Json
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here
$ArgsList = @("bin/launchcheck.js", "status", "--watch", $WatchDir)
if ($Json) { $ArgsList += "--json" }
node @ArgsList
