#!/bin/bash
# Хрюнебот — установка для macOS (Chrome, Brave, Edge, Opera, Vivaldi, Firefox).
# Звичайний текстовий скрипт: відкрийте його в TextEdit і побачите все, що він робить.
# Обычный текстовый скрипт: откройте его в TextEdit и увидите всё, что он делает.
# Запуск (Термінал / Терминал):  bash ~/Downloads/Hryunebot-macOS/INSTALL.command
# Що робить / что делает: копіює папку hryunebot у ~/Hryunebot, кладе шлях у буфер обміну і відкриває сторінку
# розширень вибраного браузера (для Firefox — підписаний Mozilla файл .xpi). Без sudo, без інтернету.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/hryunebot"
DST="$HOME/Hryunebot"
XPI="$HERE/hryunebot-firefox.xpi"

if [ ! -f "$SRC/manifest.json" ]; then
  echo
  echo " Спочатку розпакуйте архів (подвійний клік по zip), потім запустіть цей скрипт з розпакованої папки."
  echo " Сначала распакуйте архив (двойной щелчок по zip), потом запустите этот скрипт из распакованной папки."
  exit 1
fi

echo
echo " Хрюнебот: копіюю розширення / копирую расширение..."
rm -rf "$DST"
cp -R "$SRC" "$DST" || { echo " Не вдалося скопіювати / не удалось скопировать в $DST"; exit 1; }
[ -f "$DST/manifest.json" ] || { echo " Не вдалося скопіювати / не удалось скопировать в $DST"; exit 1; }
printf '%s' "$DST" | pbcopy 2>/dev/null
echo " Готово: $DST  (шлях уже в буфері обміну / путь уже в буфере обмена)"
echo
echo " Виберіть браузер / выберите браузер:"
echo "   1 - Chrome      2 - Brave       3 - Edge"
echo "   4 - Opera       5 - Vivaldi     6 - Firefox"
echo "   0 - вихід / выход"
printf " > "
read -r N

# Браузер на Chromium открываем его же исполняемым файлом: если он уже запущен, адрес уйдёт в открытое окно.
# (macOS «open» не понимает адреса вида chrome://; Opera внутренние адреса из командной строки не открывает,
#  а chrome://extensions понимает как свою страницу — как в установщике для Windows.)
run() { # $1 — приложение, $2 — исполняемый файл внутри, $3 — адрес страницы расширений
  local bin="/Applications/$1.app/Contents/MacOS/$2"
  [ -x "$bin" ] || bin="$HOME/Applications/$1.app/Contents/MacOS/$2"
  if [ -x "$bin" ]; then "$bin" "$3" >/dev/null 2>&1 &
  else echo " $1 не знайдено / не найден. Відкрийте браузер вручну / откройте вручную: $3"; fi
}
case "$N" in
  1) run "Google Chrome" "Google Chrome" "chrome://extensions" ;;
  2) run "Brave Browser" "Brave Browser" "brave://extensions" ;;
  3) run "Microsoft Edge" "Microsoft Edge" "edge://extensions" ;;
  4) run "Opera" "Opera" "chrome://extensions" ;;
  5) run "Vivaldi" "Vivaldi" "vivaldi://extensions" ;;
  6)
    if [ -f "$XPI" ]; then open -a Firefox "$XPI" 2>/dev/null || echo " Відкрийте файл hryunebot-firefox.xpi у Firefox вручну / откройте вручную."
    else echo " Файлу .xpi немає в архіві / файла .xpi нет в архиве"; fi
    echo
    echo " Firefox спитає «Додати Хрюнебот?» — натисніть «Додати» / нажмите «Добавить»."
    exit 0 ;;
  *) exit 0 ;;
esac
echo
echo " У браузері / в браузере:"
echo "  1. Увімкніть «Режим розробника» / включите «Режим разработчика»."
echo "  2. «Завантажити розпаковане» / «Загрузить распакованное»."
echo "  3. У вікні вибору: Cmd+Shift+G, вставте шлях (Cmd+V), Enter, «Вибрати» / «Выбрать»:"
echo "     $DST"
echo "  4. Закріпіть значок Хрюнебота біля адресного рядка / закрепите значок у адресной строки."
echo
