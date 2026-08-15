' PennyWise desktop launcher: start the ledger server hidden, then open the web page.
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\qq\PennyWise"
sh.Run """C:\Program Files\nodejs\node.exe"" ""E:\qq\PennyWise\server\index.js""", 0, False
WScript.Sleep 1500
sh.Run "http://localhost:8720"
