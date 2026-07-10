$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launchScript = Join-Path $scriptDir 'Launch-SARA-Desktop.ps1'
$iconPath = Join-Path (Split-Path -Parent $scriptDir) 'desktop\sara-desktop.ico'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'SARA Desktop.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = "-ExecutionPolicy Bypass -File `"$launchScript`""
$shortcut.WorkingDirectory = $scriptDir
$shortcut.WindowStyle = 7
$shortcut.IconLocation = $iconPath
$shortcut.Description = 'Launch SARA desktop'
$shortcut.Save()

Write-Output "Created shortcut: $shortcutPath"
