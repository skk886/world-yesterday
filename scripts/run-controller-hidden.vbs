Option Explicit

Dim shell, fileSystem, scriptDirectory, runner, powerShellPath, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
runner = fileSystem.BuildPath(scriptDirectory, "run-controller.ps1")
powerShellPath = shell.ExpandEnvironmentStrings("%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = Chr(34) & powerShellPath & Chr(34) & _
  " -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
  Chr(34) & runner & Chr(34)

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
