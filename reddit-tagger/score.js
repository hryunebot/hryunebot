// Ботометр — общая формула для окна на reddit и для списка.
//
// Баллы складываются из:
//   жалоб:    каждый отдельный человек, который пожаловался = 1 балл;
//             повторные жалобы от тех же людей = 0.25 балла за штуку;
//   нахрюков: посты/комменты юзера в сабах из правил автопроверки —
//             «баллы правила» начисляются за каждые 10 нахрюков (1 нахрюк = 1/10 от них);
//   свежего аккаунта: баллы из настроек (по умолчанию 2).
// Проценты: 1 - 2^(-баллы / H), где H — «баллов до 50%» из настроек (по умолчанию 7).
//   При H = 7 и правиле на 2 балла: 1 нахрюк ≈ 2%, 10 ≈ 18%, 30 ≈ 45%, 50 ≈ 63%, 100 ≈ 86%;
//   жалобы: 1 человек ≈ 9%, 3 ≈ 26%, 7 = 50%, 10 ≈ 63%. Потолок — 99%.
/* eslint-disable no-unused-vars */
var HALF_DEFAULT = 7;

function botPoints(people, complaints, extra) {
  people = Math.max(0, people || 0);
  complaints = Math.max(people, complaints || 0);
  return people + 0.25 * (complaints - people) + (extra || 0);
}

// Баллы за нахрюки: perTen — баллов правила за каждые 10 нахрюков.
function nahrukPoints(n, perTen) {
  return Math.max(0, n || 0) * Math.max(0, perTen || 0) / 10;
}

// ---------- метки и правила по умолчанию ----------
// Быстрые метки — только эти три.
var DEFAULT_PRESETS = ['зрадойоб', 'орк', 'новорег', 'консерва'];
var PRESETS_VERSION = 4; // 4: добавлена «консерва»

// Все стандартные метки прошлых версий — при обновлении убираем их из сохранённых настроек
// (то, что пользователь добавил сам, остаётся).
var OLD_DEFAULT_PRESETS = [
  'говнюк', 'зигонафт', 'упырь', 'тролль', 'бот', 'норм чел', 'диванный эксперт',
  'зелебот', 'порохобот', 'зрадоеб', 'зрадофил', 'перемогобот', 'ватник', 'кремлебот',
  'ольгинец', 'z-патриот', 'ждун', 'турбопатриот', 'ипсошник', 'свидомит',
  'зрадофіл', 'зрадоїд', 'турбопатріот', 'соросятко', 'ІПСОшник',
  'зебот', 'юлебот', 'медведчукобот', 'пригожинский бот', 'навальнобот', 'z-бот', 'ботоферма',
];

// Сабы, где поддерживают войну. Pikabu, rusAskReddit, ruAsska, expectedrussians владелец добавил 09.11.2026
// (ru_gamer — нет). Защита от «метки за язык»: вердикт по оценкам в самих сабах — кого там минусуют,
// тот «🥊 спорщик» (0 баллов), а не орк.
var ORK_SUBS_V2 = ['pikabu', 'rusaskreddit', 'ruasska', 'expectedrussians', 'vataru']; // vataRU — тоже владелец, 09.11
var DEFAULT_RULES = [
  // 1.3.89 (владелец + ГПТ, 11.11): ruAsska убран — 11 случайных «орков только за ruAsska», 212 комментов, ни одного
  // провоенного. expectedrussians — «мягкий» (soft): саб зетный, но из 16 проверенных оттуда зетный 1, неясных 2 →
  // по нему одному максимум «🤷 орк?». Уверенный «👹» — только за ukrainerussiareport / genzedong / vataRU.
  { icon: '👹', tag: 'орк', subs: ['ukrainerussiareport', 'genzedong', 'expectedrussians', 'vataru'], soft: ['expectedrussians'], min: 3, points: 2 },
  // r/RedditUaTalks — владелец, 09.11: «туда же, но картинку дурачка»
  // 1.3.89 (владелец, 11.11): «клоун» = любой из RedditUaTalks — метка места, а не обвинение. Баллы за нахрюки, но потолок
  // 2 (≈18%) вместо 6 (≈45%) — RULE_CAP; ни у кого не растёт. У «свого» сворачивается. Отключается в настройках (clownOn).
  { icon: '🤡', tag: 'клоун', subs: ['reddituatalks'], min: 3, points: 2 },
  // rusAskReddit, Pikabu — общие русскоязычные сабы: не «орк», а «я за тобой слежу» (владелец, 09.11).
  // flat — всегда 1 балл, не растёт с числом постов; trustHome — пропадает, если в «своих» сабах 100+ плюсов.
  { icon: '👀', tag: 'слежу', subs: ['rusaskreddit', 'pikabu'], min: 3, points: 1, flat: true, trustHome: 100 },
];
// Коды меток правил для сервера (вердикты владельца)
var RULE_CODES = { 'орк': 'ork', 'клоун': 'clown', 'слежу': 'watch' };
// Баллы правила: обычно — за каждые 10 постов/комментов, у flat — фиксированные.
// Потолок баллов правила (до деления пополам у «?»): клоун — не больше 6 (≈45%), владелец 09.11. Орк — без потолка.
var RULE_CAP = { clown: 2 }; // было 6 (09.11), 1.3.89 — 2
function ruleCap(code, pts) { var c = RULE_CAP[code]; return c != null ? Math.min(pts, c) : pts; }
// Полные баллы метки правила по серверному коду (как rulePoints у правила по умолчанию): слежу — 1, клоун — 2 (фикс),
// орк — за нахрюки. Нужен, чтобы серверные вердикты считались так же, как своя проверка.
function srvRuleFull(kind, n) { return kind === 'watch' ? 1 : ruleCap(kind, nahrukPoints(n || 0, 2)); }
function rulePoints(r, n) { return r.flat ? (r.points || 1) : ruleCap(RULE_CODES[r.tag], nahrukPoints(n, r.points == null ? 2 : r.points)); }
// Правило с trustHome не показываем тем, кого в «своих» сабах (home) заплюсовали 100+ раз — свой.
function ruleHidden(r, votes, home) {
  if (!r || !r.trustHome) return false;
  var up = 0;
  for (var i = 0; i < (home || []).length; i++) { var v = (votes || {})[String(home[i]).toLowerCase()]; if (v) up += v.up || 0; }
  return up >= r.trustHome;
}
// Один раз дописывает новые сабы в правило «орк» в сохранённых настройках (если владелец потом уберёт — не вернём).
function migrateOrkSubs(settings) {
  if (!settings || (settings.orkV || 0) >= 6) return;
  if ((settings.orkV || 0) < 3) (settings.autoRules || []).forEach(function (r) {
    if (r && r.tag === 'орк' && Array.isArray(r.subs)) {
      ORK_SUBS_V2.forEach(function (x) { if (r.subs.indexOf(x) < 0) r.subs.push(x); });
    }
  });
  // v4: правило «🤡 клоун» (r/RedditUaTalks), если его ещё нет
  if (Array.isArray(settings.autoRules) && !settings.autoRules.some(function (r) { return r && r.tag === 'клоун'; })) {
    settings.autoRules.push(Object.assign({}, DEFAULT_RULES[1], { subs: DEFAULT_RULES[1].subs.slice() }));
  }
  // v5: rusAskReddit и Pikabu — из «орка» в «👀 слежу»
  if ((settings.orkV || 0) < 5 && Array.isArray(settings.autoRules)) {
    settings.autoRules.forEach(function (r) {
      if (r && r.tag === 'орк' && Array.isArray(r.subs)) r.subs = r.subs.filter(function (x) { return x !== 'rusaskreddit' && x !== 'pikabu'; });
    });
    if (!settings.autoRules.some(function (r) { return r && r.tag === 'слежу'; })) {
      settings.autoRules.push(Object.assign({}, DEFAULT_RULES[2], { subs: DEFAULT_RULES[2].subs.slice() }));
    }
  }
  // v6 (1.3.89): ruAsska — из «орка» вон; expectedrussians — «мягкий» (максимум «орк?»)
  if ((settings.orkV || 0) < 6 && Array.isArray(settings.autoRules)) {
    settings.autoRules.forEach(function (r) {
      if (!r || r.tag !== 'орк' || !Array.isArray(r.subs)) return;
      r.subs = r.subs.filter(function (x) { return x !== 'ruasska'; });
      if (r.subs.indexOf('expectedrussians') >= 0) r.soft = ['expectedrussians'];
    });
  }
  settings.orkV = 6;
}

// Обновляет быстрые метки в сохранённых настройках один раз (по номеру версии списка):
// новые стандартные + свои метки пользователя, без старых стандартных.
function migratePresets(settings) {
  if (!settings) return;
  migrateOrkSubs(settings);
  if ((settings.presetsV || 0) >= PRESETS_VERSION && settings.presets) return;
  var own = (settings.presets || []).filter(function (p) {
    return OLD_DEFAULT_PRESETS.indexOf(p) < 0 && DEFAULT_PRESETS.indexOf(p) < 0;
  });
  settings.presets = DEFAULT_PRESETS.concat(own);
  settings.presetsV = PRESETS_VERSION;
}

// Поля правила, которых нет в форме настроек (flat, trustHome, soft), переносим со старого правила с той же меткой —
// иначе «Сохранить» превращало «👀 слежу» в обычное правило (до 1.3.89). soft — только сабы, что остались в правиле.
function keepRuleExtras(r, old) {
  var o = (old || []).filter(function (x) { return x && x.tag === r.tag; })[0];
  if (!o) return r;
  var out = Object.assign({}, r);
  if (o.flat) out.flat = o.flat;
  if (o.trustHome) out.trustHome = o.trustHome;
  if (Array.isArray(o.soft)) { var s = o.soft.filter(function (x) { return r.subs.indexOf(x) >= 0; }); if (s.length) out.soft = s; }
  return out;
}
// Старое правило «пророс паблики» показываем как «👹 орк»; правило «ру-сабы» (метило по языку) убираем.
function migrateRules(rules) {
  return (rules || []).filter(function (r) { return !(r && r.tag === 'ру-сабы'); }).map(function (r) {
    if (r && r.tag === 'пророс паблики') return Object.assign({}, r, { tag: 'орк', icon: r.icon && r.icon !== '🔍' ? r.icon : '👹' });
    return r;
  });
}

// ---------- вердикт по нахрюкам ----------
// Как человека встретили в сабах правила: up — заплюсованных постов/комментов, down — заминусованных.
//   'own'     — в основном плюсуют (>= 60%): свой среди своих → полные баллы, метка правила (👹 орк);
//   'debater' — в основном минусят (>= 60%): пришёл спорить → 0 баллов, метка «🥊 спорщик»;
//   'unclear' — оценок мало (< 3) или поровну → половина баллов, метка «🤷 орк?».
function nahrukVerdict(up, down) {
  var decided = (up || 0) + (down || 0);
  if (decided < 3) return 'unclear';
  if (up / decided >= 0.6) return 'own';
  if (down / decided >= 0.6) return 'debater';
  return 'unclear';
}

// ---------- безопасность вывода ----------
// Цвет метки подставляется в HTML — пропускаем только #rrggbb (защита от подделанного файла импорта).
function safeColor(c) {
  return /^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : '#e5484d';
}
// Ссылки на комменты — только настоящие https-ссылки на reddit (никаких javascript: и чужих сайтов).
function safeRedditLink(link) {
  try {
    var u = new URL(String(link || ''), 'https://www.reddit.com');
    if (u.protocol !== 'https:' || !/(^|\.)reddit\.com$/i.test(u.hostname)) return null;
    return u.href;
  } catch (e) { return null; }
}

function botPercent(points, half) {
  half = half > 0 ? half : HALF_DEFAULT;
  if (!(points > 0)) return 0;
  return Math.min(99, Math.max(1, Math.round(100 * (1 - Math.pow(2, -points / half)))));
}

// ---------- «🥫 консерва» ----------
// Язык текста: 'cyr' — кириллицы больше, 'lat' — латиницы больше, null — букв почти нет (ссылки, эмодзи).
function textLang(t) {
  // Ссылки и упоминания ников/сабов (u/Name, r/sub) — латиница, но это не язык автора.
  t = String(t || '').replace(/https?:\/\/\S+/g, '').replace(/\/?\b[ur]\/[A-Za-z0-9_-]+/g, '');
  var c = (t.match(/[а-яёіїєґ]/gi) || []).length;
  var l = (t.match(/[a-z]/gi) || []).length;
  if (c + l < 5) return null;
  return c > l ? 'cyr' : 'lat';
}

// Законсервированный (купленный / спящий) акк: раньше писал по-английски (часто в NSFW),
// потом пропал или просто «заговорил» кириллицей.
//   ageDays — возраст аккаунта;
//   rec  — свежая история с reddit { n, cyr, lat, cyrPosts } (последние 3 мес.);
//   prev — то, что reddit отдал старше 3 мес. { cyr, lat } — если там уже много кириллицы, это просто русскоязычный;
//   arch — архив ArcticShift { old: { n, cyr, lat, nsfw, newest }, recent: { n, cyr, lat, cyrPosts, oldest } }
//          (old — старше 3 мес., recent — последние 3 мес.; архив хранит и удалённые модераторами посты).
// Вердикт: 'full' — раньше английский (≥70%) и много NSFW (≥40%) → «🥫 консерва»;
//          'weak' — раньше почти только английский (≥90%) → «🥫 консерва?» (подозрение);
//          false — не похоже.
// Возраст: акк 2+ года — или «спящий»: между старой английской историей и свежей кириллицей перерыв 4+ мес.
var KONS = { ageDays: 730, minAge: 180, gapDays: 120, recMin: 5, recCyr: 0.5, oldMin: 5, oldLat: 0.7, oldNsfw: 0.4, weakLat: 0.9, prevCyr: 0.3 };

// Идти ли в архив: акк старше полугода, и по видимой на reddit старой истории он не писал кириллицей.
function konsNeedArch(ageDays, prev) {
  if (!(ageDays >= KONS.minAge)) return false;
  var lang = prev ? (prev.cyr || 0) + (prev.lat || 0) : 0;
  return !(lang >= 5 && prev.cyr / lang >= KONS.prevCyr);
}
// Свежая кириллица: хоть один пост — или в основном кириллические тексты (по reddit или по архиву).
function konsRecentCyr(rec, ar) {
  var srcs = [rec, ar];
  for (var i = 0; i < srcs.length; i++) {
    var x = srcs[i];
    if (!x) continue;
    if ((x.cyrPosts || 0) >= 1) return true;
    var lang = (x.cyr || 0) + (x.lat || 0);
    if (lang >= KONS.recMin && x.cyr / lang >= KONS.recCyr) return true;
  }
  return false;
}
// Перерыв (дней) между последним старым и первым свежим постом/комментом по архиву.
function konsGap(arch) {
  var o = arch && arch.old, r = arch && arch.recent;
  if (!o || !r || !o.newest || !r.oldest) return 0;
  return Math.max(0, (r.oldest - o.newest) / 86400);
}
// sleep — самое долгое молчание (konsSleep): 180+ дней и снова пишет → консерва сама по себе.
// farm — результат konsFarm: ферма кармы + кириллица сейчас → консерва; ферма без кириллицы → подозрение.
// homeDown — в «своих» сабах минусуют (homeVotes(...).hit).
// Молчал полгода+: вместе с ещё одним признаком (раньше английский, ферма, минусуют тут) — консерва,
// одно молчание — «консерва?» (люди и просто бросают reddit на полгода).
function konservaVerdict(ageDays, rec, arch, sleep, farm, homeDown) {
  if (sleep >= KONS.sleepDays) {
    var o = arch && !arch.err && arch.old, lang = o ? (o.cyr || 0) + (o.lat || 0) : 0;
    // «раньше по-английски» — признак, только если СЕЙЧАС пишет кириллицей (сменил язык); иначе это просто
    // англо-/немецкоязычный человек, который пропадал (так ловились эмигранты).
    var wasEng = lang >= KONS.oldMin && o.lat / lang >= KONS.oldLat && konsRecentCyr(rec, arch && !arch.err ? arch.recent : null);
    return wasEng || (farm && farm.hit) || homeDown ? 'full' : 'weak';
  }
  if (farm && farm.hit) return konsRecentCyr(rec, arch && !arch.err ? arch.recent : null) ? 'full' : 'weak';
  if (!arch || arch.err || !(ageDays >= KONS.minAge)) return false;
  if (!konsRecentCyr(rec, arch.recent)) return false;
  var old = arch.old || {};
  if (!(old.n >= KONS.oldMin)) return false;
  var lang = (old.cyr || 0) + (old.lat || 0);
  if (!lang) return false;
  var lat = old.lat / lang;
  // Полная — только если акк старый или пропадал и раньше было много NSFW; почти только английский раньше
  // и кириллица сейчас — подозрение «консерва?» при любом возрасте старше полугода (так попросил владелец).
  var aged = ageDays >= KONS.ageDays || konsGap(arch) >= KONS.gapDays;
  if (aged && lat >= KONS.oldLat && old.nsfw / old.n >= KONS.oldNsfw) return 'full';
  if (lat >= KONS.weakLat) return 'weak';
  return false;
}
// Почему нет метки — для подсказки у ника. Возвращает код причины.
function konservaWhyNot(ageDays, rec, arch, prev) {
  if (!(ageDays >= KONS.minAge)) return 'young';
  if (!arch) return konsNeedArch(ageDays, prev) ? 'noarch' : 'wascyr';
  if (arch.err) return 'noarch';
  if (!konsRecentCyr(rec, arch.recent)) return 'norec';
  if (!((arch.old || {}).n >= KONS.oldMin)) return 'fewold';
  return 'mixed';
}

// ---------- «спящий» акк ----------
// Самое долгое молчание (дней), которое закончилось за последний год: аккаунт полгода+ ничего не писал
// (или после регистрации «дозревал») и снова заговорил — по опыту владельца это почти всегда консерва.
//   times — даты постов/комментов (сек); created — регистрация (сек), учитывается только если история
//   полная (complete): иначе разрыв между регистрацией и самым старым из видимых 100 постов был бы ложным.
KONS.sleepDays = 180;
KONS.sleepWithin = 365;
function konsSleep(times, created, complete, nowSec) {
  var t = [];
  for (var i = 0; i < (times || []).length; i++) if (times[i] > 0) t.push(times[i]);
  if (complete && created > 0) t.push(created);
  t.sort(function (a, b) { return a - b; });
  var best = 0;
  for (var j = 1; j < t.length; j++) {
    if (t[j] >= nowSec - KONS.sleepWithin * 86400) best = Math.max(best, (t[j] - t[j - 1]) / 86400);
  }
  return best;
}

// ---------- «ферма кармы» ----------
// Типичная прокачка аккаунта под продажу: за один день фотки в кучу разных сабов (котики, природа, «Rome»),
// заголовки в пару слов, карма за посты в разы больше, чем за комменты.
// Пост-картинка: ссылка на картинку/видео/галерею reddit или imgur и без текста.
function postIsImg(url, selftext) {
  if (String(selftext || '').trim()) return false;
  return /(^https?:\/\/)?(i\.redd\.it|preview\.redd\.it|v\.redd\.it|i\.imgur\.com|imgur\.com)\/|reddit\.com\/gallery\//i.test(String(url || ''));
}
// posts — [{ t: дата (сек), s: саб, img: картинка?, words: слов в заголовке }]
// burst — больше всего разных сабов за любые сутки; imgShort — картинок с заголовком до 4 слов.
function farmStats(posts) {
  var p = [];
  for (var i = 0; i < (posts || []).length; i++) if (posts[i] && posts[i].t > 0) p.push(posts[i]);
  p.sort(function (a, b) { return a.t - b.t; });
  var burst = 0, imgShort = 0, j = 0;
  for (var k = 0; k < p.length; k++) {
    while (p[k].t - p[j].t > 86400) j++;
    var set = {}, n = 0;
    for (var m = j; m <= k; m++) if (!set[p[m].s]) { set[p[m].s] = 1; n++; }
    if (n > burst) burst = n;
    if (p[k].img && p[k].words <= 4) imgShort++;
  }
  return { posts: p.length, burst: burst, imgShort: imgShort };
}
// Признаки фермы: пачка (4+ сабов за сутки), почти одни картинки с короткими заголовками (50%+),
// карма за посты ≥ 300 и в 5+ раз больше, чем за комменты. Ферма — 2 признака из 3.
KONS.farmPosts = 4; KONS.farmBurst = 4; KONS.farmImg = 0.5; KONS.farmLink = 300; KONS.farmRatio = 5;
function konsFarm(f, linkKarma, commentKarma) {
  var r = { burst: false, img: false, ratio: false, hit: false };
  if (!f || !(f.posts >= KONS.farmPosts)) return r;
  r.burst = f.burst >= KONS.farmBurst;
  r.img = f.imgShort / f.posts >= KONS.farmImg;
  // карма неизвестна (null) — признак не считаем (раньше неизвестное становилось нулём и «ферма» срабатывала сама)
  r.ratio = linkKarma != null && commentKarma != null && linkKarma >= KONS.farmLink && linkKarma >= KONS.farmRatio * Math.max(1, commentKarma);
  r.hit = (r.burst ? 1 : 0) + (r.img ? 1 : 0) + (r.ratio ? 1 : 0) >= 2;
  return r;
}
// Карма для фермы: null — неизвестна. Архив часто отдаёт карму постов без кармы комментов (тогда там 0):
// карма комментов 0 при заплюсованных комментах (score ≥ 2) невозможна — считаем её неизвестной (1.3.78).
function farmKarma(lk, ck, votes, votesP) {
  var ups = 0, s;
  for (s in votes || {}) ups += (votes[s] && votes[s].up) || 0;
  for (s in votesP || {}) ups -= (votesP[s] && votesP[s].up) || 0;
  var L = typeof lk === 'number' ? lk : null, C = typeof ck === 'number' ? ck : null;
  if (C === 0 && ups > 0) C = null;
  return { lk: L, ck: C };
}
// Слов в заголовке
function titleWords(t) { return String(t || '').trim().split(/\s+/).filter(Boolean).length; }

// ---------- «минусуют тут» ----------
// В «своих» сабах (настройка autoSubs, по умолчанию tjournal_refugees) человека в основном минусуют,
// а в других сабах — плюсуют (карму набирает снаружи). Чужой: тролль, спорщик с той стороны или купленный акк.
//   votes — { саб: { up, down } }, home — список «своих» сабов.
function homeVotes(votes, home) {
  var r = { up: 0, down: 0, eUp: 0, eDown: 0, hit: false, contrast: false };
  var set = {};
  for (var i = 0; i < (home || []).length; i++) set[String(home[i]).toLowerCase()] = 1;
  for (var s in votes || {}) {
    var v = votes[s] || {};
    if (set[s]) { r.up += v.up || 0; r.down += v.down || 0; } else { r.eUp += v.up || 0; r.eDown += v.down || 0; }
  }
  var d = r.up + r.down, e = r.eUp + r.eDown;
  // 60%+ минусов — или 8+ минусов при 30%+ в минусе. В tj минусуют редко (медиана 93% плюсов), так что <70% плюсов —
  // это нижние ~10% саба (владелец, 09.11; было 20+ минусов).
  r.hit = (d >= 3 && r.down / d >= 0.6) || (r.down >= 8 && r.down / d >= 0.3);
  r.contrast = r.hit && r.down / d >= 0.6 && e >= 5 && r.eUp / e >= 0.6;
  return r;
}

// ---------- метки правил по сабам (общий расчёт для расширения, скрипта и тестов) ----------
// subs/votes — счётчики по сабам { саб: n } и { саб: { up, down } }; home — «свои» сабы (autoSubs).
// Коды для сервера: own → 'ork' | 'clown' | 'watch'; поровну/мало оценок → с «?»;
// минусуют → спорщик С ИСТОЧНИКОМ: 'deb_ork' | 'deb_clown' | 'deb_watch' (раньше был общий 'debater').
// ev[code] — цифры именно этого источника (для подсказки).
// Пост весит как POST_W комментов — и в счёте, и в оценках (владелец, 09.11: «пост не равен коменту»).
// subs/votes — посты И комменты вместе; subsP/votesP — только посты (их добавляем ещё POST_W−1 раз).
var POST_W = 3;
// Спорщик (стабильно минусуют в орочьих/клоунских/«слежу» сабах) — говорит в пользу человека: −1 балл за источник
// (владелец, 09.11). Сумма автобаллов ниже нуля не опускается, жалобы людей это не трогает.
var DEBATER_POINTS = -1;
// Оценки (up/down) — по РЕАЛЬНЫМ записям: один заплюсованный пост — одно подтверждение, а не три (1.3.78, владелец
// и ГПТ, 09.11). Вес поста ×3 — только в n (объём активности → баллы). upW/downW — с весом, для справки.
function ruleCount(r, subs, votes, subsP, votesP) {
  var o = { n: 0, up: 0, down: 0, upW: 0, downW: 0, posts: 0, comments: 0 };
  var soft = r.soft || [];
  // core* — то же без «мягких» сабов (r.soft): по ним одним уверенной метки не бывает (ruleVerdictOf).
  if (soft.length) { o.coreN = 0; o.coreUp = 0; o.coreDown = 0; }
  for (var j = 0; j < r.subs.length; j++) {
    var s = r.subs[j], all = (subs || {})[s] || 0, p = (subsP || {})[s] || 0;
    o.posts += p; o.comments += Math.max(0, all - p);
    if (all) { o.bySub = o.bySub || {}; o.bySub[s] = all; } // разбивка по сабам — только числа (1.3.90, окно ника)
    o.n += all + (POST_W - 1) * p;
    var v = (votes || {})[s], vp = (votesP || {})[s];
    if (v) { o.up += v.up || 0; o.down += v.down || 0; o.upW += v.up || 0; o.downW += v.down || 0; }
    if (soft.length) {
      if (soft.indexOf(s) >= 0) { if (all) o.soft = true; }
      else { o.coreN += all + (POST_W - 1) * p; if (v) { o.coreUp += v.up || 0; o.coreDown += v.down || 0; } }
    }
    if (vp) { o.upW += (POST_W - 1) * (vp.up || 0); o.downW += (POST_W - 1) * (vp.down || 0); }
  }
  return o;
}
// Уверенный «👹 орк» / «🤡 клоун» — только с RULE_SURE_N нахрюков (с весом поста); 3–5 — лишь «?» (владелец, 09.11:
// «орк ×4 — раннее обвинение»). «👀 слежу» не трогаем — там балл фиксированный.
var RULE_SURE_N = 6;
var RULE_SURE_UP = 5; // и 5+ заплюсованных ЗАПИСЕЙ: «60%» от 3–4 оценок — не статистика (владелец, 09.11)
var RULE_SURE_CODES = ['ork', 'clown'];
function ruleVerdictOf(r, o) {
  var v = nahrukVerdict(o.up, o.down);
  if (v === 'own' && (o.n < RULE_SURE_N || (o.up || 0) < RULE_SURE_UP) && RULE_SURE_CODES.indexOf(RULE_CODES[r.tag]) >= 0) return 'unclear';
  // «Мягкие» сабы (r.soft, 1.3.89): дают максимум «?». Уверенная метка — только если её набирают остальные сабы правила.
  if (v === 'own' && o.soft) {
    var cv = nahrukVerdict(o.coreUp, o.coreDown);
    if (cv !== 'own' || o.coreN < RULE_SURE_N || (o.coreUp || 0) < RULE_SURE_UP) return 'unclear';
  }
  return v;
}
function ruleVerdicts(subs, votes, home, subsP, votesP) {
  var tags = [], ev = {};
  for (var i = 0; i < DEFAULT_RULES.length; i++) {
    var r = DEFAULT_RULES[i], code = RULE_CODES[r.tag];
    if (!code) continue;
    var o = ruleCount(r, subs, votes, subsP, votesP);
    ev[code] = o;
    if (o.n >= (r.min || 1) && !ruleHidden(r, votes, home)) {
      var ov = ruleVerdictOf(r, o);
      var t = ov === 'own' ? code : ov === 'debater' ? 'deb_' + code : code + '?';
      if (tags.indexOf(t) < 0) tags.push(t);
    }
  }
  return { tags: tags, ev: ev };
}
// Разбор кода метки правила с сервера: { kind: 'ork'|'clown'|'watch', verdict: 'own'|'unclear'|'debater' } или null.
// Старый общий 'debater' (до разделения) считаем орочьим.
function parseRuleCode(t) {
  if (t === 'debater') return { kind: 'ork', verdict: 'debater' };
  var m = /^(deb_)?(ork|clown|watch)(\?)?$/.exec(String(t || ''));
  if (!m) return null;
  return { kind: m[2], verdict: m[1] ? 'debater' : m[3] ? 'unclear' : 'own' };
}
var RULE_KIND = { ork: { icon: '👹', tag: 'орк' }, clown: { icon: '🤡', tag: 'клоун' }, watch: { icon: '👀', tag: 'слежу' } };

// ---------- «свій» — местный в tj ----------
// Давно и много пишет в «своих» сабах (autoSubs) и там его плюсуют: 100+ заплюсованных и 85%+ из оценённых.
// Такому: слабые подозрения («?», «👀 слежу») не показываем, баллы автометок — пополам; сильные метки остаются.
var TRUST = { up: 100, share: 0.85 }; // верхняя четверть по плюсам; доля 85%+ (в tj минусят редко, медиана 93%)
// Второй путь (1.3.79, владелец + ГПТ, 09.11): архив/reddit видят только ~100 последних комментов — 100+ плюсов недостижимы.
// Если история комментов упёрлась в лимит (видно 100+), хватает 60+ заплюсованных КОММЕНТОВ в tj при 85%+.
// «Свій» — характеристика активности в tj, а не индульгенция: по новому пути уверенные орк/клоун НЕ ослабляются.
var TRUST_NEW = { up: 60, share: 0.85, comments: 100 };
// Цифры для «свій»: up/down — все оценённые записи в «своих» сабах; cUp/cDown — только комменты; trunc — видно 100+ комментов.
function homeStats(votes, home, votesP, comments) {
  var r = { up: 0, down: 0, cUp: 0, cDown: 0, trunc: (comments || 0) >= TRUST_NEW.comments };
  for (var i = 0; i < (home || []).length; i++) {
    var k = String(home[i]).toLowerCase(), v = (votes || {})[k], p = (votesP || {})[k];
    if (v) { r.up += v.up || 0; r.down += v.down || 0; r.cUp += v.up || 0; r.cDown += v.down || 0; }
    if (p) { r.cUp -= p.up || 0; r.cDown -= p.down || 0; }
  }
  return r;
}
// way: 'old' — 100+ плюсов (прежнее влияние на баллы), 'new' — 60+ комментов при обрезанной истории, null — не «свій».
function trustOf(st) {
  st = st || {};
  var up = st.up || 0, down = st.down || 0, d = up + down;
  var cu = st.cUp || 0, cd = (st.cUp || 0) + (st.cDown || 0);
  var old = up >= TRUST.up && d > 0 && up / d >= TRUST.share;
  var neu = !old && !!st.trunc && cu >= TRUST_NEW.up && cd > 0 && cu / cd >= TRUST_NEW.share;
  return { up: up, down: down, cUp: cu, cDown: st.cDown || 0, trusted: old || neu, way: old ? 'old' : neu ? 'new' : null };
}
function homeTrust(votes, home, votesP, comments) { return trustOf(homeStats(votes, home, votesP, comments)); }
// Баллы метки у «свого»: слабые не показываем (isWeakHit), остальное пополам — кроме уверенных орка/клоуна у «свого»
// по новому пути (их не ослабляем).
function trustedPoints(h, way) {
  var code = h.kind || RULE_CODES[h.tag];
  if (way === 'new' && h.verdict === 'own' && (code === 'ork' || code === 'clown')) return h.points || 0;
  return (h.points || 0) / 2;
}

// ---------- баллы метки правила (вариант C, 1.3.79) ----------
// full — баллы правила за нахрюки. Спорщик — DEBATER_POINTS, свой там — full. «?» — половина, но если оценок 3+ и минусов
// много, баллы плавно уходят к нулю: при 40% минусов — половина, при 60% — 0 (дальше спорщик). Так одна оценка не даёт
// скачка «?» ↔ спорщик на десятки процентов (было до 55 п.п., стало ≤14). Определение спорщика не меняется.
function ruleHitPoints(full, verdict, up, down) {
  if (verdict === 'debater') return DEBATER_POINTS;
  if (verdict === 'own') return full;
  var d = (up || 0) + (down || 0);
  if (d < 3) return full / 2;
  var f = (0.6 - (down || 0) / d) / 0.2;
  return (full / 2) * Math.max(0, Math.min(1, f));
}
// Слабая метка: «?»-варианты, «консерва?», любая «👀 слежу».
function isWeakHit(h) {
  // 1.3.89 (владелец, 11.11): «клоун» (метка места) у «свого» тоже сворачивается; спорщик (−1) остаётся
  // 1.3.90 (владелец, 11.11): у «свого» прячется ЛЮБАЯ консерва — после банов люди заново заезжают в tj и набирают карму
  return !!h && (h.verdict === 'unclear' || !!h.kons || h.tag === 'слежу' || (h.tag === 'клоун' && h.verdict !== 'debater'));
}

// ---------- сервисные боты ----------
// Пишут, когда их позовут (AskGrok, RemindMeBot…), а не по своей воле — правила про людей к ним неприменимы.
// Их не проверяем и меток не ставим, только нейтральная плашка «🤖 сервис-бот».
var SERVICE_BOTS = ['automoderator', 'askgrok', 'grok', 'remindmebot', 'savevideo', 'savevideobot', 'stabbot',
  'vredditdownloader', 'sneakpeekbot', 'wikisummarizerbot', 'repostsleuthbot', 'tldrbot', 'reddit-user-identifier',
  'gifreversingbot', 'converter-bot', 'b0trank', 'bot-sleuth-bot'];
function isServiceBot(name) { return SERVICE_BOTS.indexOf(String(name || '').toLowerCase()) >= 0; }

// ---------- кэш серверных вердиктов (rt_srv) ----------
// Ответ сервера про вердикты владельца. Достоверны только ответы ОСНОВНОГО сервера: открытый /verdicts (open) или
// /lookup общего слоя (pub). Ответ своей группы не годится — у группы может быть другой сервер, без вердиктов.
// Возвращает { ник: вердикт } (пустой объект = сервер ответил «ни у кого нет») или null = ответа нет / он битый.
function srvVerdictsFrom(open, pub) {
  var srcs = [open, pub];
  for (var i = 0; i < srcs.length; i++) {
    var x = srcs[i];
    if (x && typeof x === 'object' && x.verdicts && typeof x.verdicts === 'object' && !Array.isArray(x.verdicts)) return x.verdicts;
  }
  return null;
}
// Годится ли вердикт в кэш: объект со списком меток.
function srvVerdictOk(v) { return !!v && typeof v === 'object' && Array.isArray(v.tags); }
// cache: { ник: { v, t } }; names — о ком спрашивали; verdicts — результат srvVerdictsFrom.
// Три случая, по каждому нику отдельно (остальные записи не трогаем):
//   сервер дал вердикт → заменить; сервер ответил, а вердикта нет → удалить; ответа нет (null) → оставить как было.
// Битый вердикт (без списка меток) — как отсутствие ответа по этому нику: кэш не трогаем.
// Возвращает true, если кэш изменился.
function srvCacheMerge(cache, names, verdicts, now) {
  var changed = false;
  if (!verdicts || typeof verdicts !== 'object') return false;
  for (var i = 0; i < names.length; i++) {
    var k = names[i], x = verdicts[k];
    if (x == null) { if (cache[k]) { delete cache[k]; changed = true; } }
    else if (srvVerdictOk(x)) { cache[k] = { v: x, t: now }; changed = true; }
  }
  return changed;
}
// Что показывать: свежий ответ сервера (fresh: вердикт / null = нет / undefined = ещё не спрашивали или ошибка),
// иначе — запомненное (не старше ttl). stale: true — из памяти, а сервер в последний раз не ответил (failed).
// skip — «перевірити заново»: запомненное не показываем, ждём сервер / свою проверку.
function srvPick(fresh, cached, now, ttl, failed, skip) {
  if (fresh !== undefined) return srvVerdictOk(fresh) ? fresh : null;
  if (skip || !cached || !(now - cached.t < ttl) || !srvVerdictOk(cached.v)) return null;
  if (!failed) return cached.v;
  var o = {};
  for (var key in cached.v) o[key] = cached.v[key];
  o.stale = true;
  return o;
}

// ---------- согласие на отправку в очередь владельцу (1.3.80) ----------
// helpQueue: true — согласился, false — отказался, всё остальное (не спрашивали) — спросить.
function queueConsent(v) { return v === true ? 'yes' : v === false ? 'no' : 'ask'; }
// Что делать с только что проверенным ником: 'send' — в очередь на отправку, 'hold' — придержать в памяти до ответа
// (и показать вопрос), 'drop' — ничего не делать. До «Так» в сеть не уходит ничего.
function queueAction(v) { var c = queueConsent(v); return c === 'yes' ? 'send' : c === 'no' ? 'drop' : 'hold'; }

// ---------- вид значков (1.3.82) ----------
// Сворачивать длинные метки в «значок + число»: mode 'always' | 'never' | 'auto' (по умолчанию — когда меток 3+).
// labels — сколько меток у ника показываем (без нахрюкометра и значка «свій»).
function badgesCompact(mode, labels) {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return (labels || 0) >= 3;
}
// «Своим» нахрюкометр ниже 10% не показываем (владелец, 11.11): мелочь у активного участника tj — шум.
var TRUST_HIDE_PCT = 10;
function meterHidden(pct, trusted) { return !!trusted && (pct || 0) < TRUST_HIDE_PCT; }

// ---------- откуда брать метки ника (1.3.88) ----------
// Серверный вердикт (проверка владельца через архив, полнее и сверен) главнее своей проверки расширения: своя через
// reddit не видит часть сабов (пример: своя — «свій», архив — орк). Своя показывается отдельной строкой и ничего не
// перекрывает. server — есть ли серверный вердикт (свежий или в памяти браузера по правилам srvPick); local — есть
// своя законченная проверка. Возвращает 'server' | 'local' | 'none'.
function hitsSource(server, local) { return server ? 'server' : local ? 'local' : 'none'; }
