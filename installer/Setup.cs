// Установщик Хрюнебота: окно с хрюнеботом, проверка целостности, распаковка расширения,
// поиск браузеров и открытие страницы расширений. Собирается встроенным в Windows csc (C# 5).
// Язык: украинский по умолчанию, русский — переключателем «UA | RU» (или если Windows на русском).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Windows.Forms;

static partial class Payload { }

class Browser
{
    public string Name, Exe, Url;   // Url == "firefox" — браузер семейства Firefox (ставим подписанный .xpi)
    public bool IsFirefox { get { return Url == "firefox"; } }
    public override string ToString() { return Name; }
}

class SetupForm : Form
{
    static readonly Color Pink = Color.FromArgb(236, 64, 122);
    static readonly Color Muted = Color.FromArgb(110, 110, 120);
    static readonly Color Ok = Color.FromArgb(46, 125, 50);
    static readonly Color Bad = Color.FromArgb(198, 40, 40);

    // Текущий язык. По умолчанию украинский; русский — если Windows на русском.
    public static bool Ru = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ru";
    static string L(string uk, string ru) { return Ru ? ru : uk; }

    readonly string dst = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Hryunebot");
    readonly string xpiPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Hryunebot-Firefox.xpi");
    byte[] payload;
    byte[] ffPayload;               // подписанный Mozilla .xpi (если вшит при сборке)
    bool payloadOk;
    bool installed;
    // Есть ли в установщике подписанная версия для Firefox — от этого зависит, показывать ли Firefox в списке.
    public static bool FirefoxAvailable;

    Label subtitle, status, steps;
    Button installBtn, openBtn, closeBtn;
    LinkLabel copyLink, langUk, langRu;
    Panel after;
    ComboBox browsers;

    public SetupForm()
    {
        ClientSize = new Size(560, 550);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.White;
        Font = new Font("Segoe UI", 10f);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var pic = new PictureBox { Location = new Point(24, 24), Size = new Size(150, 150), SizeMode = PictureBoxSizeMode.Zoom };
        var pigStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("pig.png");
        if (pigStream != null) pic.Image = Image.FromStream(pigStream);
        Controls.Add(pic);

        Controls.Add(new Label { Text = "Хрюнебот", Font = new Font("Segoe UI", 24f, FontStyle.Bold), ForeColor = Pink, Location = new Point(192, 36), AutoSize = true });
        Controls.Add(new Label { Text = "v" + Payload.Version, Font = new Font("Segoe UI", 9f), ForeColor = Color.Gray, Location = new Point(196, 82), AutoSize = true });

        // Переключатель языка в правом верхнем углу
        langUk = new LinkLabel { Text = "UA", Location = new Point(482, 10), AutoSize = true, Font = new Font("Segoe UI", 9.5f, FontStyle.Bold) };
        langRu = new LinkLabel { Text = "RU", Location = new Point(514, 10), AutoSize = true, Font = new Font("Segoe UI", 9.5f, FontStyle.Bold) };
        langUk.LinkClicked += delegate { Ru = false; ApplyTexts(); };
        langRu.LinkClicked += delegate { Ru = true; ApplyTexts(); };
        Controls.Add(langUk);
        Controls.Add(langRu);

        subtitle = new Label { Location = new Point(196, 92), Size = new Size(350, 90), ForeColor = Muted };
        Controls.Add(subtitle);

        status = new Label { Location = new Point(24, 192), Size = new Size(512, 44), ForeColor = Muted };
        Controls.Add(status);

        installBtn = new Button
        {
            Location = new Point(24, 240), Size = new Size(512, 48),
            BackColor = Pink, ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Font = new Font("Segoe UI", 12f, FontStyle.Bold)
        };
        installBtn.FlatAppearance.BorderSize = 0;
        installBtn.Click += delegate { Install(); };
        Controls.Add(installBtn);

        CheckPayload();      // сначала: от него зависит, показывать ли Firefox в списке браузеров
        BuildAfterPanel();
        ApplyTexts();
    }

    Browser Selected { get { return browsers.SelectedItem as Browser; } }

    // Все надписи — здесь, чтобы переключение языка перерисовывало окно целиком.
    void ApplyTexts()
    {
        Text = L("Хрюнебот " + Payload.Version + " — встановлення", "Хрюнебот " + Payload.Version + " — установка");
        langUk.LinkColor = Ru ? Muted : Pink;
        langRu.LinkColor = Ru ? Pink : Muted;
        subtitle.Text = L("Мітки, скарги та нахрюкометр просто біля ніків на Reddit.\nРозширення для Brave, Chrome, Opera, Edge, Vivaldi" + (FirefoxAvailable ? ", Firefox" : "") + " та інших.",
                          "Метки, жалобы и нахрюкометр прямо рядом с никами на Reddit.\nРасширение для Brave, Chrome, Opera, Edge, Vivaldi" + (FirefoxAvailable ? ", Firefox" : "") + " и других.");
        installBtn.Text = L("Встановити", "Установить");
        openBtn.Text = Selected != null && Selected.IsFirefox
            ? L("Встановити в ", "Установить в ") + Selected.Name
            : L("Відкрити сторінку розширень", "Открыть страницу расширений");
        copyLink.Text = L("Скопіювати шлях ще раз", "Скопировать путь ещё раз");
        closeBtn.Text = L("Готово", "Готово");
        steps.Text = StepsFor(browsers.SelectedItem as Browser);

        if (!payloadOk)
        {
            status.Text = L("УВАГА: перевірку цілісності НЕ пройдено: інсталятор пошкоджено або підмінено.\nНічого не встановлюю. Завантажте інсталятор заново.",
                            "ВНИМАНИЕ: проверка целостности НЕ пройдена: установщик повреждён или подменён.\nНичего не устанавливаю. Скачайте установщик заново.");
            status.ForeColor = Bad;
        }
        else if (installed)
        {
            status.Text = L("Готово! Хрюнебот встановлено. Шлях до нього вже скопійовано.\nЗалишилося підключити його в браузері — 3 кліки:",
                            "Готово! Хрюнебот установлен. Путь к нему уже скопирован.\nОсталось подключить его в браузере — 3 клика:");
            status.ForeColor = Ok;
        }
        else
        {
            status.Text = L("Перевірку цілісності пройдено (SHA-256). Інсталятор не змінено.\nВстановлення в папку користувача, права адміністратора не потрібні.",
                            "Проверка целостности пройдена (SHA-256). Установщик не изменён.\nУстановка в папку пользователя, права администратора не нужны.");
            status.ForeColor = Ok;
        }
    }

    void CheckPayload()
    {
        try
        {
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("hryunebot.zip"))
            using (var ms = new MemoryStream())
            {
                s.CopyTo(ms);
                payload = ms.ToArray();
            }
            string hash;
            using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(payload)).Replace("-", "").ToLowerInvariant();
            payloadOk = hash == Payload.Sha256;

            // Подписанная версия для Firefox (есть не в каждой сборке). Если вшита, но не сходится — это подмена.
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("hryunebot-firefox.xpi"))
            {
                if (s != null)
                {
                    using (var ms = new MemoryStream()) { s.CopyTo(ms); ffPayload = ms.ToArray(); }
                    using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(ffPayload)).Replace("-", "").ToLowerInvariant();
                    if (hash != Payload.FirefoxSha256) payloadOk = false;
                    else FirefoxAvailable = true;
                }
            }
        }
        catch { payloadOk = false; }

        if (!payloadOk)
        {
            installBtn.Enabled = false;
            installBtn.BackColor = Color.Gray;
        }
    }

    void Install()
    {
        try
        {
            if (Directory.Exists(dst)) Directory.Delete(dst, true);
            Directory.CreateDirectory(dst);
            string root = Path.GetFullPath(dst) + Path.DirectorySeparatorChar;
            using (var zip = new ZipArchive(new MemoryStream(payload), ZipArchiveMode.Read))
            {
                foreach (var e in zip.Entries)
                {
                    string rel = e.FullName.Replace('\\', '/');
                    if (rel.EndsWith("/")) continue;
                    string target = Path.GetFullPath(Path.Combine(dst, rel.Replace('/', Path.DirectorySeparatorChar)));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        throw new Exception(L("Підозрілий шлях в архіві: ", "Подозрительный путь в архиве: ") + rel);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (var src = e.Open())
                    using (var outFile = File.Create(target)) src.CopyTo(outFile);
                }
            }
            if (!File.Exists(Path.Combine(dst, "manifest.json")))
                throw new Exception(L("Розширення розпакувалося неправильно.", "Расширение распаковалось неправильно."));
            if (FirefoxAvailable) File.WriteAllBytes(xpiPath, ffPayload);
            try { Clipboard.SetText(dst); } catch { }

            installed = true;
            installBtn.Visible = false;
            after.Visible = true;
            ApplyTexts();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, L("Не вдалося встановити:\n", "Не получилось установить:\n") + ex.Message, "Хрюнебот", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    void BuildAfterPanel()
    {
        after = new Panel { Location = new Point(24, 238), Size = new Size(512, 300), Visible = false };
        Controls.Add(after);

        browsers = new ComboBox { Location = new Point(0, 2), Size = new Size(222, 30), DropDownStyle = ComboBoxStyle.DropDownList };
        foreach (var b in FindBrowsers()) browsers.Items.Add(b);
        if (browsers.Items.Count > 0) browsers.SelectedIndex = 0;
        after.Controls.Add(browsers);

        openBtn = new Button { Location = new Point(232, 0), Size = new Size(280, 32), BackColor = Pink, ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        openBtn.FlatAppearance.BorderSize = 0;
        openBtn.Click += delegate { OpenExtensions(); };
        after.Controls.Add(openBtn);
        if (browsers.Items.Count == 0)
        {
            browsers.Enabled = false; openBtn.Enabled = false;
        }

        steps = new Label { Location = new Point(0, 42), Size = new Size(512, 200), Font = new Font("Segoe UI", 9.5f) };
        browsers.SelectedIndexChanged += delegate { ApplyTexts(); };   // и шаги, и надпись на кнопке зависят от браузера
        after.Controls.Add(steps);

        copyLink = new LinkLabel { Location = new Point(0, 258), AutoSize = true };
        copyLink.LinkClicked += delegate
        {
            try { Clipboard.SetText(dst); MessageBox.Show(this, L("Скопійовано:\n", "Скопировано:\n") + dst, "Хрюнебот"); } catch { }
        };
        after.Controls.Add(copyLink);
        closeBtn = new Button { Location = new Point(412, 254), Size = new Size(100, 32) };
        closeBtn.Click += delegate { Close(); };
        after.Controls.Add(closeBtn);
    }

    // Пошаговая инструкция под конкретный браузер: где переключатель, как называется кнопка, как закрепить значок.
    public static string StepsFor(Browser b)
    {
        string pick = L("У вікні вибору папки клікніть у рядок адреси вгорі, натисніть Ctrl+V і Enter,\n     потім кнопку «Вибір папки».",
                        "В окне выбора папки кликните в строку адреса сверху, нажмите Ctrl+V и Enter,\n     затем кнопку «Выбор папки».");
        string done = L("\nГотово — відкрийте reddit, біля ніків з’являться мітки.", "\nГотово — откройте reddit, у ников появятся метки.");
        string open1 = L("1. Натисніть «Відкрити сторінку розширень».\n", "1. Нажмите «Открыть страницу расширений».\n");

        if (b == null)
            return L("Браузер не знайдено автоматично. Відкрийте свій браузер\n" +
                     "і впишіть в адресний рядок chrome://extensions\n" +
                     "(в Edge — edge://extensions, в Opera — opera://extensions).\n\n" +
                     "1. Увімкніть «Режим розробника».\n" +
                     "2. Натисніть «Завантажити розпаковане розширення».\n" +
                     "3. ",
                     "Браузер не найден автоматически. Откройте свой браузер\n" +
                     "и впишите в адресную строку chrome://extensions\n" +
                     "(в Edge — edge://extensions, в Opera — opera://extensions).\n\n" +
                     "1. Включите «Режим разработчика».\n" +
                     "2. Нажмите «Загрузить распакованное расширение».\n" +
                     "3. ") + pick + (FirefoxAvailable ? "" : L("\n\nFirefox і Safari не підходять.", "\n\nFirefox и Safari не подходят.")) + done;

        if (b.IsFirefox)
            return b.Name + ":\n" +
                   L("1. Натисніть «Встановити в " + b.Name + "» — відкриється браузер.\n" +
                     "2. Він спитає «Додати Хрюнебот?» — натисніть «Додати».\n" +
                     "     (Розширення підписане Mozilla, тому встановлюється назавжди.)\n" +
                     "3. Якщо браузер спитає про доступ до reddit — дозвольте.\n" +
                     "4. Закріпіть Хрюнебота через значок пазла праворуч від адресного рядка.",
                     "1. Нажмите «Установить в " + b.Name + "» — откроется браузер.\n" +
                     "2. Он спросит «Добавить Хрюнебот?» — нажмите «Добавить».\n" +
                     "     (Расширение подписано Mozilla, поэтому ставится насовсем.)\n" +
                     "3. Если браузер спросит про доступ к reddit — разрешите.\n" +
                     "4. Закрепите Хрюнебота через значок пазла справа от адресной строки.") + done;

        string url = b.Url;
        if (url.StartsWith("edge:"))
            return "Microsoft Edge:\n" + open1 +
                   L("2. На панелі зліва внизу увімкніть «Режим розробника».\n" +
                     "     (Немає панелі зліва? Вікно вузьке — натисніть ☰ зліва вгорі.)\n" +
                     "3. Вгорі з’явиться кнопка «Завантажити розпаковане» — натисніть її.\n",
                     "2. В панели слева внизу включите «Режим разработчика».\n" +
                     "     (Нет панели слева? Окно узкое — нажмите ☰ слева вверху.)\n" +
                     "3. Вверху появится кнопка «Загрузить распакованное» — нажмите её.\n") +
                   "4. " + pick + "\n" +
                   L("5. Натисніть значок пазла «Розширення» праворуч від адресного рядка\n     і увімкніть «оченятко» «Показати на панелі» біля Хрюнебота.",
                     "5. Нажмите значок пазла «Расширения» справа от адресной строки\n     и включите глазок «Показать на панели» у Хрюнебота.") + done;

        if (url.StartsWith("opera:"))
            return b.Name + ":\n" +
                   L("1. Натисніть «Відкрити сторінку розширень». Opera не завжди її відкриває сама —\n     тоді впишіть в адресний рядок opera://extensions і натисніть Enter.\n",
                     "1. Нажмите «Открыть страницу расширений». Opera не всегда открывает её сама —\n     тогда впишите в адресную строку opera://extensions и нажмите Enter.\n") +
                   L("2. Праворуч угорі увімкніть перемикач «Режим розробника».\n" +
                     "3. Зліва вгорі натисніть «Завантажити розпаковане розширення».\n",
                     "2. Справа вверху включите переключатель «Режим разработчика».\n" +
                     "3. Слева вверху нажмите «Загрузить распакованное расширение».\n") +
                   "4. " + pick + "\n" +
                   L("5. Натисніть значок кубика «Розширення» праворуч від адресного рядка\n     і закріпіть Хрюнебота шпилькою.",
                     "5. Нажмите значок кубика «Расширения» справа от адресной строки\n     и закрепите Хрюнебота булавкой.") + done;

        if (url.StartsWith("vivaldi:"))
            return "Vivaldi:\n" + open1 +
                   L("2. Праворуч угорі увімкніть «Режим розробника».\n" +
                     "3. Натисніть «Завантажити розпаковане розширення».\n",
                     "2. Справа вверху включите «Режим разработчика».\n" +
                     "3. Нажмите «Загрузить распакованное расширение».\n") +
                   "4. " + pick + "\n" +
                   L("5. Значок з’явиться праворуч в адресному рядку (кнопка «Розширення»).",
                     "5. Значок появится справа в адресной строке (кнопка «Расширения»).") + done;

        string who = url.StartsWith("brave:") ? "Brave" : b.Name;
        return who + ":\n" + open1 +
               L("2. Праворуч угорі увімкніть перемикач «Режим розробника».\n" +
                 "3. Зліва вгорі з’явиться «Завантажити розпаковане розширення» — натисніть.\n",
                 "2. Справа вверху включите переключатель «Режим разработчика».\n" +
                 "3. Слева вверху появится «Загрузить распакованное расширение» — нажмите.\n") +
               "4. " + pick + "\n" +
               L("5. Натисніть значок пазла праворуч від адресного рядка і закріпіть\n     Хрюнебота шпилькою.",
                 "5. Нажмите значок пазла справа от адресной строки и закрепите\n     Хрюнебота булавкой.") + done;
    }

    void OpenExtensions()
    {
        var b = browsers.SelectedItem as Browser;
        if (b == null) return;
        // Firefox: открываем подписанный .xpi — браузер сам предложит «Добавить».
        // Opera не открывает opera://… из командной строки, а chrome://extensions понимает как свою страницу.
        string arg = b.IsFirefox ? "\"" + xpiPath + "\"" : b.Url.StartsWith("opera:") ? "chrome://extensions" : b.Url;
        try { Process.Start(b.Exe, arg); }
        catch (Exception ex) { MessageBox.Show(this, L("Не вдалося відкрити браузер: ", "Не удалось открыть браузер: ") + ex.Message, "Хрюнебот"); }
    }

    // Яндекс Браузер не поддерживаем — пропускаем его и при поиске по реестру.
    static bool IsExcluded(string exe)
    {
        return exe.IndexOf(@"\Yandex\", StringComparison.OrdinalIgnoreCase) >= 0
            || exe.IndexOf("YandexBrowser", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    // Браузеры, зарегистрированные в Windows (HKLM/HKCU\...\Clients\StartMenuInternet) — находит их
    // в любой папке установки. Семейство Firefox — если есть подписанная версия; остальные не-Chromium пропускаем.
    static void AddFromRegistry(List<Browser> found, HashSet<string> seenExe)
    {
        string[] firefoxFamily = { "firefox", "waterfox", "librewolf", "floorp", "zen" };
        string[] notChromium = { "palemoon", "seamonkey", "iexplore", "tor", "mullvad" };
        var hives = new[] { Microsoft.Win32.Registry.LocalMachine, Microsoft.Win32.Registry.CurrentUser };
        string[] keys = { @"SOFTWARE\Clients\StartMenuInternet", @"SOFTWARE\WOW6432Node\Clients\StartMenuInternet" };
        foreach (var hive in hives)
            foreach (var k in keys)
            {
                using (var root = hive.OpenSubKey(k))
                {
                    if (root == null) continue;
                    foreach (var sub in root.GetSubKeyNames())
                    {
                        using (var b = root.OpenSubKey(sub))
                        using (var cmd = root.OpenSubKey(sub + @"\shell\open\command"))
                        {
                            if (b == null || cmd == null) continue;
                            string line = (cmd.GetValue("") as string ?? "").Trim();
                            string exe = line.StartsWith("\"") ? line.Substring(1, Math.Max(0, line.IndexOf('"', 1) - 1)) : line.Split(' ')[0];
                            if (exe.Length == 0 || !File.Exists(exe) || seenExe.Contains(exe) || IsExcluded(exe)) continue;
                            string file = Path.GetFileNameWithoutExtension(exe).ToLowerInvariant();
                            bool skip = false, ff = false;
                            foreach (var n in notChromium) if (file.StartsWith(n)) skip = true;
                            foreach (var n in firefoxFamily) if (file.StartsWith(n)) ff = true;
                            if (skip || (ff && !FirefoxAvailable)) continue;
                            string name = (b.GetValue("") as string ?? sub).Replace(" Stable", "");
                            string url = ff ? "firefox"
                                : file == "brave" ? "brave://extensions"
                                : file == "msedge" ? "edge://extensions"
                                : file == "opera" ? "opera://extensions"
                                : file == "vivaldi" ? "vivaldi://extensions"
                                : "chrome://extensions";
                            seenExe.Add(exe);
                            found.Add(new Browser { Name = name, Exe = exe, Url = url });
                        }
                    }
                }
            }
    }

    public static List<Browser> FindBrowsers()
    {
        string pf = Environment.GetEnvironmentVariable("ProgramFiles") ?? "";
        string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? "";
        string pfw = Environment.GetEnvironmentVariable("ProgramW6432") ?? ""; // 64-битный Program Files из 32-битного процесса
        string la = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] roots = { pf, pfw, pf86, la };

        string[,] list =
        {
            { "Brave", @"BraveSoftware\Brave-Browser\Application\brave.exe", "brave://extensions" },
            { "Brave Beta", @"BraveSoftware\Brave-Browser-Beta\Application\brave.exe", "brave://extensions" },
            { "Brave Nightly", @"BraveSoftware\Brave-Browser-Nightly\Application\brave.exe", "brave://extensions" },
            { "Google Chrome", @"Google\Chrome\Application\chrome.exe", "chrome://extensions" },
            { "Google Chrome Beta", @"Google\Chrome Beta\Application\chrome.exe", "chrome://extensions" },
            { "Google Chrome Dev", @"Google\Chrome Dev\Application\chrome.exe", "chrome://extensions" },
            { "Google Chrome Canary", @"Google\Chrome SxS\Application\chrome.exe", "chrome://extensions" },
            { "Chromium", @"Chromium\Application\chrome.exe", "chrome://extensions" },
            { "Thorium", @"Thorium\Application\thorium.exe", "chrome://extensions" },
            { "Opera", @"Programs\Opera\opera.exe", "opera://extensions" },
            { "Opera", @"Opera\opera.exe", "opera://extensions" },
            { "Opera GX", @"Programs\Opera GX\opera.exe", "opera://extensions" },
            { "Opera Air", @"Programs\Opera Air\opera.exe", "opera://extensions" },
            { "Opera Beta", @"Programs\Opera beta\opera.exe", "opera://extensions" },
            { "Opera Developer", @"Programs\Opera developer\opera.exe", "opera://extensions" },
            { "Vivaldi", @"Vivaldi\Application\vivaldi.exe", "vivaldi://extensions" },
            { "Microsoft Edge", @"Microsoft\Edge\Application\msedge.exe", "edge://extensions" },
            { "Microsoft Edge Beta", @"Microsoft\Edge Beta\Application\msedge.exe", "edge://extensions" },
            { "Microsoft Edge Dev", @"Microsoft\Edge Dev\Application\msedge.exe", "edge://extensions" },
            { "Microsoft Edge Canary", @"Microsoft\Edge SxS\Application\msedge.exe", "edge://extensions" },
            { "Cent Browser", @"CentBrowser\Application\chrome.exe", "chrome://extensions" },
            { "Slimjet", @"Slimjet\slimjet.exe", "chrome://extensions" },
            { "Comodo Dragon", @"Comodo\Dragon\dragon.exe", "chrome://extensions" },
            { "Epic Privacy Browser", @"Epic Privacy Browser\Application\epic.exe", "chrome://extensions" },
            { "Avast Secure Browser", @"AVAST Software\Browser\Application\AvastBrowser.exe", "chrome://extensions" },
            { "AVG Secure Browser", @"AVG\Browser\Application\AVGBrowser.exe", "chrome://extensions" },
            { "Atom (VK)", @"VK\Atom\Application\atom.exe", "chrome://extensions" },
            { "Atom (VK)", @"Mail.Ru\Atom\Application\atom.exe", "chrome://extensions" },
            { "Iridium", @"Iridium\Application\iridium.exe", "chrome://extensions" },
            { "Ungoogled Chromium", @"ungoogled-chromium\Application\chrome.exe", "chrome://extensions" },
            // Семейство Firefox (только если в установщике есть подписанная Mozilla версия)
            { "Firefox", @"Mozilla Firefox\firefox.exe", "firefox" },
            { "Firefox Developer Edition", @"Firefox Developer Edition\firefox.exe", "firefox" },
            { "Firefox Nightly", @"Firefox Nightly\firefox.exe", "firefox" },
            { "LibreWolf", @"LibreWolf\librewolf.exe", "firefox" },
            { "Floorp", @"Floorp\floorp.exe", "firefox" },
            { "Waterfox", @"Waterfox\waterfox.exe", "firefox" },
            { "Zen", @"Zen Browser\zen.exe", "firefox" },
        };

        var found = new List<Browser>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var seenExe = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < list.GetLength(0); i++)
        {
            foreach (var r in roots)
            {
                if (string.IsNullOrEmpty(r)) continue;
                string exe = Path.Combine(r, list[i, 1]);
                if (!File.Exists(exe) || seen.Contains(list[i, 0])) continue;
                if (list[i, 2] == "firefox" && !FirefoxAvailable) break;
                seen.Add(list[i, 0]);
                seenExe.Add(Path.GetFullPath(exe));
                found.Add(new Browser { Name = list[i, 0], Exe = exe, Url = list[i, 2] });
                break;
            }
        }
        try { AddFromRegistry(found, seenExe); } catch { }
        return found;
    }

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm());
    }
}
