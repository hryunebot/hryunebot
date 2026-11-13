# Собирает установщики в dist\:
#   Hryunebot-Setup.exe        — программа-установщик с окном и хрюнеботом (C#, компилятор встроен в Windows)
#   hryunebot-linux.sh         — установщик для Linux (sh-скрипт, расширение внутри)
#   SHA256.txt                 — контрольные суммы, чтобы проверить, что файл не подменили
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$out = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force $out | Out-Null

# Собираем во временной папке: в dist может лежать распакованная и открытая копия — её не трогаем.
$tmp = Join-Path $env:TEMP ('hryu-build-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
$stage = Join-Path $tmp 'stage'
New-Item -ItemType Directory -Force $stage | Out-Null
$utf8bom = New-Object System.Text.UTF8Encoding $true

# 1. Само расширение — в zip (без README)
$ext = Join-Path $tmp 'ext'
Copy-Item -Recurse reddit-tagger $ext
Remove-Item (Join-Path $ext 'README.md') -ErrorAction SilentlyContinue
$payload = Join-Path $stage 'hryunebot.zip'
# Собираем zip вручную: Compress-Archive в PowerShell 5.1 пишет пути с «\», а Linux и Firefox такие пути не понимают.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
function New-Zip([string]$dir, [string]$zipPath) {
  $zs = [IO.File]::Open($zipPath, [IO.FileMode]::Create)
  $z = New-Object IO.Compression.ZipArchive($zs, [IO.Compression.ZipArchiveMode]::Create)
  $base = (Resolve-Path $dir).Path.TrimEnd('\') + '\'
  foreach ($f in Get-ChildItem -Recurse -File $dir | Sort-Object FullName) {
    $name = $f.FullName.Substring($base.Length).Replace('\', '/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $f.FullName, $name, [IO.Compression.CompressionLevel]::Optimal)
  }
  $z.Dispose(); $zs.Dispose()
}
New-Zip $ext $payload
$hash = (Get-FileHash -Algorithm SHA256 $payload).Hash.ToLower()

# 1б. Firefox: те же файлы, но свой манифест (firefox\manifest.json, версия — из основного).
#     dist\firefox\ — распакованная версия (для web-ext lint/sign), dist\hryunebot-firefox-unsigned.xpi — архив.
$version = (Get-Content reddit-tagger\manifest.json -Raw -Encoding utf8 | ConvertFrom-Json).version
$ffDir = Join-Path $out 'firefox'
if (Test-Path $ffDir) { Remove-Item -Recurse -Force $ffDir }
Copy-Item -Recurse $ext $ffDir
$ffManifest = [IO.File]::ReadAllText((Resolve-Path firefox\manifest.json)).Replace('__VERSION__', $version)
[IO.File]::WriteAllText((Join-Path $ffDir 'manifest.json'), $ffManifest, (New-Object System.Text.UTF8Encoding $false))
New-Zip $ffDir (Join-Path $out 'hryunebot-firefox-unsigned.xpi')

# 1в. Подписанная Mozilla версия: dist\hryunebot-firefox.xpi (кладёт sign-firefox.ps1).
#     Берём её, только если она действительно подписана и той же версии; иначе — неподписанная (только временная установка).
$ffSignedPath = Join-Path $out 'hryunebot-firefox.xpi'
$ffXpi = Join-Path $out 'hryunebot-firefox-unsigned.xpi'
$ffSigned = 0
if (Test-Path $ffSignedPath) {
  $a = [IO.Compression.ZipFile]::OpenRead($ffSignedPath)
  try {
    $e = $a.GetEntry('manifest.json'); $r = New-Object IO.StreamReader($e.Open())
    $signedVer = ($r.ReadToEnd() | ConvertFrom-Json).version; $r.Dispose()
    $isSigned = [bool]($a.Entries | Where-Object { $_.FullName -like 'META-INF/*' })
  } finally { $a.Dispose() }
  if ($isSigned) {
    $ffXpi = $ffSignedPath; $ffSigned = 1
    # Старая подписанная версия лучше, чем никакой: Firefox продолжает ставиться насовсем, но без свежих правок.
    if ($signedVer -ne $version) { Write-Warning "Firefox получит подписанную версию $signedVer, а текущая — $version. Подпишите заново (sign-firefox.ps1), чтобы Firefox получил свежие правки." }
  } else { Write-Warning "dist\hryunebot-firefox.xpi не подписан — Firefox в установщиках будет только временно." }
}
$ffHash = (Get-FileHash -Algorithm SHA256 $ffXpi).Hash.ToLower()

# 1г. Логика проверки для сервера (автоочередь, 1.3.91): server\src\check.gen.js из того же score.js/background.js
node tools\gen-server-check.mjs

# 2. EXE: компилируем installer\Setup.cs встроенным csc (.NET Framework 4.x есть в Windows 10/11).
#    Внутрь кладём расширение, картинку хрюнебота, подписанную версию для Firefox (если есть) и их контрольные суммы.
$csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
$hashCs = Join-Path $tmp 'PayloadHash.cs'
$ffConst = if ($ffSigned) { $ffHash } else { '' }
# Версия — в окне установщика и в свойствах файла (Подробно → Версия продукта).
# Описание файла/автор (11.11.2026): без них эвристики антивирусов (4 из ~70 на VirusTotal) сильнее подозревают «безымянный» exe.
[IO.File]::WriteAllText($hashCs, "[assembly: System.Reflection.AssemblyVersion(`"$version.0`")]`n[assembly: System.Reflection.AssemblyFileVersion(`"$version.0`")]`n[assembly: System.Reflection.AssemblyInformationalVersion(`"$version`")]`n[assembly: System.Reflection.AssemblyProduct(`"Hryunebot`")]`n[assembly: System.Reflection.AssemblyTitle(`"Hryunebot Setup`")]`n[assembly: System.Reflection.AssemblyDescription(`"Hryunebot browser extension installer for Reddit (Chrome, Edge, Opera, Brave, Vivaldi, Firefox). No network access.`")]`n[assembly: System.Reflection.AssemblyCompany(`"Hryunebot`")]`n[assembly: System.Reflection.AssemblyCopyright(`"Hryunebot, 2026`")]`nstatic partial class Payload { public const string Sha256 = `"$hash`"; public const string FirefoxSha256 = `"$ffConst`"; public const string Version = `"$version`"; }", $utf8bom)
$exeTmp = Join-Path $tmp 'Hryunebot-Setup.exe'
$fw = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319"
$cscArgs = @(
  '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/codepage:65001',
  "/out:$exeTmp",
  "/win32icon:$((Resolve-Path installer\hryunebot.ico).Path)",
  "/resource:$payload,hryunebot.zip",
  "/resource:$((Resolve-Path installer\pig.png).Path),pig.png",
  '/r:System.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
  "/r:$fw\System.IO.Compression.dll",
  (Resolve-Path installer\Setup.cs).Path, $hashCs
)
# Неподписанную версию в exe не кладём: в Firefox на Windows она бы ставилась только до перезапуска.
if ($ffSigned) { $cscArgs = @("/resource:$ffXpi,hryunebot-firefox.xpi") + $cscArgs }
$log = & $csc @cscArgs 2>&1 | Out-String
if (-not (Test-Path $exeTmp)) { throw "csc не собрал exe:`n$log" }
# Имя файла с версией: Hryunebot-Setup-1.3.51.exe (старые установщики в dist убираем, чтобы не путаться).
$exeName = "Hryunebot-Setup-$version.exe"
Get-ChildItem $out -Filter 'Hryunebot-Setup*.exe' | Where-Object { $_.Name -ne $exeName } | Remove-Item -ErrorAction SilentlyContinue
try { Copy-Item $exeTmp (Join-Path $out $exeName) -Force -ErrorAction Stop }
catch { Write-Warning "$exeName занят (открыт установщик?) — оставляю старый, остальное собираю." }

# 3. Linux (универсальный): installer\linux.sh + обе версии base64-хвостом. Строки только LF, UTF-8 без BOM.
function To-B64Lines([string]$path) {
  $b = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
  $(for ($i = 0; $i -lt $b.Length; $i += 76) { $b.Substring($i, [Math]::Min(76, $b.Length - $i)) }) -join "`n"
}
$sh = [IO.File]::ReadAllText((Resolve-Path installer\linux.sh)).Replace("`r`n", "`n").
  Replace('__CHROMIUM_SHA256__', $hash).Replace('__FIREFOX_SHA256__', $ffHash).Replace('__FIREFOX_SIGNED__', "$ffSigned")
if (-not $sh.EndsWith("__PAYLOAD_CHROMIUM__`n")) { throw 'linux.sh должен заканчиваться строкой __PAYLOAD_CHROMIUM__' }
$shOut = $sh + (To-B64Lines $payload) + "`n__PAYLOAD_FIREFOX__`n" + (To-B64Lines $ffXpi) + "`n"
[IO.File]::WriteAllText((Join-Path $out 'hryunebot-linux.sh'), $shOut, (New-Object System.Text.UTF8Encoding $false))
Write-Host ("Linux-установщик: Firefox-версия " + $(if ($ffSigned) { 'ПОДПИСАННАЯ' } else { 'неподписанная (только временная установка)' }))

# 3б. Windows без .exe (владелец, 11.11.2026): на .exe 6 из ~70 антивирусов ругались по эвристике (неподписанный
#     «дроппер»). dist\Hryunebot-Windows.zip: папка hryunebot\, подписанный .xpi, текстовый INSTALL.cmd (копирует папку
#     в %LOCALAPPDATA%\Hryunebot и открывает страницу расширений) и README-Windows.txt. Имена в архиве — латиницей.
$win = Join-Path $tmp 'win'
New-Item -ItemType Directory -Force $win | Out-Null
Copy-Item -Recurse $ext (Join-Path $win 'hryunebot')
if ($ffSigned) { Copy-Item $ffXpi (Join-Path $win 'hryunebot-firefox.xpi') }
Copy-Item installer\INSTALL.cmd (Join-Path $win 'INSTALL.cmd')
Copy-Item installer\README-Windows.txt (Join-Path $win 'README-Windows.txt')
$winZip = Join-Path $out 'Hryunebot-Windows.zip'
New-Zip $win $winZip

# 3в. macOS (владелец, 13.11.2026): dist\Hryunebot-macOS.zip — папка hryunebot\, подписанный .xpi, INSTALL.command (bash,
#     только LF) и README-macOS.txt. Запуск — «bash ~/Downloads/Hryunebot-macOS/INSTALL.command» (двойной клик macOS блокирует).
$mac = Join-Path $tmp 'mac'
New-Item -ItemType Directory -Force $mac | Out-Null
Copy-Item -Recurse $ext (Join-Path $mac 'hryunebot')
if ($ffSigned) { Copy-Item $ffXpi (Join-Path $mac 'hryunebot-firefox.xpi') }
$cmdTxt = [IO.File]::ReadAllText((Resolve-Path installer\mac.command)).Replace("`r`n", "`n")
[IO.File]::WriteAllText((Join-Path $mac 'INSTALL.command'), $cmdTxt, (New-Object System.Text.UTF8Encoding $false))
Copy-Item installer\README-macOS.txt (Join-Path $mac 'README-macOS.txt')
$macZip = Join-Path $out 'Hryunebot-macOS.zip'
New-Zip $mac $macZip

# 4. Контрольные суммы (укр. / рус.)
$exeHash = (Get-FileHash -Algorithm SHA256 (Join-Path $out $exeName)).Hash.ToLower()
$shHash = (Get-FileHash -Algorithm SHA256 (Join-Path $out 'hryunebot-linux.sh')).Hash.ToLower()
$winHash = (Get-FileHash -Algorithm SHA256 $winZip).Hash.ToLower()
$macHash = (Get-FileHash -Algorithm SHA256 $macZip).Hash.ToLower()
$sums = @(
  "$winHash  Hryunebot-Windows.zip",
  "$macHash  Hryunebot-macOS.zip",
  "$exeHash  $exeName",
  "$shHash  hryunebot-linux.sh",
  "$ffHash  $(Split-Path $ffXpi -Leaf)",
  "розширення всередині / расширение внутри (hryunebot.zip): $hash"
)
[IO.File]::WriteAllText((Join-Path $out 'SHA256.txt'), ($sums -join "`r`n") + "`r`n", $utf8bom)

# 5. Страница «завантажити» на нашем сервере (владелец, 11.11.2026): server\public\download\files\ — постоянные имена.
#    Кладём ТОЛЬКО полностью свежий набор: Firefox подписан Mozilla и той же версии. Иначе страницу не трогаем
#    (лучше старая подписанная раздача, чем неподписанный xpi или установщики разных версий).
#    Выкладка: cd server; npx wrangler deploy (файлы в git не идут — .gitignore).
$dl = Join-Path $PSScriptRoot 'server\public\download\files'
if ($ffSigned -and $signedVer -eq $version) {
  if (Test-Path $dl) { Remove-Item -Recurse -Force $dl }
  New-Item -ItemType Directory -Force $dl | Out-Null
  # .exe на страницу больше не кладём (эвристики антивирусов) — вместо него zip с INSTALL.cmd
  Copy-Item $winZip (Join-Path $dl 'Hryunebot-Windows.zip')
  Copy-Item $macZip (Join-Path $dl 'Hryunebot-macOS.zip')
  Copy-Item (Join-Path $out 'hryunebot-linux.sh') (Join-Path $dl 'hryunebot-linux.sh')
  Copy-Item $ffXpi (Join-Path $dl 'hryunebot-firefox.xpi')
  $info = [ordered]@{ version = $version; built = (Get-Date).ToString('yyyy-MM-dd');
    sha256 = [ordered]@{ 'Hryunebot-Windows.zip' = $winHash; 'Hryunebot-macOS.zip' = $macHash; 'hryunebot-linux.sh' = $shHash; 'hryunebot-firefox.xpi' = $ffHash } }
  [IO.File]::WriteAllText((Join-Path $dl 'version.json'), ($info | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
  # Страница с версией и SHA-256 той же сборки — видны без JavaScript (шаблон installer\download-page.html)
  $page = [IO.File]::ReadAllText((Resolve-Path installer\download-page.html)).
    Replace('{{VERSION}}', $version).Replace('{{BUILT}}', $info.built).
    Replace('{{SHA_XPI}}', $ffHash).Replace('{{SHA_ZIP}}', $winHash).Replace('{{SHA_MAC}}', $macHash).Replace('{{SHA_SH}}', $shHash)
  $page = $page -replace '^<!--[\s\S]*?-->\r?\n', ''   # служебный комментарий шаблона на сайт не идёт
  if ($page -match '\{\{') { throw 'download-page.html: остались незаполненные {{…}}' }
  [IO.File]::WriteAllText((Join-Path (Split-Path $dl) 'index.html'), $page, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Страница «завантажити»: файлы $version положены в server\public\download\files (выложить: cd server; npx wrangler deploy)"
} else {
  Write-Warning "Страница «завантажити» НЕ обновлена: Firefox не подписан или подписан не $version. Сначала sign-firefox.ps1, потом сборка заново."
}

Remove-Item -Recurse -Force $tmp
Get-ChildItem $out -File | Select-Object Name, Length
