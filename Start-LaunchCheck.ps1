param(
  [string]$WatchDir = $(if ($env:LAUNCHCHECK_WATCH_DIR) { $env:LAUNCHCHECK_WATCH_DIR } else { Join-Path $HOME "Downloads" }),
  [switch]$NoBrowser,
  [switch]$ScanExisting
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here
$ArgsList = @("bin/launchcheck.js", "watch", "--watch", $WatchDir)
if ($NoBrowser) { $ArgsList += "--no-browser" }
if ($ScanExisting) { $ArgsList += "--scan-existing" }
node @ArgsList
