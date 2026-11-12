# 真机验证：计划任务注册 + 启动 + 控制台窗口可见性探测
# 用法：powershell -ExecutionPolicy Bypass -File test/real-task-test.ps1
param(
  [string]$Base = 'http://127.0.0.1:18778',
  [string]$Token = 'realtoken-abcdefghij',
  [string]$DataDir = (Join-Path (Split-Path -Parent $PSScriptRoot) '.sm-real')
)

$ErrorActionPreference = 'Stop'
$hdr = @{ Authorization = "Bearer $Token"; 'X-SM-Request' = '1' }

function PostJson([string]$path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  Invoke-RestMethod -Uri "$Base$path" -Method Post -Headers $hdr `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
}

$name = '窗口可见性测试'

Write-Host "=== 1. 通过 API 创建项目 ===" -ForegroundColor Cyan
$res = PostJson '/api/items' @{
  name    = $name
  kind    = 'powershell'
  command = 'Write-Host "窗口测试开始"; Start-Sleep -Seconds 90'
  trigger = @{ delaySeconds = 0 }
  console = @{ keepOpen = $true }
  enabled = $true
}
$id = $res.item.id
Write-Host "项目 ID      : $id"
Write-Host "任务状态     : $($res.item.task.state)"
Write-Host "漂移         : $($res.item.drift)"
Write-Host "taskError    : $($res.taskError)"

Write-Host "`n=== 2. 任务 XML 关键字段 ===" -ForegroundColor Cyan
$xml = [xml](Export-ScheduledTask -TaskPath '\StartupManager\' -TaskName $id)
Write-Host "LogonType          : $($xml.Task.Principals.Principal.LogonType)"
Write-Host "RunLevel           : $($xml.Task.Principals.Principal.RunLevel)"
Write-Host "Hidden             : $($xml.Task.Settings.Hidden)"
Write-Host "ExecutionTimeLimit : $($xml.Task.Settings.ExecutionTimeLimit)"
Write-Host "DisallowOnBattery  : $($xml.Task.Settings.DisallowStartIfOnBatteries)"
Write-Host "StopOnBattery      : $($xml.Task.Settings.StopIfGoingOnBatteries)"
Write-Host "MultipleInstances  : $($xml.Task.Settings.MultipleInstancesPolicy)"
Write-Host "TriggerDelay       : $($xml.Task.Triggers.LogonTrigger.Delay)"
Write-Host "TriggerUser        : $($xml.Task.Triggers.LogonTrigger.UserId)"
Write-Host "Command            : $($xml.Task.Actions.Exec.Command)"
Write-Host "Arguments          : $($xml.Task.Actions.Exec.Arguments)"

Write-Host "`n=== 3. 启动任务并探测窗口 ===" -ForegroundColor Cyan
Start-ScheduledTask -TaskPath '\StartupManager\' -TaskName $id
Start-Sleep -Seconds 6

$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$id*" })
Write-Host "相关进程数: $($procs.Count)"
foreach ($p in $procs) {
  $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  Write-Host ("  PID {0,-6} {1,-14} handle={2,-10} title='{3}'" -f $p.ProcessId, $p.Name, $gp.MainWindowHandle, $gp.MainWindowTitle)
}

$byTitle = @(Get-Process | Where-Object { $_.MainWindowTitle -eq $name })
Write-Host "按标题匹配到的可见窗口数: $($byTitle.Count)"
foreach ($w in $byTitle) { Write-Host ("  #{0} {1} handle={2}" -f $w.Id, $w.ProcessName, $w.MainWindowHandle) }

$visible = ($procs | Where-Object {
    $gp = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    $gp -and $gp.MainWindowHandle -ne 0
  }).Count -gt 0

Write-Host ""
if ($byTitle.Count -gt 0 -or $visible) {
  Write-Host "结果：控制台窗口可见 ✔" -ForegroundColor Green
} else {
  Write-Host "结果：未探测到可见窗口 ✘" -ForegroundColor Red
}

Write-Host "`n=== 4. 清理 ===" -ForegroundColor Cyan
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Invoke-RestMethod -Uri "$Base/api/items/$id" -Method Delete -Headers $hdr | Out-Null
$left = Get-ScheduledTask -TaskPath '\StartupManager\' -TaskName $id -ErrorAction SilentlyContinue
Write-Host "残留任务: $([bool]$left)"
