' Starts the PackingProof inner-mismatch panel without a console window.
' Used by the autostart shortcut and by the panel's "restart" action.
' ASCII only.
Option Explicit

Dim shell, fso, base, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
command = "cmd /c " & Chr(34) & base & "\start.cmd" & Chr(34)

' 0 = hidden window, False = do not wait
shell.Run command, 0, False
