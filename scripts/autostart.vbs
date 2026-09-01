' PennyWise autostart: launch the hidden tray daemon at Windows logon.
' The tray keeps the ledger server alive (auto-restart on crash) and shows a tray icon.
' Stop: tray right-click -> Exit, or scripts\stop.ps1. Disable autostart: delete PennyWise.lnk in shell:startup.
' Path-independent: derives the project root from this script's own location.
Dim sh, fso, root, ps
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
ps = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
sh.Run """" & ps & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\scripts\tray.ps1""", 0, False
