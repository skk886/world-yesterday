param(
  [string]$TaskName = "WorldYesterday-CatchUp"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $projectRoot "scripts\run-controller-hidden.vbs"
$wscriptPath = Join-Path $env:WINDIR "System32\wscript.exe"
$arguments = "//B //NoLogo `"$wrapper`""
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute $wscriptPath -Argument $arguments -WorkingDirectory $projectRoot
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity
$repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 60) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logonTrigger, $repeatTrigger) -Settings $settings -Principal $principal -Description "Generate and publish missing World Yesterday editions after this PC is online." -Force | Out-Null
Write-Host "Installed scheduled task: $TaskName"
Write-Host "Hidden runner: $wrapper"
