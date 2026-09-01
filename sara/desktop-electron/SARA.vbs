' SARA — Windows launcher with NO console window.
'
' ⚠ WHY THIS EXISTS. Nick, 1 Sep 2026: "SARA is loading with 2 windows." The
' second one was never a SARA window — it was the cmd.exe console that ran
' `npm start`. On Windows that console is the PARENT of the Electron process,
' so it cannot close while SARA is open: it sits in the taskbar all day looking
' like a second app, and closing it kills her.
'
' Two things this avoids, and both matter:
'
'   1. `npm start` spawns a shell, which spawns `electron.cmd`, which is itself
'      a batch file that spawns another shell, which finally runs electron.exe.
'      Every one of those needs a console. So this runs electron.exe DIRECTLY —
'      the console is not hidden, it is never created.
'
'   2. WScript.Shell.Run with a window style of 0 and bWaitOnReturn False means
'      this script exits immediately and leaves nothing behind. A PowerShell
'      launcher would flash its own window before hiding it, and a shortcut set
'      to "Minimized" still puts an item in the taskbar.
'
' ⚠ The URL is an ARGUMENT, not a constant. This file is committed to a public
' repo and the desktop shell points at whichever surface Nick wants that day —
' the phone build on sara.nickward.co.uk, or the kiosk on localhost:3005. A
' shortcut cannot set an environment variable, which is exactly why the old one
' went through `cmd /c "set SARA_URL=... && npm start"` and dragged a console
' along with it. Taking it as an argument removes the reason cmd was there.
'
' Usage:
'   wscript.exe "…\SARA.vbs"                          -> main.js default (:3005)
'   wscript.exe "…\SARA.vbs" "https://sara.nickward.co.uk"
'
' Make a shortcut to that and give it `sara/desktop/sara-desktop.ico`.

Option Explicit

Dim shell, fso, here, electron, args, url

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' The directory THIS script lives in, so the launcher works from a shortcut
' anywhere without a hardcoded path.
here = fso.GetParentFolderName(WScript.ScriptFullName)

electron = fso.BuildPath(here, "node_modules\electron\dist\electron.exe")

' ⚠ Fail LOUDLY rather than silently doing nothing. A hidden launcher that
' quietly exits when the dependency is missing is indistinguishable from one
' that worked, and the whole point of this file is that there is no console to
' read an error in.
If Not fso.FileExists(electron) Then
  MsgBox "SARA cannot start: Electron is not installed." & vbCrLf & vbCrLf & _
         "Expected:" & vbCrLf & electron & vbCrLf & vbCrLf & _
         "Run 'npm install' in:" & vbCrLf & here, _
         vbCritical, "SARA"
  WScript.Quit 1
End If

' ⚠ Set on the PROCESS environment, which the child inherits. This is the whole
' trick: it does what `set SARA_URL=... &&` did in the old shortcut, without
' needing a shell to do it in. Absent, main.js falls back to its own default.
If WScript.Arguments.Count > 0 Then
  url = Trim(WScript.Arguments(0))
  If Len(url) > 0 Then
    shell.Environment("PROCESS")("SARA_URL") = url
  End If
End If

' `here` is the app directory — main.js sits beside this script.
args = """" & electron & """ """ & here & """"

' 0 = no window, False = do not wait. Both are load-bearing: 0 is why no console
' is created, False is why this script exits instead of sitting there as a
' parent process for as long as SARA is open — which is precisely what cmd.exe
' was doing.
shell.Run args, 0, False
