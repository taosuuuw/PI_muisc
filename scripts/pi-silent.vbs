' PI silent launcher: used by the desktop shortcut. No console window is shown.
' It runs PI.cmd hidden, appends everything to pi-launch.log, and pops a message if it fails.
'
' NOTE: keep this file pure ASCII. WSH reads .vbs as ANSI; a UTF-8 BOM or CJK text here
'       shows up as "Invalid character" in a modal dialog -- and a hidden dialog means the
'       shortcut silently does nothing. All Chinese product text lives in the app instead.
Option Explicit

Dim shell, fso, root, cmd, logPath, rc, q, f, stamp
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
q = Chr(34)

' Tell PI.cmd not to wait for a keypress: in a hidden window nobody can press one,
' and a stuck launcher would hold the log file open for the rest of the session.
shell.Environment("PROCESS")("PI_SILENT") = "1"

' Pick a log file we can actually open. A previous launch may still be holding
' pi-launch.log open (cmd keeps its redirect handle for the whole run), and if the
' redirect target cannot be opened, cmd fails before it ever runs PI.cmd -- which is
' exactly the "double-click does nothing" symptom. So fall back to a dated name.
logPath = root & "\pi-launch.log"
If Not CanAppend(logPath) Then
  stamp = Replace(Replace(Replace(Now, "/", "-"), ":", ""), " ", "_")
  logPath = root & "\pi-launch-" & stamp & ".log"
End If

On Error Resume Next
Set f = fso.OpenTextFile(logPath, 8, True)
If Err.Number = 0 Then
  f.WriteLine "[" & Now & "] starting PI from " & root
  f.Close
End If
Err.Clear

shell.CurrentDirectory = root
' cmd /c ""<repo>\PI.cmd" >> "<repo>\pi-launch.log" 2>&1"
cmd = "cmd /c " & q & q & root & "\PI.cmd" & q & " >> " & q & logPath & q & " 2>&1" & q
rc = shell.Run(cmd, 0, True)
If Err.Number <> 0 Then
  MsgBox "PI could not be started:" & vbCrLf & vbCrLf & Err.Description, 16, "PI"
  WScript.Quit 2
End If
On Error GoTo 0

If rc <> 0 Then
  On Error Resume Next
  Set f = fso.OpenTextFile(logPath, 8, True)
  If Err.Number = 0 Then
    f.WriteLine "[" & Now & "] launch failed, exit code " & rc
    f.Close
  End If
  Err.Clear
  MsgBox "PI failed to start (exit code " & rc & ")." & vbCrLf & vbCrLf & _
         "Log: " & logPath & vbCrLf & vbCrLf & _
         "If dependencies are missing, run 'pnpm install' and 'pnpm electron:install' in the project folder.", _
         16, "PI"
End If

' True when <path> can be opened for appending (creating it if needed).
Function CanAppend(path)
  Dim t
  On Error Resume Next
  Set t = fso.OpenTextFile(path, 8, True)
  CanAppend = (Err.Number = 0)
  If Err.Number = 0 Then t.Close
  Err.Clear
  On Error GoTo 0
End Function
