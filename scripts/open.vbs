' PennyWise desktop launcher: make sure the ledger server is running, then open the page.
' Ghost mode: no tray daemon, no boot autostart. Stop: the "PennyWise 停止" desktop
' shortcut, or scripts\stop.ps1. Path-independent: derives the project root from this
' script's own location (works after moving the folder).
Dim sh, fso, root, ps
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
ps = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
' Start (no-op if already running; double-start safe)
sh.Run """" & ps & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\scripts\ensure-server.ps1""", 0, True
' Wait up to 15s for the server to answer /api/health, then open the page
Dim i, up, c
up = False
For i = 1 To 30
  On Error Resume Next
  Set c = CreateObject("MSXML2.XMLHTTP")
  c.Open "GET", "http://localhost:8720/api/health", False
  c.Send
  If Err.Number = 0 And c.Status = 200 Then up = True
  On Error Goto 0
  If up Then Exit For
  WScript.Sleep 500
Next
sh.Run "http://localhost:8720"
