# Подпись Firefox-версии Хрюнебота у Mozilla (бесплатно, без публикации в магазине — канал «unlisted»).
#
# Один раз:
#   1. Зарегистрируйтесь на https://addons.mozilla.org (вход через аккаунт Mozilla).
#   2. Откройте https://addons.mozilla.org/developers/addon/api/key/ и нажмите «Generate new credentials».
#      Там будут «JWT issuer» (вида user:12345:67) и «JWT secret».
# Потом в папке проекта:
#   powershell -ExecutionPolicy Bypass -File sign-firefox.ps1
# Скрипт спросит ключи (не показывает их и никуда не сохраняет), отправит dist\firefox на подпись
# (обычно несколько минут), положит результат в dist\hryunebot-firefox.xpi и пересоберёт установщики.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path dist\firefox\manifest.json)) {
  Write-Host 'Сначала собираю Firefox-версию...'
  powershell -NoProfile -ExecutionPolicy Bypass -File .\build-installer.ps1 | Out-Null
}

do { $issuer = (Read-Host 'JWT issuer').Trim() } while (-not $issuer)
# Секрет не показывается при вводе; пустой (Enter без вставки) — спрашиваем снова.
# Вставка: правый клик мышью или Ctrl+V, потом Enter.
do {
  $secretSecure = Read-Host 'JWT secret (вставьте и нажмите Enter, символы не видны)' -AsSecureString
  $secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretSecure)).Trim()
  if (-not $secret) { Write-Host 'Секрет пустой — вставка не сработала. Попробуйте правый клик мышью, потом Enter.' -ForegroundColor Yellow }
} while (-not $secret)
Write-Host "Секрет получен ($($secret.Length) символов; обычно 64)."

# Ключи — только через переменные окружения этого процесса (не в командной строке и не в файлах).
$issuer = $issuer.Trim()
# Частая ошибка при копировании: теряется начало «user:». Дописываем сами.
if ($issuer -match '^\d+:\d+$') { $issuer = 'user:' + $issuer; Write-Host "Дописал в issuer начало: $issuer" }
$env:WEB_EXT_API_KEY = $issuer
$env:WEB_EXT_API_SECRET = $secret.Trim()
$signed = Join-Path $PSScriptRoot 'dist\signed'
New-Item -ItemType Directory -Force $signed | Out-Null
$version = (Get-Content dist\firefox\manifest.json -Raw -Encoding utf8 | ConvertFrom-Json).version
$log = Join-Path $PSScriptRoot 'dist\sign-log.txt'
$started = Get-Date
Write-Host "Отправляю версию $version на подпись (ответ Mozilla пишется в dist\sign-log.txt)..."
try {
  # Ключи в лог не попадают: они только в переменных окружения, web-ext их не печатает.
  # web-ext пишет обычный ход работы в stderr; PowerShell 5.1 со «Stop» считал бы это ошибкой и обрывал скрипт.
  $ErrorActionPreference = 'Continue'
  npx --yes web-ext@8 sign --channel=unlisted --source-dir dist\firefox --artifacts-dir $signed --approval-timeout 900000 2>&1 |
    ForEach-Object { "$_" } | Tee-Object -FilePath $log
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
} finally {
  Remove-Item Env:WEB_EXT_API_KEY, Env:WEB_EXT_API_SECRET -ErrorAction SilentlyContinue
  $secret = $null
}

# Берём только файл, полученный именно в этом запуске и именно этой версии — не старый из прошлого раза.
$xpi = Get-ChildItem $signed -Filter "*-$version.xpi" | Where-Object { $_.LastWriteTime -ge $started } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $xpi) {
  Write-Host ''
  Write-Host "Mozilla НЕ подписала версию $version (код $code). Причина — в сообщениях выше и в dist\sign-log.txt." -ForegroundColor Red
  Read-Host 'Нажмите Enter'
  exit 1
}
Copy-Item $xpi.FullName dist\hryunebot-firefox.xpi -Force
Write-Host "Подписано: dist\hryunebot-firefox.xpi" -ForegroundColor Green

Write-Host 'Пересобираю установщики с подписанной версией...'
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-installer.ps1
Read-Host 'Готово. Нажмите Enter'
