<#
.SYNOPSIS
  Installs the NEURO desktop agent as a scheduled task that runs at logon.

.DESCRIPTION
  Proves the whole path works BEFORE scheduling anything: it takes one sample,
  shows you exactly what would be sent, posts it, and only then registers the
  task. An installer that schedules something it has never successfully run is
  how you end up with a silent agent and no idea why.

  The task runs as the logged-in user (it has to — it reads the interactive
  session's idle time and foreground window), with no elevation, and only while
  someone is logged on.

  ⚠ The token is written to a config file readable only by you, NOT into the
  scheduled task's arguments — task arguments are visible to anything that can
  list tasks.

.PARAMETER BaseUrl
  NEURO's API root, e.g. http://100.100.28.58:3001

.PARAMETER Token
  NEURO_API_TOKEN, from the Pi's backend/.env.

.PARAMETER Uninstall
  Remove the scheduled task and the config file.

.EXAMPLE
  .\install.ps1 -BaseUrl http://100.100.28.58:3001 -Token xxxxx
#>

[CmdletBinding()]
param(
  [string]$BaseUrl,
  [string]$Token,
  [int]$IntervalSeconds = 120,
  [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName  = 'NEURO Desktop Agent'
$AgentPath = Join-Path $PSScriptRoot 'neuro-desktop-agent.ps1'
$ConfigDir = Join-Path $env:LOCALAPPDATA 'neuro'
$ConfigPath = Join-Path $ConfigDir 'desktop-agent.json'
$RunnerPath = Join-Path $ConfigDir 'run-agent.ps1'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "No scheduled task '$TaskName' to remove."
  }
  foreach ($p in @($ConfigPath, $RunnerPath)) {
    if (Test-Path $p) { Remove-Item $p -Force; Write-Host "Removed $p" }
  }
  Write-Host "Done. NEURO will report the laptop as unreadable, which is the honest answer."
  return
}

if (-not $BaseUrl) { throw 'BaseUrl is required.' }
if (-not $Token)   { throw 'Token is required.' }
if (-not (Test-Path $AgentPath)) { throw "Agent script not found at $AgentPath" }

# --- 1. Prove it works before scheduling it --------------------------------
Write-Host "`n[1/3] Testing one sample against $BaseUrl ..." -ForegroundColor Cyan
& $AgentPath -BaseUrl $BaseUrl -Token $Token -Once
Write-Host "  ...that worked. Note what was sent above: a process name, an idle" -ForegroundColor Green
Write-Host "  count and a lock flag. No window title, no path, no URL." -ForegroundColor Green

# --- 2. Config, readable only by you ---------------------------------------
Write-Host "`n[2/3] Writing config ..." -ForegroundColor Cyan
if (-not (Test-Path $ConfigDir)) { New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null }

@{ baseUrl = $BaseUrl; token = $Token; intervalSeconds = $IntervalSeconds } |
  ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8

# ⚠ The token lives here and nowhere else. Scheduled task arguments are visible
# to anything that can list tasks, so it must not be passed on the command line.
$acl = Get-Acl $ConfigPath
$acl.SetAccessRuleProtection($true, $false)   # drop inherited rules
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
  "$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'Allow')))
Set-Acl -Path $ConfigPath -AclObject $acl
Write-Host "  $ConfigPath (this account only)"

# A tiny runner so the task's own arguments carry no secret.
@"
`$ErrorActionPreference = 'Stop'
`$cfg = Get-Content -Raw '$ConfigPath' | ConvertFrom-Json
& '$AgentPath' -BaseUrl `$cfg.baseUrl -Token `$cfg.token -IntervalSeconds `$cfg.intervalSeconds
"@ | Set-Content -Path $RunnerPath -Encoding UTF8

# --- 3. Schedule it ---------------------------------------------------------
Write-Host "`n[3/3] Registering scheduled task ..." -ForegroundColor Cyan
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunnerPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# Runs as the interactive user with no elevation — it must see the session's own
# idle time and foreground window, which a SYSTEM task cannot. Restart on
# failure so a network blip does not end the day's reporting.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'Reports foreground app + idle time to NEURO. Process name only, never window titles.' | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "`nInstalled and started." -ForegroundColor Green
Write-Host "  Check it:    Get-ScheduledTask -TaskName '$TaskName'"
Write-Host "  What NEURO sees:  GET $BaseUrl/api/desktop/activity"
Write-Host "  Remove it:   .\install.ps1 -Uninstall"
