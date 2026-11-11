#!/bin/sh
# Хрюнебот — универсальный установщик для Linux (любой дистрибутив, без root).
# Ставит в браузеры на Chromium (Brave, Chrome, Chromium, Ungoogled, Opera, Vivaldi, Edge, Thorium)
# и в семейство Firefox (Firefox, LibreWolf, Floorp, Waterfox, Zen) — обычные, Flatpak и Snap.
# Запуск:  sh hryunebot-linux.sh            (или chmod +x и ./hryunebot-linux.sh)
#          sh hryunebot-linux.sh --no-open  (только распаковать, браузер не открывать)
# Обе версии расширения лежат внутри файла (base64 после маркеров); перед установкой сверяется SHA-256.
set -eu

CHROMIUM_SHA256="__CHROMIUM_SHA256__"
FIREFOX_SHA256="__FIREFOX_SHA256__"
FIREFOX_SIGNED="__FIREFOX_SIGNED__"   # 1 — подписано Mozilla (ставится насовсем), 0 — только временно

# Обычная (не скрытая) папка в домашней: её видят и браузеры из Flatpak/Snap.
DEST="$HOME/Hryunebot"
# Firefox из Flatpak/Snap видит «Загрузки», поэтому .xpi кладём туда.
DL=$(xdg-user-dir DOWNLOAD 2>/dev/null || true)
[ -n "$DL" ] && [ -d "$DL" ] || DL="$HOME/Downloads"
mkdir -p "$DL"
XPI="$DL/Hryunebot-Firefox.xpi"
NO_OPEN=0
[ "${1:-}" = "--no-open" ] && NO_OPEN=1

case "${LANG:-}${LC_ALL:-}" in *ru_*|*ru.*) RU=1 ;; *) RU=0 ;; esac
say() { if [ "$RU" = 1 ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
die() { say "Помилка: $1" "Ошибка: $2" >&2; exit 1; }

say "" ""
say "  🐷 Хрюнебот — встановлення" "  🐷 Хрюнебот — установка"
say "" ""

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t hryu)
trap 'rm -rf "$TMP"' EXIT INT TERM

# 1. Достаём обе версии из хвоста этого файла
sed -n '/^__PAYLOAD_CHROMIUM__$/,/^__PAYLOAD_FIREFOX__$/p' "$0" | sed '1d;$d' | base64 -d > "$TMP/chromium.zip" 2>/dev/null \
  || die "не вдалося розпакувати інсталятор (немає base64?)" "не получилось распаковать установщик (нет base64?)"
sed '1,/^__PAYLOAD_FIREFOX__$/d' "$0" | base64 -d > "$TMP/firefox.xpi" 2>/dev/null \
  || die "не вдалося розпакувати інсталятор (немає base64?)" "не получилось распаковать установщик (нет base64?)"

# 2. Проверка целостности обеих
sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "немає sha256sum для перевірки цілісності" "нет sha256sum для проверки целостности"; fi
}
if [ "$(sha "$TMP/chromium.zip")" != "$CHROMIUM_SHA256" ] || [ "$(sha "$TMP/firefox.xpi")" != "$FIREFOX_SHA256" ]; then
  die "перевірку цілісності НЕ пройдено: інсталятор пошкоджено або підмінено. Нічого не встановлено." \
      "проверка целостности НЕ пройдена: установщик повреждён или подменён. Ничего не установлено."
fi
say "  ✔ Перевірку цілісності пройдено (SHA-256)" "  ✔ Проверка целостности пройдена (SHA-256)"

# 3. Версия для Chromium — распакованная папка; для Firefox — готовый .xpi
rm -rf "$DEST"
mkdir -p "$DEST"
if command -v unzip >/dev/null 2>&1; then
  unzip -q -o "$TMP/chromium.zip" -d "$DEST"
elif command -v python3 >/dev/null 2>&1; then
  python3 -m zipfile -e "$TMP/chromium.zip" "$DEST"
elif command -v bsdtar >/dev/null 2>&1; then
  bsdtar -xf "$TMP/chromium.zip" -C "$DEST"
else
  die "потрібен unzip або python3 (sudo apt install unzip)" "нужен unzip или python3 (sudo apt install unzip)"
fi
[ -f "$DEST/manifest.json" ] || die "розширення розпакувалося неправильно" "расширение распаковалось неправильно"
cp "$TMP/firefox.xpi" "$XPI"
say "  ✔ Для Chromium-браузерів: $DEST" "  ✔ Для Chromium-браузеров: $DEST"
say "  ✔ Для Firefox і клонів:   $XPI" "  ✔ Для Firefox и клонов:   $XPI"

# 4. Ищем браузеры. Строка списка: «название|тип|команда|адрес страницы расширений»
LIST=""
add() { LIST="$LIST$1|$2|$3|$4
"; }
first() { for c in "$@"; do command -v "$c" >/dev/null 2>&1 && { printf '%s' "$c"; return 0; }; done; return 1; }
c=$(first brave-browser brave brave-browser-stable) && add "Brave" chromium "$c" "brave://extensions"
c=$(first google-chrome google-chrome-stable) && add "Google Chrome" chromium "$c" "chrome://extensions"
c=$(first chromium chromium-browser) && add "Chromium" chromium "$c" "chrome://extensions"
c=$(first ungoogled-chromium) && add "Ungoogled Chromium" chromium "$c" "chrome://extensions"
c=$(first opera) && add "Opera" chromium "$c" "opera://extensions"
c=$(first vivaldi vivaldi-stable) && add "Vivaldi" chromium "$c" "vivaldi://extensions"
c=$(first microsoft-edge microsoft-edge-stable) && add "Microsoft Edge" chromium "$c" "edge://extensions"
c=$(first thorium-browser) && add "Thorium" chromium "$c" "chrome://extensions"
c=$(first firefox firefox-esr) && add "Firefox" firefox "$c" ""
c=$(first librewolf) && add "LibreWolf" firefox "$c" ""
c=$(first floorp) && add "Floorp" firefox "$c" ""
c=$(first waterfox) && add "Waterfox" firefox "$c" ""
c=$(first zen-browser zen) && add "Zen" firefox "$c" ""
if command -v flatpak >/dev/null 2>&1; then
  for app in com.brave.Browser:Brave:chromium:brave com.google.Chrome:Chrome:chromium:chrome \
             org.chromium.Chromium:Chromium:chromium:chrome \
             io.github.ungoogled_software.ungoogled_chromium:Ungoogled:chromium:chrome \
             com.github.Eloston.UngoogledChromium:Ungoogled:chromium:chrome \
             com.opera.Opera:Opera:chromium:opera com.vivaldi.Vivaldi:Vivaldi:chromium:vivaldi \
             com.microsoft.Edge:Edge:chromium:edge \
             org.mozilla.firefox:Firefox:firefox: io.gitlab.librewolf-community:LibreWolf:firefox: \
             one.ablaze.floorp:Floorp:firefox: net.waterfox.waterfox:Waterfox:firefox: app.zen_browser.zen:Zen:firefox:; do
    id=${app%%:*}; rest=${app#*:}; nm=${rest%%:*}; rest=${rest#*:}; typ=${rest%%:*}; sch=${rest#*:}
    if flatpak info "$id" >/dev/null 2>&1; then
      if [ -n "$sch" ]; then add "$nm (Flatpak)" "$typ" "flatpak run $id" "$sch://extensions"
      else add "$nm (Flatpak)" "$typ" "flatpak run $id" ""; fi
    fi
  done
fi

COUNT=$(printf '%s' "$LIST" | grep -c '|' || true)
PICK=""
if [ "$COUNT" -eq 0 ]; then
  say "  Браузер не знайдено автоматично." "  Браузер не найден автоматически."
elif [ "$COUNT" -eq 1 ]; then
  PICK=$(printf '%s' "$LIST" | sed -n 1p)
else
  say "" ""
  say "  В який браузер ставимо?" "  В какой браузер ставим?"
  printf '%s' "$LIST" | awk -F'|' '{ printf "    %d - %s\n", NR, $1 }'
  if [ -r /dev/tty ]; then
    say "  Введіть цифру і натисніть Enter: " "  Введите цифру и нажмите Enter: "
    read -r N < /dev/tty || N=1
  else
    N=1
  fi
  case "$N" in ''|*[!0-9]*) N=1 ;; esac
  PICK=$(printf '%s' "$LIST" | sed -n "${N}p")
  [ -n "$PICK" ] || PICK=$(printf '%s' "$LIST" | sed -n 1p)
fi

NAME=""; TYPE="chromium"; CMD=""; URL="chrome://extensions"
if [ -n "$PICK" ]; then
  NAME=$(printf '%s' "$PICK" | cut -d'|' -f1)
  TYPE=$(printf '%s' "$PICK" | cut -d'|' -f2)
  CMD=$(printf '%s' "$PICK" | cut -d'|' -f3)
  URL=$(printf '%s' "$PICK" | cut -d'|' -f4)
fi

copy() {  # путь — в буфер обмена, если есть чем
  if command -v wl-copy >/dev/null 2>&1 && [ -n "${WAYLAND_DISPLAY:-}" ]; then printf '%s' "$1" | wl-copy && return 0; fi
  if command -v xclip >/dev/null 2>&1; then printf '%s' "$1" | xclip -selection clipboard && return 0; fi
  if command -v xsel >/dev/null 2>&1; then printf '%s' "$1" | xsel -b && return 0; fi
  return 1
}
launch() {  # shellcheck disable=SC2086 # CMD может быть «flatpak run id»
  [ "$NO_OPEN" = 0 ] && [ -n "$CMD" ] && { nohup $CMD "$@" >/dev/null 2>&1 & }
  return 0
}

say "" ""
# 5. Firefox и клоны
if [ "$TYPE" = firefox ]; then
  if [ "$FIREFOX_SIGNED" = 1 ]; then
    [ "$NO_OPEN" = 0 ] && say "  Відкриваю $NAME — він запитає, чи додати Хрюнебота…" "  Открываю $NAME — он спросит, добавить ли Хрюнебота…"
    launch "$XPI"
    say "  Залишилося в $NAME:" "  Осталось в $NAME:"
    say "    1. Натисніть «Додати» у вікні, що з’явиться." "    1. Нажмите «Добавить» в появившемся окне."
    say "       Якщо вікна немає — відкрийте $XPI у браузері (Ctrl+O)." "       Если окна нет — откройте $XPI в браузере (Ctrl+O)."
    say "    2. Дозвольте доступ до reddit, якщо браузер спитає." "    2. Разрешите доступ к reddit, если браузер спросит."
    say "    3. Закріпіть Хрюнебота через значок пазла праворуч від адресного рядка." "    3. Закрепите Хрюнебота через значок пазла справа от адресной строки."
  else
    copy "$XPI" && say "  ✔ Шлях до .xpi скопійовано" "  ✔ Путь к .xpi скопирован"
    launch "about:debugging#/runtime/this-firefox"
    say "  УВАГА: ця збірка для Firefox ще не підписана Mozilla — її можна поставити лише" \
        "  ВНИМАНИЕ: эта сборка для Firefox ещё не подписана Mozilla — её можно поставить только"
    say "  тимчасово, до перезапуску браузера." "  временно, до перезапуска браузера."
    say "    1. На сторінці about:debugging натисніть «Завантажити тимчасовий додаток…»." \
        "    1. На странице about:debugging нажмите «Загрузить временное дополнение…»."
    say "    2. Виберіть файл $XPI" "    2. Выберите файл $XPI"
  fi
# 6. Chromium-браузеры
else
  copy "$DEST" && say "  ✔ Шлях скопійовано в буфер обміну" "  ✔ Путь скопирован в буфер обмена"
  [ "$NO_OPEN" = 0 ] && [ -n "$CMD" ] && say "  Відкриваю $NAME на сторінці розширень…" "  Открываю $NAME на странице расширений…"
  launch "$URL"
  [ -z "$PICK" ] && say "  Відкрийте свій браузер і впишіть: chrome://extensions" "  Откройте свой браузер и впишите: chrome://extensions"
  say "  Залишилося в браузері${NAME:+ ($NAME)}:" "  Осталось в браузере${NAME:+ ($NAME)}:"
  case "$URL" in
    edge:*)
      say "    1. На панелі зліва внизу увімкніть «Режим розробника»." "    1. В панели слева внизу включите «Режим разработчика»."
      say "    2. Вгорі натисніть «Завантажити розпаковане»." "    2. Вверху нажмите «Загрузить распакованное»." ;;
    *)
      say "    1. Праворуч угорі увімкніть «Режим розробника»." "    1. Справа вверху включите «Режим разработчика»."
      say "    2. Натисніть «Завантажити розпаковане розширення»." "    2. Нажмите «Загрузить распакованное расширение»." ;;
  esac
  say "    3. У вікні вибору папки натисніть Ctrl+L, вставте шлях (Ctrl+V) і Enter:" \
      "    3. В окне выбора папки нажмите Ctrl+L, вставьте путь (Ctrl+V) и Enter:"
  say "         $DEST" "         $DEST"
  say "       потім «Вибрати» / «Відкрити»." "       затем «Выбрать» / «Открыть»."
  case "$URL" in
    opera:*) say "    4. Закріпіть Хрюнебота через значок кубика праворуч від адресного рядка." "    4. Закрепите Хрюнебота через значок кубика справа от адресной строки." ;;
    *)       say "    4. Закріпіть Хрюнебота через значок пазла праворуч від адресного рядка." "    4. Закрепите Хрюнебота через значок пазла справа от адресной строки." ;;
  esac
fi
say "" ""
say "  Готово — відкрийте reddit, біля ніків з’являться мітки." "  Готово — откройте reddit, у ников появятся метки."
say "  Не видаляйте $DEST і $XPI." "  Не удаляйте $DEST и $XPI."
say "" ""
exit 0
__PAYLOAD_CHROMIUM__
