param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [string]$WatchDir = $(if ($env:LAUNCHCHECK_WATCH_DIR) { $env:LAUNCHCHECK_WATCH_DIR } else { Join-Path $HOME "Downloads" }),
  [switch]$NoBrowser
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here
$ArgsList = @("bin/launchcheck.js", "validate", $InputPath, "--watch", $WatchDir)
if ($NoBrowser) { $ArgsList += "--no-browser" }
node @ArgsList
