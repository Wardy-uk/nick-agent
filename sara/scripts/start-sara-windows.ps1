# start-sara-windows.ps1 — bring up the full SARA desktop stack on Windows (ARM64).
#
# Order matters: backend first (the UI + /api/presence live here), then wait for it to
# listen, then the Watch presence reporter (feeds /api/presence). Every step is guarded,
# so running this twice is harmless — it only starts what isn't already up. Registered to
# run at login by install-autostart.ps1.
#
# ⚠ It starts the STACK, not the WINDOW — see the note where the Electron launch used
# to be. Opening SARA is `sara/desktop-electron/SARA.vbs`, from a shortcut.
#
# Tuned presence config (decided empirically 2026-06-12, see watch-irk-RESULTS / handoff):
#   passive scan; "near" = >=2 of last 8 one-second samples stronger than -78 dBm; fused
#   with system-wide keyboard/mouse idle (5s grace). Lock = Watch signal gone weak AND no
#   input. These RSSI numbers are tuned to Nick's desk; a very different spot may need a
#   re-tune (WATCH_RSSI_NEAR / WATCH_RSSI_NEEDED).

$ErrorActionPreference = 'SilentlyContinue'
$root = 'C:\Users\NickW\Claude\nuero'
$logDir = Join-Path $root 'sara\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 1. Backend (:3005) — skip if something already holds the port.
if (-not (Get-NetTCPConnection -LocalPort 3005 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath 'node' -ArgumentList '--env-file=.env', 'server.js' `
    -WorkingDirectory (Join-Path $root 'sara\backend') `
    -RedirectStandardOutput (Join-Path $logDir 'backend.out.log') `
    -RedirectStandardError  (Join-Path $logDir 'backend.err.log') `
    -WindowStyle Hidden
}

# Wait up to ~30s for the backend to listen before launching the UI.
for ($i = 0; $i -lt 60; $i++) {
  if (Get-NetTCPConnection -LocalPort 3005 -State Listen -ErrorAction SilentlyContinue) { break }
  Start-Sleep -Milliseconds 500
}

# 2. Watch presence reporter — skip if already running.
$reporter = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'watch-presence-reporter' }
if (-not $reporter) {
  $env:WATCH_SCAN_MODE   = 'passive'
  $env:WATCH_RSSI_NEAR   = '-78'
  $env:WATCH_RSSI_WINDOW = '8'
  $env:WATCH_RSSI_NEEDED = '2'
  $env:WATCH_INPUT_GRACE_S = '5'
  $env:WATCH_TICK_S      = '1'
  Start-Process -FilePath (Join-Path $root 'windows-watch-lock\venv\Scripts\python.exe') `
    -ArgumentList 'watch-presence-reporter.py' `
    -WorkingDirectory (Join-Path $root 'windows-watch-lock') `
    -RedirectStandardOutput (Join-Path $logDir 'watch-reporter.out.log') `
    -RedirectStandardError  (Join-Path $logDir 'watch-reporter.err.log') `
    -WindowStyle Hidden
}

# 3. The Electron window is deliberately NOT started here.
#
# ⚠ IT USED TO BE, and it fought the desktop shortcut. This script launched
# Electron with SARA_URL=http://localhost:3005/ (the kiosk build), while the
# shortcut asks for https://sara.nickward.co.uk (the phone build). main.js holds
# a single-instance lock, so whichever starts FIRST wins the URL and the second
# launch silently focuses the existing window — after a login, clicking the
# shortcut got Nick the kiosk and no indication why.
#
# Two launchers, one window, and the loser fails quietly. So this script now
# starts only what has no other way of starting: the backend that serves :3005
# and answers /api/presence, and the Watch reporter that feeds it. Opening SARA
# is a thing Nick does deliberately, from `sara/desktop-electron/SARA.vbs` —
# which takes the URL as an argument and needs no console to set it.
#
# If you ever want her up at login again, add a shortcut to SARA.vbs in the
# Startup folder rather than putting Electron back here: that way there is still
# exactly one thing that decides which SARA opens.
