' PennyWise desktop launcher: ensure the tray daemon is running, then open the web page.
' Path-independent: derives the project root from this script's own location (works after moving the folder).
Dim sh, fso, root, ps
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
ps = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
sh.Run """" & ps & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\scripts\tray.ps1""", 0, False
WScript.Sleep 2500
sh.Run "http://localhost:8720"
