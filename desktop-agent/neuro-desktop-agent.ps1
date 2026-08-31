<#
.SYNOPSIS
  Reports what the laptop is doing to NEURO, so SARA can tell working from
  not-working and four hours of one job from four hours of twelve.

.DESCRIPTION
  Posts one small sample every couple of minutes:

      { at, app, idleSeconds, locked, host }

  WHAT IT SENDS, AND WHAT IT DELIBERATELY DOES NOT
  ------------------------------------------------
  It sends the FOREGROUND PROCESS NAME and nothing else. Never the window
  title, never a file path, never a URL, never keystrokes.

  That is not caution for its own sake. A VS Code title carries the file and
  the workspace; a browser title carries the page; an Outlook title carries the
  SUBJECT LINE of whatever is open, which on this machine means customer names,
  ticket subjects and, on a bad day, the contents of a disciplinary folder.
  "Code" answers the question. "risk-assessment-naomi.docx - Word" does not
  answer it any better and cannot be un-sent.

  A LOCKED session reports `locked` and no app at all — what was open before
  walking away is not something to keep a record of.

  Nothing is stored locally. If NEURO is unreachable the sample is dropped, not
  queued: this is "what is he doing NOW", and a sample delivered an hour late
  answers a question nobody is asking.

.PARAMETER BaseUrl
  NEURO's API root, e.g. http://100.100.28.58:3001

.PARAMETER Token
  NEURO_API_TOKEN. Machine clients use the token, not the PIN.

.PARAMETER IntervalSeconds
  Seconds between samples. Default 120.

.PARAMETER Once
  Take a single sample, post it, and exit. Used by the installer to prove the
  whole path works before anything is scheduled.

.EXAMPLE
  .\neuro-desktop-agent.ps1 -BaseUrl http://100.100.28.58:3001 -Token xxx -Once
#>

[CmdletBinding()]
param(
  [string]$BaseUrl = $env:NEURO_BASE_URL,
  [string]$Token = $env:NEURO_API_TOKEN,
  [int]$IntervalSeconds = 120,
  [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $BaseUrl) { throw 'BaseUrl is required (or set NEURO_BASE_URL).' }
if (-not $Token)   { throw 'Token is required (or set NEURO_API_TOKEN).' }
$BaseUrl = $BaseUrl.TrimEnd('/')

# --- Win32: idle time and the foreground process ---------------------------
#
# GetLastInputInfo is keyboard + mouse across the whole session, so reading a
# document counts as idle. That is why the server's "away" threshold tolerates
# a long think rather than a short one.
if (-not ('Neuro.Win32' -as [type])) {
  Add-Type -Namespace Neuro -Name Win32 -MemberDefinition @'
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [DllImport("kernel32.dll")]
    public static extern uint GetTickCount();

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
'@
}

function Get-IdleSeconds {
  $info = New-Object Neuro.Win32+LASTINPUTINFO
  $info.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [Neuro.Win32]::GetLastInputInfo([ref]$info)) { return 0 }
  $ticks = [Neuro.Win32]::GetTickCount()
  # GetTickCount wraps roughly every 49 days. A wrap would otherwise produce a
  # huge negative idle time and read as "he has been away since 1994".
  if ($ticks -lt $info.dwTime) { return 0 }
  return [int](($ticks - $info.dwTime) / 1000)
}

function Test-SessionLocked {
  # LogonUI owns the screen whenever the session is locked or on the login
  # screen. Cheaper and more reliable than the session-notification APIs, and
  # it needs no elevation.
  return [bool](Get-Process -Name 'LogonUI' -ErrorAction SilentlyContinue)
}

function Get-ForegroundProcessName {
  $hwnd = [Neuro.Win32]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  $procId = 0
  [void][Neuro.Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  if ($procId -eq 0) { return $null }
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $proc) { return $null }
  # ⚠ ProcessName ONLY. Never $proc.MainWindowTitle — see the header.
  return $proc.ProcessName
}

function Get-Sample {
  $locked = Test-SessionLocked
  [pscustomobject]@{
    at          = (Get-Date).ToUniversalTime().ToString('o')
    # A locked session sends no app at all, not even a stripped one.
    app         = if ($locked) { $null } else { Get-ForegroundProcessName }
    idleSeconds = Get-IdleSeconds
    locked      = $locked
    host        = $env:COMPUTERNAME
  }
}

function Send-Sample($sample) {
  $body = $sample | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/desktop/activity" `
    -Headers @{ 'X-NEURO-API-TOKEN' = $Token } `
    -ContentType 'application/json' -Body $body -TimeoutSec 10
}

if ($Once) {
  $s = Get-Sample
  # Printed so the installer can show what would be sent BEFORE it is sent —
  # the privacy claim above should be checkable, not taken on trust.
  Write-Host "Sample: $($s | ConvertTo-Json -Compress)"
  $result = Send-Sample $s
  Write-Host "NEURO stored: $($result | ConvertTo-Json -Compress)"
  return
}

Write-Host "NEURO desktop agent -> $BaseUrl, every ${IntervalSeconds}s. Ctrl+C to stop."
while ($true) {
  try {
    Send-Sample (Get-Sample) | Out-Null
  } catch {
    # Dropped, never queued. This answers "what is he doing NOW", and a sample
    # delivered an hour late answers a question nobody is asking.
    Write-Warning "post failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $IntervalSeconds
}
