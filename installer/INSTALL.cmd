@echo off
chcp 65001 >nul
setlocal
title Hryunebot
rem Хрюнебот — установка для Windows (Chrome, Edge, Brave, Opera, Vivaldi, Firefox).
rem Звичайний текстовий скрипт: відкрийте блокнотом і побачите все, що він робить.
rem Обычный текстовый скрипт: откройте блокнотом и увидите всё, что он делает.
rem Що робить / что делает: копіює папку hryunebot у %LOCALAPPDATA%\Hryunebot і відкриває сторінку розширень браузера.
rem Без прав адміністратора, без інтернету, нічого не завантажує / без прав администратора, без интернета.

set "SRC=%~dp0hryunebot"
set "DST=%LOCALAPPDATA%\Hryunebot"
set "XPI=%~dp0hryunebot-firefox.xpi"

if not exist "%SRC%\manifest.json" (
  echo.
  echo  Спочатку розпакуйте архів: правою кнопкою по zip - "Видобути все", потім запустіть INSTALL.cmd з розпакованої папки.
  echo  Сначала распакуйте архив: правой кнопкой по zip - "Извлечь все", потом запустите INSTALL.cmd из распакованной папки.
  echo.
  pause
  exit /b 1
)

echo.
echo  Хрюнебот: копіюю розширення / копирую расширение...
if exist "%DST%" rmdir /s /q "%DST%"
xcopy "%SRC%" "%DST%\" /e /i /q /y >nul
if not exist "%DST%\manifest.json" (
  echo  Не вдалося скопіювати / не удалось скопировать в "%DST%".
  pause
  exit /b 1
)
echo  Готово: %DST%
echo.
echo  Виберіть браузер / выберите браузер:
echo    1 - Chrome      2 - Edge      3 - Brave
echo    4 - Opera       5 - Vivaldi   6 - Firefox
echo    0 - вихід / выход
choice /c 1234560 /n /m " > "
set "N=%errorlevel%"
if "%N%"=="7" exit /b 0
if "%N%"=="6" goto firefox

if "%N%"=="1" set "EXE=chrome"  & set "URL=chrome://extensions"
if "%N%"=="2" set "EXE=msedge"  & set "URL=edge://extensions"
if "%N%"=="3" set "EXE=brave"   & set "URL=brave://extensions"
if "%N%"=="4" set "EXE=opera"   & set "URL=chrome://extensions"
if "%N%"=="5" set "EXE=vivaldi" & set "URL=vivaldi://extensions"
if not defined EXE exit /b 1
start "" %EXE% "%URL%" 2>nul || echo  Відкрийте браузер вручну і вставте в адресний рядок / откройте вручную: %URL%
echo.
echo  У браузері / в браузере:
echo   1. Увімкніть "Режим розробника" / включите "Режим разработчика".
echo   2. "Завантажити розпаковане" / "Загрузить распакованное".
echo   3. Виберіть папку / выберите папку:  %DST%
echo   4. Закріпіть значок Хрюнебота біля адресного рядка / закрепите значок у адресной строки.
echo.
pause
exit /b 0

:firefox
start "" firefox "%XPI%" 2>nul || echo  Відкрийте файл hryunebot-firefox.xpi у Firefox вручну / откройте вручную.
echo.
echo  Firefox спитає "Додати Хрюнебот?" - натисніть "Додати" / нажмите "Добавить".
echo.
pause
exit /b 0