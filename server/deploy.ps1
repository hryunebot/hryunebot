# Деплой сервера Reddit Tagger на бесплатный Cloudflare Workers.
# Запуск из папки server:  powershell -ExecutionPolicy Bypass -File deploy.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path node_modules)) { npm install --no-fund --no-audit }

# 1. Вход в Cloudflare (откроется браузер, нужно нажать Allow)
$who = npx wrangler whoami 2>&1 | Out-String
if ($who -match 'not authenticated') { npx wrangler login }

# 2. База D1
$toml = Get-Content wrangler.toml -Raw
if ($toml -match 'REPLACE_ME') {
  $list = npx wrangler d1 list --json 2>$null | Out-String
  $db = ($list | ConvertFrom-Json) | Where-Object { $_.name -eq 'reddit-tagger' } | Select-Object -First 1
  if ($db) { $id = $db.uuid }
  else {
    $out = npx wrangler d1 create reddit-tagger 2>&1 | Out-String
    Write-Host $out
    if ($out -match '"?database_id"?\s*[=:]\s*"([0-9a-f-]{36})"') { $id = $Matches[1] } else { throw 'Не удалось узнать id базы' }
  }
  ($toml -replace 'REPLACE_ME', $id) | Set-Content wrangler.toml -Encoding utf8
  Write-Host "База: $id"
}

# 3. Таблицы
npx wrangler d1 execute reddit-tagger --remote --file schema.sql --yes

# 4. Сам сервер
$dep = npx wrangler deploy 2>&1 | Out-String
Write-Host $dep
if ($dep -match '(https://[a-z0-9.-]+\.workers\.dev)') {
  Write-Host "`nГОТОВО. Адрес сервера: $($Matches[1])" -ForegroundColor Green
  Write-Host 'Вставьте его в расширении: значок -> вкладка «Группа».'
}
