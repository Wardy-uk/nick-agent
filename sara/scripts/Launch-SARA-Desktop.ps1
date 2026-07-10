$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$saraRoot = Split-Path -Parent $scriptDir
$backendDir = Join-Path $saraRoot 'backend'
$frontendDir = Join-Path $saraRoot 'frontend'
$electronDir = Join-Path $saraRoot 'desktop-electron'
$backendPort = 3005
$backendUrl = "http://localhost:$backendPort/"

function Test-LocalPort {
  param([int]$Port)

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(300)
    if (-not $ok) { return $false }
    $client.EndConnect($iar) | Out-Null
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-ForPort {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalPort -Port $Port) { return $true }
    Start-Sleep -Milliseconds 350
  }
  return $false
}

function Ensure-Dependency {
  param(
    [string]$WorkingDirectory,
    [string]$ProbePath
  )

  if (Test-Path $ProbePath) { return }

  Start-Process -FilePath 'npm.cmd' `
    -ArgumentList 'install' `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -Wait
}

function Get-LatestWriteTime {
  param([string]$Path)

  if (-not (Test-Path $Path)) { return [datetime]::MinValue }
  return (Get-ChildItem $Path -Recurse -File | Measure-Object -Property LastWriteTime -Maximum).Maximum
}

Ensure-Dependency -WorkingDirectory $backendDir -ProbePath (Join-Path $backendDir 'node_modules\express')
Ensure-Dependency -WorkingDirectory $frontendDir -ProbePath (Join-Path $frontendDir 'node_modules\vite')
Ensure-Dependency -WorkingDirectory $electronDir -ProbePath (Join-Path $electronDir 'node_modules\electron')

$frontendDistDir = Join-Path $frontendDir 'dist'
$frontendSourceTime = Get-LatestWriteTime -Path (Join-Path $frontendDir 'src')
$frontendBuildTime = Get-LatestWriteTime -Path $frontendDistDir
if ($frontendBuildTime -lt $frontendSourceTime) {
  Start-Process -FilePath 'npm.cmd' `
    -ArgumentList 'run', 'build' `
    -WorkingDirectory $frontendDir `
    -WindowStyle Hidden `
    -Wait
}

if (-not (Test-LocalPort -Port $backendPort)) {
  Start-Process -FilePath 'node.exe' `
    -ArgumentList 'server.js' `
    -WorkingDirectory $backendDir `
    -WindowStyle Hidden

  if (-not (Wait-ForPort -Port $backendPort -TimeoutSeconds 20)) {
    throw "SARA backend did not start on $backendUrl"
  }
}

$env:SARA_URL = $backendUrl
Start-Process -FilePath 'npm.cmd' `
  -ArgumentList 'start' `
  -WorkingDirectory $electronDir `
  -WindowStyle Hidden
