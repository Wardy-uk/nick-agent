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
#
# %LOCALAPPDATA% is already user-scoped by Windows' default ACL — another
# standard user cannot read it. Breaking inheritance on top of that is
# defence-in-depth, and it needs SeSecurityPrivilege, which an unelevated shell
# does not have. So it is ATTEMPTED and, if refused, WARNED ABOUT rather than
# aborted: failing the whole install over a hardening step that only matters to
# an attacker who is already an administrator would be the wrong trade, and
# silently skipping it would be worse than either.
try {
  $acl = Get-Acl $ConfigPath
  $acl.SetAccessRuleProtection($true, $true)   # keep a copy of inherited rules
  foreach ($rule in @($acl.Access)) {
    if ($rule.IdentityReference.Value -notmatch [regex]::Escape($env:USERNAME) -and
        $rule.IdentityReference.Value -notmatch 'SYSTEM') {
      [void]$acl.RemoveAccessRule($rule)
    }
  }
  Set-Acl -Path $ConfigPath -AclObject $acl -ErrorAction Stop
  Write-Host "  $ConfigPath (locked to this account)"
} catch {
  Write-Warning "Could not tighten the ACL on $ConfigPath ($($_.Exception.Message))."
  Write-Warning "It still sits under %LOCALAPPDATA%, which other standard users cannot read."
  Write-Warning "Re-run this installer from an elevated shell if you want inheritance broken too."
  Write-Host "  $ConfigPath (default AppData permissions)"
}

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

# TWO triggers, and the second is what makes "always running" true.
#
# At logon starts it for the session. But a logon trigger alone is a one-shot:
# if the process dies for any reason Task Scheduler's own restart only covers a
# non-zero EXIT, and a wedged or killed process leaves nothing running until the
# next reboot — which on a laptop that sleeps rather than shuts down could be
# weeks.
#
# So a second trigger repeats indefinitely every 15 minutes. Paired with
# MultipleInstances = IgnoreNew below, that is a self-healing watchdog needing no
# extra code: if the agent is already running the new start is discarded, and if
# it is not, this brings it back within a quarter of an hour.
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
  # ⚠ NO -RepetitionDuration. Omitting it means "repeat indefinitely", which is
  # what is wanted. `[TimeSpan]::MaxValue` is the widely-copied idiom for this
  # and Task Scheduler REJECTS it — it serialises to P99999999DT23H59M59S and
  # comes back "incorrectly formatted or out of range". Verified here.
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
     -RepetitionInterval (New-TimeSpan -Minutes 15))
)

# Runs as the interactive user with no elevation — it must see the session's own
# idle time and foreground window, which a SYSTEM task cannot.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable
# ⚠ `-DontStopOnIdleEnd` and the idle condition are OFF by default in a fresh
# settings set, but say so explicitly: the whole point of this agent is to
# report DURING idle, and a task configured to stop when the machine goes idle
# would go quiet at exactly the moment "he is not at his laptop" becomes true.
$settings.RunOnlyIfIdle = $false
$settings.IdleSettings.StopOnIdleEnd = $false
# It must also keep going on battery and on a metered connection — a laptop
# unplugged is still a laptop being worked on.
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false
$settings.RunOnlyIfNetworkAvailable = $false

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
  -Principal $principal -Settings $settings `
  -Description 'Reports foreground app + idle time to NEURO. Process name only, never window titles.' | Out-Null

# ⚠ VERIFY, then claim. The CIM cmdlets above report failure as a NON-terminating
# error, so `$ErrorActionPreference = 'Stop'` does not stop the script and the
# first version of this installer printed "Installed and started" immediately
# after Register-ScheduledTask had failed. An installer that lies about the thing
# it installed is worse than one that does not exist, because nothing else will
# ever tell you.
$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $registered) {
  throw "Registration FAILED — no scheduled task '$TaskName' exists. Nothing is running; see the error above."
}

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
if ($registered.State -eq 'Disabled') { throw "Task '$TaskName' registered but is DISABLED." }

Write-Host "`nInstalled and started." -ForegroundColor Green
Write-Host "  State: $((Get-ScheduledTask -TaskName $TaskName).State); last result: $($info.LastTaskResult)" 
Write-Host "  Runs at logon, and a 15-minute repeating trigger restarts it if it ever stops."
Write-Host "  Check it:         Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "  What NEURO sees:  GET $BaseUrl/api/desktop/activity"
Write-Host "  Remove it:        .\install.ps1 -Uninstall"
