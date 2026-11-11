# Массовая проверка ников из tj и отправка вердиктов на сервер (общий слой).
#
#   powershell -ExecutionPolicy Bypass -File tools\check-tj.ps1 -Workers 4
#
# -Workers N  — сколько окон (по умолчанию 2). Перед стартом убираются дубли и ники, уже сохранённые на сервере;
#               остальные делятся между окнами без пересечений.
# -Parallel N — сколько запросов к Arctic Shift одновременно по ВСЕМ окнам вместе (по умолчанию 2 — тот же темп,
#               что у двух окон). После 429 / «slow down» ждут все окна до сброса лимита архива.
# -Force      — перепроверить всех заново (например, после изменения правил).
# Ключ админа: из admin-key.txt, а если его нет — спросит здесь один раз (ввод скрыт, никуда не сохраняется).
param([int]$Workers = 2, [int]$Parallel = 2, [int]$Worker = -1, [string]$Shard = '', [switch]$Force)
Set-Location (Split-Path $PSScriptRoot)
$self = $MyInvocation.MyCommand.Path

if ($Worker -ge 0) {
  # Одно окно-исполнитель: своя часть из dist\crawl\plan.json
  $host.UI.RawUI.WindowTitle = "Хрюнебот: проверка, окно $($Worker + 1)"
  node tools/check-tj.mjs --worker $Worker --limit 100000 --pause 0 --parallel $Parallel
  Read-Host 'Готово. Нажмите Enter'
  exit
}
if ($Shard) {
  # Старый режим (две половины без плана)
  $host.UI.RawUI.WindowTitle = "Хрюнебот: проверка, часть $Shard"
  node tools/check-tj.mjs --resend --limit 400 --pause 2 --shard $Shard
  Read-Host 'Готово. Нажмите Enter'
  exit
}

$host.UI.RawUI.WindowTitle = 'Хрюнебот: запуск проверки'
if (-not (Test-Path admin-key.txt) -and -not $env:HRYU_ADMIN_KEY) {
  $s = Read-Host 'Ключ админа' -AsSecureString
  # Окна-исполнители наследуют переменную от этого окна; после запуска она отсюда убирается.
  $env:HRYU_ADMIN_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)).Trim()
}
try {
  if ($Force) { node tools/check-tj.mjs --plan $Workers --force } else { node tools/check-tj.mjs --plan $Workers }
  if ($LASTEXITCODE -ne 0) { throw 'план не составлен' }
  for ($i = 0; $i -lt $Workers; $i++) {
    Start-Process powershell -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $self, '-Worker', $i, '-Parallel', $Parallel
    Start-Sleep -Seconds 2
  }
  Write-Host "Запущено окон: $Workers (одновременно к архиву — не больше $Parallel запросов). Это окно можно закрыть."
} finally { Remove-Item Env:HRYU_ADMIN_KEY -ErrorAction SilentlyContinue }
Read-Host 'Нажмите Enter'