// АВТОСБОРКА tools/gen-server-check.mjs из reddit-tagger/score.js + reddit-tagger/background.js. НЕ ПРАВИТЬ РУКАМИ.
// Сервер вызывает archFull (запросы к архиву) и archVerdict (метки) — так же, как расширение и tools/check-tj.mjs.
/* eslint-disable */
// Заглушки браузерных API: фоновый скрипт расширения при загрузке вешает обработчики — на сервере они ничего не делают.
const noop = { addListener() {} };
const chrome = { runtime: { onMessage: noop, getManifest: () => ({ version: 'server' }) }, action: { onClicked: noop },
  storage: { local: { get: async () => ({}), set: async () => {} } }, tabs: { create() {} } };
const importScripts = undefined;
const setLang = () => {};
const T = (s) => s;
const N = (n, f) => (+n || 0) + ' ' + String(f).split('|')[2];
// archGate — общий «шлагбаум» к архиву (как в check-tj): сервер подставляет свой счётчик запросов (лимит Cloudflare).
let archGate = null;
export function setArchGate(g) { archGate = g; }
// archFetchImpl — запрос к архиву через кэш сервера (D1): успешные ответы переиспользуются при повторе.
let archFetchImpl = null;
export function setArchFetch(f) { archFetchImpl = f; }

// ===== reddit-tagger/score.js =====
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
function badgesCompact(mode, labels, narrow) {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  // авто: при 3+ метках, а на телефоне / узком окне — всегда (13.11: на мобильном reddit ник урезался до «Respo…»)
  return !!narrow || (labels || 0) >= 3;
}
// Число у метки правила — РЕАЛЬНЫЕ записи (посты + комменты). Вес поста ×3 — только в баллах (13.11: «×57» из 18 постов
// и 3 комментов читали как «57 орков»). Для меток без разбивки — n как есть.
function hitCount(h) {
  var n = function (x) { var v = Math.floor(+x); return isFinite(v) && v > 0 ? v : 0; };
  return h && h.posts != null && h.comments != null ? n(h.posts) + n(h.comments) : n(h && h.n);
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

// ---------- вердикт по данным архива (1.3.91): общий для check-tj и сервера (автоочередь) ----------
// a — ответ archFull (background.js); home — «свои» сабы; nowMs — время проверки. Как autoHits в content.js.
// raw — сабы и оценки по ним (не публикуются): при смене правил вердикт пересчитывается без нового скана.
function archVerdict(a, home, nowMs) {
  var now = nowMs || Date.now();
  var sumv = function (o) { var t = 0; for (var k in o || {}) t += o[k] || 0; return t; };
  var age = a.first > 0 ? (now / 1000 - a.first) / 86400 : 0;
  var rec = { n: a.recent.n, cyr: a.recent.cyr, lat: a.recent.lat, cyrPosts: a.recent.cyrPosts, sleep: Math.round(a.sleep || 0) };
  var fk = farmKarma(a.lk, a.ck, a.votes, a.votesP); // неизвестная карма — null
  var farm = konsFarm(a.farm, fk.lk, fk.ck);
  var tags = [];
  var hv = homeVotes(a.votes, home);
  var kv = konservaVerdict(age, rec, a, a.sleep || 0, farm, hv.hit);
  if (kv === 'full') tags.push('kons'); else if (kv === 'weak') tags.push('kons?');
  if (hv.hit) tags.push('homedown');
  var rt = ruleVerdicts(a.subs, a.votes, home, a.subsP, a.votesP);
  for (var i = 0; i < rt.tags.length; i++) tags.push(rt.tags[i]);
  if (!tags.length) tags.push('clean');
  var st = homeStats(a.votes, home, a.votesP, sumv(a.subs) - sumv(a.subsP));
  var nn = function (x) { return x == null ? null : x; };
  var ev = {
    age: Math.round(age), sleep: Math.round(a.sleep || 0), lk: nn(a.lk), ck: nn(a.ck),
    farm: a.farm ? { posts: a.farm.posts, burst: a.farm.burst, imgShort: a.farm.imgShort } : null,
    old: { n: a.old.n, cyr: a.old.cyr, lat: a.old.lat, nsfw: a.old.nsfw },
    rec: { n: rec.n, cyr: rec.cyr, lat: rec.lat, cyrPosts: rec.cyrPosts },
    by: 'auto', // скриптовый/серверный вердикт, не ручной («автоперевірка Хрюнебота»)
    home: { up: hv.up, down: hv.down, eUp: hv.eUp, eDown: hv.eDown, cUp: st.cUp, cDown: st.cDown, trunc: st.trunc },
    ork: rt.ev.ork || { n: 0, up: 0, down: 0 }, clown: rt.ev.clown || null, watch: rt.ev.watch || null
  };
  return { tags: tags, ev: ev, raw: { subs: a.subs || {}, votes: a.votes || {}, subsP: a.subsP || {}, votesP: a.votesP || {} } };
}

// ---------- карточка ника человеческим языком (1.3.96: окно ника в расширении и Telegram-бот) ----------
// Метки из серверного вердикта (tags + ev) — в том же виде, что и своя проверка расширения (раньше — srvHits в content.js).
// opt — настройки показа: konsOn, konsPoints, konsWeakPoints, homeDownOn, clownOn (выключенное не возвращаем).
// Любое значение с сервера/из памяти → неотрицательное целое (в разметку попадает только число)
function num(x) { var n = Math.floor(+x); return isFinite(n) && n > 0 ? n : 0; }
function hitsFromVerdict(v, opt) {
  opt = opt || {};
  if (!v || !v.tags) return [];
  var ev = v.ev || {}, out = [];
  var base = function () { return { srv: v, n: 1, where: [] }; };
  for (var i = 0; i < v.tags.length; i++) {
    var t = v.tags[i], h = base();
    if (t === 'kons' || t === 'kons?') {
      if (opt.konsOn === false) continue;
      h.icon = '🥫'; h.tag = 'консерва'; h.kons = t === 'kons' ? 'full' : 'weak';
      h.points = t === 'kons' ? (opt.konsPoints != null ? opt.konsPoints : 4) : (opt.konsWeakPoints != null ? opt.konsWeakPoints : 1);
      out.push(h);
    } else if (t === 'homedown' && opt.homeDownOn !== false) {
      var hd = ev.home || { up: 0, down: 0, eUp: 0, eDown: 0 };
      var hv = homeVotes({ a: { up: num(hd.up), down: num(hd.down) }, b: { up: num(hd.eUp), down: num(hd.eDown) } }, ['a']);
      h.icon = '👎'; h.tag = 'минусуют'; h.homeDown = hv; h.n = num(hd.down); h.points = hv.contrast ? 2 : 1;
      out.push(h);
    } else if (parseRuleCode(t)) {
      var pr = parseRuleCode(t), kind = pr.kind, o = ev[kind] || { n: 0 };
      if (kind === 'clown' && opt.clownOn === false) continue;
      var full = srvRuleFull(kind, num(o.n));
      h.icon = RULE_KIND[kind].icon; h.tag = RULE_KIND[kind].tag; h.kind = kind; h.n = num(o.n); h.up = num(o.up); h.down = num(o.down);
      h.posts = o.posts == null ? undefined : num(o.posts); h.comments = o.comments == null ? undefined : num(o.comments);
      h.bySub = o.bySub && typeof o.bySub === 'object' ? o.bySub : null; h.verdict = pr.verdict;
      h.points = ruleHitPoints(full, h.verdict, h.up, h.down);
      out.push(h);
    }
  }
  return out;
}
// «?» — метка с неуверенностью (оценки смешанные, «консерва?»)
function hitUnsure(h) { return !!h && (h.verdict === 'unclear' || h.kons === 'weak'); }
// Короткое имя метки для значка/заголовка: «👹 орк», «🥫 консерва», «👎 мінусують», «🥊 сперечальник 👹»
function hitName(h) {
  var name = function (tg) { return tg === 'слежу' ? T('слежу') : tg === 'клоун' ? T('клоун') : tg === 'орк' ? T('орк') : tg; };
  if (h.trust) return T('свой');
  if (h.acc) return '❗ ' + T('новорег');
  if (h.kons) return '🥫 ' + T('консерва');
  if (h.homeDown) return '👎 ' + T('минусуют тут');
  if (h.hiddenP) return '🙈 ' + T('профиль скрыт');
  if (h.verdict === 'debater') return '🥊 ' + T('спорщик') + (h.icon ? ' ' + h.icon : '');
  return (h.icon || '🔍') + ' ' + name(h.tag);
}
// Почему метка: одна фраза человеческим языком, только числа (без дат активности и текстов). Возвращает строку.
function hitWhy(h) {
  var subs = function () {
    if (h.bySub && typeof h.bySub === 'object') {
      var a = [];
      for (var s in h.bySub) if (+h.bySub[s] > 0) a.push('r/' + String(s).replace(/[^\w]/g, ''));
      if (a.length) return a.join(', ');
    }
    return (h.where || []).map(function (w) { return 'r/' + w[0]; }).join(', ') || T('сабы правила');
  };
  var cnt = h.posts != null ? T('{p} и {c}', { p: N(h.posts || 0, 'пост|поста|постов'), c: N(h.comments || 0, 'коммент|коммента|комментов') }) : N(hitCount(h), 'запись|записи|записей');
  if (h.trust) {
    return h.trust.way === 'new'
      ? T('В r/tjournal_refugees в плюсе {u} из {t} — активный участник', { u: h.trust.cUp, t: N(h.trust.cUp + h.trust.cDown, 'оценённого коммента|оценённых комментов|оценённых комментов') })
      : T('В r/tjournal_refugees в плюсе {u} из {t} — активный участник', { u: h.trust.up, t: N(h.trust.up + h.trust.down, 'оценённой записи|оценённых записей|оценённых записей') });
  }
  if (h.acc) return T('Аккаунту {d}', { d: N(h.days, 'день|дня|дней') });
  if (h.hiddenP) return T('Карма есть, а посты и комменты скрыты — так делают и обычные люди');
  if (h.homeDown) {
    var hd = h.homeDown;
    return T('В TJ в минусе {d} из {t}', { d: hd.down, t: N(hd.up + hd.down, 'оценённой записи|оценённых записей|оценённых записей') }) +
      (hd.contrast ? T(', а вне TJ в плюсе {u} из {e}', { u: hd.eUp, e: hd.eUp + hd.eDown }) : '');
  }
  if (h.kons) {
    var ev = (h.srv && h.srv.ev) || {};
    var sleep = h.sleep != null ? h.sleep : ev.sleep;
    var lead = h.kons === 'weak' ? T('Возможно, «консерва» (купленный или долго лежавший аккаунт)') : T('Похоже на «консерву» (купленный или долго лежавший аккаунт)');
    var why = sleep >= 180 ? T('молчал {s}, потом снова пишет', { s: N(sleep, 'день|дня|дней') })
      : (h.farm && h.farm.hit) || (ev.farm && ev.farm.burst >= 4) ? T('похоже на ферму кармы')
      : T('раньше писал по-английски, теперь — кириллицей');
    return lead + ': ' + why;
  }
  if (h.verdict === 'debater') return T('Пишет в {s} ({c}), но там его минусуют (+{u}/−{d}) — спорит с ними', { s: subs(), c: cnt, u: h.up || 0, d: h.down || 0 });
  if (h.verdict === 'unclear') return T('Пишет в {s} ({c}); оценки там смешанные или их мало (+{u}/−{d}) — поэтому с «?»', { s: subs(), c: cnt, u: h.up || 0, d: h.down || 0 });
  return T('Пишет в {s} ({c}), и там его плюсуют (+{u}/−{d})', { s: subs(), c: cnt, u: h.up || 0, d: h.down || 0 });
}
// Источник метки для карточки: auto (автоматика) | owner (проверено владельцем) | own (ваша проверка в браузере)
function hitSource(h) {
  if (h && h.srv) return h.srv.ev && h.srv.ev.by === 'manual' ? 'owner' : 'auto';
  return 'own';
}
// Сколько меток показывать у ника, остальное — под «+N» (раскрывается нажатием): на узком экране 1, иначе 2.
function badgeLimit(mode, narrow) { return mode === 'never' ? 99 : narrow ? 1 : 2; }


// ===== reddit-tagger/background.js =====
// Chrome: фон — service worker, i18n.js подключаем сами.
// Firefox: фон — обычные скрипты, i18n.js уже подключён манифестом (importScripts там нет).
if (typeof T === 'undefined' && typeof importScripts === 'function') importScripts('i18n.js', 'score.js', 'sync.js');

async function syncLang() {
  try { const { rt_settings: s = {} } = await chrome.storage.local.get('rt_settings'); setLang(s.lang); } catch { /* по умолчанию uk */ }
}

// При установке сразу открываем страницу расширения: там вопрос «Допомагати поповнювати базу?» (1.3.85).
// Тем, кто обновился и ещё не отвечал, вопрос покажется узкой полоской на reddit (content.js).
// (?. — этот же файл грузит tools/check-tj.mjs в песочнице с заглушкой chrome.*, где onInstalled нет)
chrome.runtime?.onInstalled?.addListener((d) => {
  if (d && d.reason === 'install') {
    try { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); } catch { chrome.runtime.openOptionsPage(); }
  }
});

// Клик по иконке расширения открывает список юзеров.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

const DEFAULT_SERVER = 'https://reddit-tagger.reddit-tagger-server.workers.dev';

// Все запросы к серверу идут через фон (у content-скрипта на reddit свои CORS-ограничения).
// Сообщение: { type: 'api', path: '/lookup', body?: {...}, server?: 'https://...', pub?: true }
//   pub: true — запрос в общий слой жалоб (все пользователи), иначе — в свою группу.
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.type !== 'api') return;
  syncLang().then(() => (msg.admin ? adminApi(msg) : msg.open ? request(DEFAULT_SERVER, msg.path, msg.body) : msg.pub ? pubApi(msg) : api(msg))).then(
    (data) => send({ ok: true, data }),
    (e) => send({ ok: false, error: e.message || String(e) }),
  );
  return true;
});

async function request(base, path, body, token, adminKey) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  if (adminKey) headers['x-admin-key'] = adminKey;
  const res = await fetch(base.replace(/\/+$/, '') + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Сервер отвечает по-русски; переводим известные сообщения через словарь.
    const e = new Error(data.error ? T(data.error) : T('Ошибка сервера {n}', { n: res.status }));
    e.status = res.status;
    throw e;
  }
  return data;
}

async function api({ path, body, server }) {
  const { rt_group: g = {} } = await chrome.storage.local.get('rt_group');
  const base = server || g.server;
  if (!base) throw new Error(T('Сервер не настроен'));
  return request(base, path, body, server ? null : g.token);
}

// Админка владельца сервера: ключ хранится только в этом браузере.
async function adminApi({ path, body }) {
  const { rt_admin: a = {} } = await chrome.storage.local.get('rt_admin');
  if (!a.key) throw new Error(T('Ключ админа не задан'));
  return request(DEFAULT_SERVER, path, body, null, a.key);
}

// ---------- общий слой ----------
let joining = null;

// any: токен нужен не для голосов, а для синхронизации (п.15) — она работает и при выключенном общем слое
async function pubToken(forceNew, any) {
  const { rt_pub: p = {}, rt_settings: s = {} } = await chrome.storage.local.get(['rt_pub', 'rt_settings']);
  if (s.pubOn === false && !any) throw new Error(T('Общие жалобы выключены'));
  if (p.token && !forceNew) return p.token;
  // Один вход на все вкладки сразу.
  joining ??= request(DEFAULT_SERVER, '/join', { code: 'public' })
    .then(async (r) => {
      await chrome.storage.local.set({ rt_pub: { token: r.token, joined: Date.now() } });
      return r.token;
    })
    .finally(() => { joining = null; });
  return joining;
}

async function pubApi({ path, body }) {
  try {
    return await request(DEFAULT_SERVER, path, body, await pubToken());
  } catch (e) {
    if (e.status !== 401) throw e;
    return request(DEFAULT_SERVER, path, body, await pubToken(true)); // токен потерян — входим заново
  }
}

// Базовые метки, поставленные до 1.3.63, разово отправляем в общий слой (дальше их шлёт окно метки).
async function pushOldPublicTags() {
  try {
    const { rt_users: us = {}, rt_settings: s = {}, rt_pubTags: done } = await chrome.storage.local.get(['rt_users', 'rt_settings', 'rt_pubTags']);
    if (done || s.pubOn === false) return;
    const items = Object.values(us)
      .map((u) => ({ user: u.name, tags: (u.tags || []).filter((t) => DEFAULT_PRESETS.includes(t)), sub: u.taggedIn || null }))
      .filter((x) => x.user && x.tags.length);
    for (let i = 0; i < items.length; i += 100) await pubApi({ path: '/vote', body: { items: items.slice(i, i + 100) } });
    await chrome.storage.local.set({ rt_pubTags: Date.now() });
  } catch { /* нет сети или лимит — попробуем при следующем запуске */ }
}
pushOldPublicTags();

// ---------- архив (ArcticShift) для «🥫 консервы» ----------
// Content-скрипт просит статистику истории юзера: { type: 'arch', user, split (сек) } — split делит историю
// на старую (раньше) и свежую (позже). Берём только сабы, NSFW-флаг, язык и даты — сами тексты дальше фона
// не уходят и не сохраняются.
const ARCH = 'https://arctic-shift.photon-reddit.com/api';
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.type !== 'arch' && msg?.type !== 'gaps') return;
  (msg.type === 'gaps' ? gapProbe(String(msg.user || ''), +msg.from || 0, +msg.created || 0) : msg.full ? archFull(String(msg.user || ''), +msg.split || 0) : archStats(String(msg.user || ''), +msg.split || 0, +msg.created || 0)).then(
    // bgv — версия фона: content сверяет её со своей и предупреждает, если браузер не перезапустил фон.
    (data) => send({ ok: true, data, bgv: chrome.runtime.getManifest().version }),
    (e) => send({ ok: false, error: e.message || String(e), bgv: chrome.runtime.getManifest().version }),
  );
  return true;
});

// Полнота ответа архива — по ТИПУ запроса (13.11, ГПТ: «200 и массив объектов полноту не подтверждают»).
// Ответ должен соответствовать именно этому запросу: 200, без поля error, список data не длиннее limit; у постов и
// комментов — дата (число) и саб (строка), даты внутри запрошенного окна after/before, порядок — как в sort;
// у профиля (users/search) — автор (строка). Иначе — неуспех: повтор, а не данные для вердикта и не кэш.
function archOk(url, ok, j) {
  if (!ok || !j || typeof j !== 'object' || j.error || !Array.isArray(j.data)) return false;
  let q;
  try { q = new URL(url).searchParams; } catch { return false; }
  const limit = +q.get('limit') || 100;
  if (j.data.length > limit) return false;
  const isUsers = /\/users\/search/.test(url);
  const after = +q.get('after') || 0, before = +q.get('before') || 0, sort = q.get('sort') || 'desc';
  const needSub = (q.get('fields') || '').split(',').indexOf('subreddit') >= 0;
  let prev = null;
  for (const x of j.data) {
    if (!x || typeof x !== 'object') return false;
    if (isUsers) { if (typeof x.author !== 'string') return false; continue; }
    const t = x.created_utc;
    if (typeof t !== 'number' || !(t > 0)) return false;
    if ((after && t < after) || (before && t > before)) return false;
    if (needSub && typeof x.subreddit !== 'string') return false;
    if (prev !== null && (sort === 'asc' ? t < prev : t > prev)) return false;
    prev = t;
  }
  return true;
}

const POST_FIELDS = 'subreddit,over_18,title,selftext,created_utc,score,url';
const COMMENT_FIELDS = 'subreddit,body,created_utc,score';

// Архив под нагрузкой отвечает «Timeout. Maybe slow down a bit» — повторяем терпеливее: паузы растут,
// со второй попытки просим меньше записей (серверу легче). trunc — список упёрся в лимит (виден не весь).
const ARCH_WAIT = [3000, 8000, 15000];
// Общий «шлагбаум» к архиву. В браузере его нет (no-op). Скрипт массовой проверки (tools/check-tj.mjs) подставляет
// archGate: общий на все окна лимит одновременных запросов и общая пауза после «slow down».
// archFetchImpl — подмена запроса (1.3.91): сервер подставляет кэш успешных ответов в D1, чтобы при частичной ошибке
// повторять только упавший запрос. В браузере и check-tj его нет — обычный fetch.
async function archFetch(url) {
  const gate = typeof archGate === 'object' && archGate ? archGate : null;
  const f = typeof archFetchImpl === 'function' ? archFetchImpl : fetch;
  if (gate) await gate.acquire();
  try { return await f(url, { signal: AbortSignal.timeout(20000) }); } finally { if (gate) gate.release(); }
}

async function archGet(kind, user, range, fields) {
  let why = '';
  for (let i = 0; i <= ARCH_WAIT.length; i++) {
    const limit = i === 0 ? 100 : 50;
    const u = `${ARCH}/${kind}/search?author=${encodeURIComponent(user)}&limit=${limit}&sort=desc&${range}&fields=${fields}`;
    let r, j;
    try {
      r = await archFetch(u); // архив иногда виснет — не ждём вечно (таймаут в archFetch)
      j = await r.json().catch(() => ({}));
    } catch (e) { r = { ok: false, status: 0 }; j = { error: e.name === 'TimeoutError' ? 'timeout' : 'network' }; }
    const gate = typeof archGate === 'object' && archGate ? archGate : null;
    // успех — только полный ответ: 200, список data и БЕЗ поля error (200 + error = частичный ответ архива, повторяем)
    if (archOk(u, r.ok, j)) { if (gate) gate.ok(); j.data.trunc = j.data.length >= limit; return j.data; }
    why = (kind + ': ' + (j.error || 'HTTP ' + r.status)).slice(0, 80);
    // Архив говорит, когда сбросится его лимит (x-ratelimit-reset-at) — ждём ровно до этого момента (не дольше минуты),
    // иначе — нарастающие паузы.
    const at = r.headers && +r.headers.get('x-ratelimit-reset-at');
    const wait = at > Date.now() ? Math.min(at - Date.now() + 500, 60000) : ARCH_WAIT[Math.min(i, ARCH_WAIT.length - 1)];
    // Со скриптом массовой проверки: настоящий 429 — общая пауза для всех окон. «Timeout. Maybe slow down» часто
    // значит просто тяжёлый запрос (огромная история) — его повторяем сами, облегчённым; общая пауза — только если
    // таймауты пошли в разных окнах подряд (gate.soft решает).
    if (gate && r.status === 429) gate.block(at > Date.now() ? at : 0);
    else {
      if (gate) gate.soft();
      if (i < ARCH_WAIT.length) await new Promise((ok) => setTimeout(ok, wait));
    }
  }
  throw new Error(why);
}

// ---------- перерывы у очень активных: зонд по отрезкам ----------
// У активных 100 последних постов/комментов — это дни или недели, долгое молчание раньше не видно.
// Спрашиваем архив «есть ли хоть одна запись» в каждом 3-месячном отрезке за последние полтора года (по 1 записи —
// самый лёгкий запрос). Пустой отрезок → уточняем границы перерыва. ДАТ не возвращаем и не храним — только длину.
// Если запрос не ответил — отрезок НЕ считаем пустым (иначе ложные «молчания»): весь зонд → null.
async function archOne(kind, user, range, sort) {
  const u = `${ARCH}/${kind}/search?author=${encodeURIComponent(user)}&limit=1&sort=${sort}&${range}&fields=created_utc`;
  for (let i = 0; i <= ARCH_WAIT.length; i++) {
    let r, j;
    try { r = await archFetch(u); j = await r.json().catch(() => ({})); } catch { r = { ok: false, status: 0 }; j = {}; }
    if (archOk(u, r.ok, j)) return j.data.length ? j.data[0].created_utc : 0;
    const at = r.headers && +r.headers.get('x-ratelimit-reset-at');
    const gate = typeof archGate === 'object' && archGate ? archGate : null;
    if (gate && r.status === 429) gate.block(at > Date.now() ? at : 0);
    if (i < ARCH_WAIT.length) await new Promise((ok) => setTimeout(ok, ARCH_WAIT[i]));
  }
  throw new Error('probe failed');
}
const PROBE_DAY = 86400, PROBE_WIN = 90 * PROBE_DAY, PROBE_N = 6;
async function gapProbe(user, coverFrom, created) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(user)) throw new Error('bad user');
  // «сейчас» — с точностью до часа: адреса запросов не меняются каждую секунду (кэш ответов на сервере попадает
  // при повторе); перерывы считаются в днях — час на них не влияет
  const now = Math.floor(Date.now() / 1000 / 3600) * 3600;
  let best = 0, span = 0, gapFrom = 0, gapTo = 0;
  for (let k = 0; k < PROBE_N; k++) {
    const end = now - k * PROBE_WIN, start = end - PROBE_WIN;
    if (created && end <= created) break; // раньше регистрации смотреть нечего
    span = Math.round((now - Math.max(start, created || 0)) / PROBE_DAY);
    if (coverFrom && start >= coverFrom) continue; // этот отрезок и так виден целиком
    if (gapTo && start >= gapFrom && end <= gapTo) continue; // уже внутри найденного перерыва
    const range = `after=${start}&before=${end}`;
    const p = await archOne('posts', user, range, 'desc');
    const c = p ? p : await archOne('comments', user, range, 'desc');
    if (p || c) continue;
    // пустой отрезок: последний пост/коммент ДО него и первый ПОСЛЕ — это и есть перерыв
    const bp = await archOne('posts', user, `before=${start}`, 'desc');
    const bc = await archOne('comments', user, `before=${start}`, 'desc');
    const ap = await archOne('posts', user, `after=${end}`, 'asc');
    const ac = await archOne('comments', user, `after=${end}`, 'asc');
    const prev = Math.max(bp || 0, bc || 0) || created || 0;
    const next = [ap, ac].filter((x) => x > 0).sort((a, b) => a - b)[0] || 0;
    gapFrom = prev; gapTo = next || now;
    if (prev && next && next >= now - 365 * PROBE_DAY) best = Math.max(best, (next - prev) / PROBE_DAY);
  }
  return { sleep: Math.round(best), span };
}

async function archStats(user, split, created) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(user) || !split) throw new Error('bad user');
  // Между запросами — пауза: архив бесплатный и просит не частить.
  // Фиксированных пауз нет: если архив перегружен, archGet сам ждёт до его x-ratelimit-reset-at.
  const pause = () => Promise.resolve();
  const oldPosts = await archGet('posts', user, 'before=' + split, POST_FIELDS); await pause();
  const oldComments = await archGet('comments', user, 'before=' + split, COMMENT_FIELDS); await pause();
  const newPosts = await archGet('posts', user, 'after=' + split, POST_FIELDS); await pause();
  const newComments = await archGet('comments', user, 'after=' + split, COMMENT_FIELDS);
  // Нет хоть одной части — не судим по половине данных (например, без старых комментов на украинском
  // человек выглядел бы «англоязычным»). Проверим в другой раз.
  // (archGet бросает ошибку, если часть не пришла — до сюда доходим только с полными данными)
  // NSFW-саб — где помечена БОЛЬШАЯ часть его постов (2+). Один NSFW-пост в обычном сабе (флер «Ебанариум»
  // в tj) не делает весь саб NSFW — иначе все комменты там считались бы NSFW.
  const nsfwSubs = new Set();
  const subPosts = {};
  for (const p of [...(oldPosts || []), ...(newPosts || [])]) {
    const s = (p.subreddit || '').toLowerCase();
    const x = (subPosts[s] ??= { n: 0, nsfw: 0 });
    x.n++;
    if (p.over_18) x.nsfw++;
  }
  for (const s in subPosts) if (subPosts[s].nsfw >= 2 && subPosts[s].nsfw / subPosts[s].n >= 0.5) nsfwSubs.add(s);
  // Самое долгое молчание по архиву (там и удалённые посты). Через границу split и до регистрации считаем,
  // только если списки неполные (меньше 100) — значит, мы видим всё, что было.
  // ВАЖНО: каждый список — «последние 100», и обрезан он у каждого по-своему (100 комментов могут покрыть 2 месяца,
  // а 100 постов — 5 лет). Склеивать их целиком нельзя: между старым постом и самым ранним из 100 комментов
  // появляется ложная «дыра» (так один аккаунт, писавший каждый месяц, «молчала» 726 дней). Поэтому берём только
  // отрезок, видимый во ВСЕХ обрезанных списках: всё старше самой поздней «нижней границы» отбрасываем.
  const times = (a) => (a || []).map((x) => x.created_utc).filter((t) => t > 0);
  const visible = (...lists) => {
    let cutoff = 0;
    for (const l of lists) if (l && l.trunc && l.length) cutoff = Math.max(cutoff, Math.min(...times(l)));
    return lists.flatMap(times).filter((t) => t >= cutoff);
  };
  const fullNew = !newPosts.trunc && !newComments.trunc;
  const fullOld = !oldPosts.trunc && !oldComments.trunc;
  const now = Date.now() / 1000;
  let sleep = Math.max(
    konsSleep(visible(newPosts, newComments), 0, false, now),
    konsSleep(visible(oldPosts, oldComments), 0, false, now),
    // через границу «3 месяца назад» — только если свежие списки полные (видим всё после неё)
    fullNew ? konsSleep(visible(newPosts, newComments, oldPosts, oldComments), created, fullOld, now) : 0);
  // За какой период перерывы реально проверены (непрерывно до сегодня): у очень активных это лишь пара недель.
  const covered = fullNew ? visible(newPosts, newComments, oldPosts, oldComments) : visible(newPosts, newComments);
  const coverFrom = fullNew && fullOld && created > 0 ? created : covered.length ? Math.min(...covered) : now;
  let sleepSpan = Math.round((now - coverFrom) / 86400);
  let probeSpan = 0;
  // Видно меньше года (очень активный) — досматриваем полтора года по 3-месячным отрезкам (только длину перерыва).
  if (sleepSpan < 365) {
    const g = await gapProbe(user, coverFrom, created).catch(() => null);
    if (g) { sleep = Math.max(sleep, g.sleep); probeSpan = g.span; } // зонд видит только перерывы 90+ дн.
  }
  // Сабы и оценки — для правил автопроверки, когда reddit упёрся в лимит и всё берём из архива.
  // (Оценки в архиве — снимок на момент записи, поэтому вердикт по ним грубее.)
  const subs = {}, votes = {}, subsP = {}, votesP = {}; // subsP/votesP — только посты (пост весит больше, см. POST_W)
  const nowS = Date.now() / 1000;
  const postSet = new Set([...oldPosts, ...newPosts]);
  for (const x of [...oldPosts, ...oldComments, ...newPosts, ...newComments]) {
    const s = (x.subreddit || '').toLowerCase();
    if (!s) continue;
    const isPost = postSet.has(x);
    subs[s] = (subs[s] || 0) + 1;
    if (isPost) subsP[s] = (subsP[s] || 0) + 1;
    if (typeof x.score !== 'number' || nowS - (x.created_utc || 0) < 2 * 3600) continue;
    const v = (votes[s] ??= { up: 0, down: 0 });
    const vp = isPost ? (votesP[s] ??= { up: 0, down: 0 }) : null;
    if (x.score >= 2) { v.up++; if (vp) vp.up++; }
    else if (x.score <= 0) { v.down++; if (vp) vp.down++; }
  }
  // Ферма кармы: пачки постов, картинки с короткими заголовками (по архиву видны и удалённые).
  const farm = farmStats([...oldPosts, ...newPosts].map((p) => ({
    t: p.created_utc, s: (p.subreddit || '').toLowerCase(), img: postIsImg(p.url, p.selftext), words: titleWords(p.title),
  })));
  return { old: langStats(oldPosts, oldComments, nsfwSubs), recent: langStats(newPosts, newComments, nsfwSubs), sleep, sleepSpan, probeSpan, subs, votes, subsP, votesP, farm };
}

// Всё из архива (reddit упёрся в лимит): история + профиль. Точной даты регистрации в архиве нет —
// берём дату первой активности (аккаунт не моложе неё) и карму.
async function archFull(user, split) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(user) || !split) throw new Error('bad user');
  let first = 0, karma = null, lk = null, ck = null; // null — архив карму не знает (у многих ников её там нет)
  // Профиль (карма, возраст). «Такого профиля в архиве нет» (пустой список) — нормально, считаем без него.
  // Но СБОЙ запроса (ошибка, тайм-аут, 429 после повторов) — не «нет профиля»: без кармы не видна ферма, и
  // «консерва» превращалась в «чисто» (пример — тест сервера 12.11). Такой сбой — ошибка всей проверки.
  let j = null, why = '';
  for (let i = 0; i <= ARCH_WAIT.length && !j; i++) {
    let r = null;
    const pu = `${ARCH}/users/search?author=${encodeURIComponent(user)}&limit=5`;
    try { r = await archFetch(pu); } catch (e) { why = 'profile: ' + (e.name === 'TimeoutError' ? 'timeout' : 'network'); }
    if (r) {
      const x = await r.json().catch(() => null);
      if (archOk(pu, r.ok, x)) j = x;
      else {
        why = 'profile: ' + ((x && x.error) || 'HTTP ' + r.status);
        const at = r.headers && +r.headers.get('x-ratelimit-reset-at');
        const gate = typeof archGate === 'object' && archGate ? archGate : null;
        if (gate && r.status === 429) { gate.block(at > Date.now() ? at : 0); continue; }
      }
    }
    if (!j && i < ARCH_WAIT.length) await new Promise((ok) => setTimeout(ok, ARCH_WAIT[i]));
  }
  if (!j) throw new Error(String(why || 'profile: no answer').slice(0, 80));
  {
    const u = (j.data || []).find((x) => String(x.author || '').toLowerCase() === user.toLowerCase());
    const m = u && u._meta;
    if (m) {
      const t = [m.earliest_comment_at, m.earliest_post_at].filter((x) => x > 0);
      first = t.length ? Math.min(...t) : 0;
      karma = typeof m.total_karma === 'number' ? m.total_karma : null;
      // У части ников архив отдаёт нули вместо кармы — это «неизвестно», а не «0 кармы».
      if (m.post_karma || m.comment_karma) { lk = m.post_karma || 0; ck = m.comment_karma || 0; }
    }
  }
  // (пауза не нужна — см. archGet)
  const st = await archStats(user, split, 0);
  // Профиля в архиве нет — возраст по самому старому посту/комменту, что мы видим (аккаунт не моложе).
  if (!first) {
    const t = [st.old.oldest, st.recent.oldest].filter((x) => x > 0);
    first = t.length ? Math.min(...t) : 0;
  }
  return { ...st, first, karma, lk, ck };
}

// textLang — из score.js. newest/oldest — даты (сек) самого свежего и самого раннего поста/коммента.
function langStats(posts, comments, nsfwSubs) {
  const st = { n: 0, cyr: 0, lat: 0, nsfw: 0, cyrPosts: 0, newest: 0, oldest: 0 };
  const add = (s, nsfw, text, t, isPost) => {
    st.n++;
    if (nsfw || nsfwSubs.has(s)) st.nsfw++;
    const l = textLang(text);
    if (l) st[l]++;
    if (l === 'cyr' && isPost) st.cyrPosts++;
    if (t) { st.newest = Math.max(st.newest, t); st.oldest = st.oldest ? Math.min(st.oldest, t) : t; }
  };
  for (const p of posts || []) add((p.subreddit || '').toLowerCase(), !!p.over_18, (p.title || '') + ' ' + (p.selftext || ''), p.created_utc, true);
  for (const c of comments || []) add((c.subreddit || '').toLowerCase(), false, c.body || '', c.created_utc, false);
  return st;
}

// ---------- самообновление распакованной версии ----------
// Opera/Chrome не перечитывают папку распакованного расширения сами. Content-скрипт при открытии reddit шлёт
// { type: 'ver' }; фон читает manifest.json прямо из папки и, если версия там новее загруженной, перезагружается.
// У установленного из магазина/xpi файлы не меняются — проверка просто ничего не делает.
let verChecked = 0;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'ver' || Date.now() - verChecked < 60000) return;
  verChecked = Date.now();
  fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })
    .then((r) => r.json())
    .then((m) => { if (m && m.version && m.version !== chrome.runtime.getManifest().version) chrome.runtime.reload(); })
    .catch(() => { /* не смогли прочитать — не трогаем */ });
});

// Синхронизация своих данных по ключу (п.15): sync.js. На сервере (check.gen.js) HryuSync нет — пропускаем.
// Синхронизации нужен только токен установки (не голоса): работает и с выключенным общим слоем. Токен не теряем:
// новый токен = новое устройство, его пришлось бы подключать заново.
async function syncApi({ path, body }) { return request(DEFAULT_SERVER, path, body, await pubToken(false, true)); }
if (typeof HryuSync !== 'undefined' && chrome.alarms) HryuSync.start({ syncApi, api });


export { archFull, archVerdict, isServiceBot, archOk, trustOf };
