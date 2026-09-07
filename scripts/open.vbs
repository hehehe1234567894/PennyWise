' PennyWise desktop launcher (fast path first): if the server is already running, open the
' page right away (~0.5s). Only when it is down do we start node DIRECTLY from here (no
' PowerShell hop) with hidden console + append logs + V8 compile cache, then wait for ready.
' Ghost mode: no tray, no boot autostart. Stop: the "PennyWise 停止" shortcut or stop.ps1.
' Path-independent: derives the project root from this script's own location.
Dim sh, fso, root, nodeExe, outLog, errLog, qt
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"
outLog = root & "\data\logs\server.out.log"
errLog = root & "\data\logs\server.err.log"
qt = """"

Function HealthOK()
  On Error Resume Next
  Dim c
  Set c = CreateObject("MSXML2.XMLHTTP")
  c.Open "GET", "http://localhost:8720/api/health", False
  c.Send
  If Err.Number = 0 And c.Status = 200 Then HealthOK = True Else HealthOK = False
  On Error Goto 0
End Function

If Not HealthOK() Then
  ' cold start: V8 compile cache makes every later boot skip recompiling dependencies
  sh.Environment("Process")("NODE_COMPILE_CACHE") = root & "\data\compile-cache"
  ' cmd /c "<quoted node>" <quoted script> >> <quoted out> 2>> <quoted err>  (hidden, async)
  Dim inner
  inner = qt & nodeExe & qt & " " & qt & root & "\server\index.js" & qt & _
          " >> " & qt & outLog & qt & " 2>> " & qt & errLog & qt
  sh.Run "cmd /c " & qt & inner & qt, 0, False
  Dim i
  For i = 1 To 60
    If HealthOK() Then Exit For
    WScript.Sleep 300
  Next
End If
sh.Run "http://localhost:8720"
