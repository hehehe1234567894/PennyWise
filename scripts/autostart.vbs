' PennyWise autostart: launch the ledger server hidden at Windows logon.
' To stop: run scripts\stop.ps1. To disable autostart: delete PennyWise.vbs in the Startup folder.
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\qq\PennyWise"
sh.Run """C:\Program Files\nodejs\node.exe"" ""E:\qq\PennyWise\server\index.js""", 0, False
