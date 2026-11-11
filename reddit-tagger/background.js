// Chrome: фон — service worker, i18n.js подключаем сами.
// Firefox: фон — обычные скрипты, i18n.js уже подключён манифестом (importScripts там нет).
if (typeof T === 'undefined' && typeof importScripts === 'function') importScripts('i18n.js', 'score.js');

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

async function pubToken(forceNew) {
  const { rt_pub: p = {}, rt_settings: s = {} } = await chrome.storage.local.get(['rt_pub', 'rt_settings']);
  if (s.pubOn === false) throw new Error(T('Общие жалобы выключены'));
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

const POST_FIELDS = 'subreddit,over_18,title,selftext,created_utc,score,url';
const COMMENT_FIELDS = 'subreddit,body,created_utc,score';

// Архив под нагрузкой отвечает «Timeout. Maybe slow down a bit» — повторяем терпеливее: паузы растут,
// со второй попытки просим меньше записей (серверу легче). trunc — список упёрся в лимит (виден не весь).
const ARCH_WAIT = [3000, 8000, 15000];
// Общий «шлагбаум» к архиву. В браузере его нет (no-op). Скрипт массовой проверки (tools/check-tj.mjs) подставляет
// archGate: общий на все окна лимит одновременных запросов и общая пауза после «slow down».
async function archFetch(url) {
  const gate = typeof archGate === 'object' && archGate ? archGate : null;
  if (gate) await gate.acquire();
  try { return await fetch(url, { signal: AbortSignal.timeout(20000) }); } finally { if (gate) gate.release(); }
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
    if (r.ok && Array.isArray(j.data)) { if (gate) gate.ok(); j.data.trunc = j.data.length >= limit; return j.data; }
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
    if (r.ok && Array.isArray(j.data)) return j.data.length ? j.data[0].created_utc : 0;
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
  const now = Math.floor(Date.now() / 1000);
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
  try {
    const r = await archFetch(`${ARCH}/users/search?author=${encodeURIComponent(user)}&limit=5`);
    const j = await r.json().catch(() => ({}));
    const u = (j.data || []).find((x) => String(x.author || '').toLowerCase() === user.toLowerCase());
    const m = u && u._meta;
    if (m) {
      const t = [m.earliest_comment_at, m.earliest_post_at].filter((x) => x > 0);
      first = t.length ? Math.min(...t) : 0;
      karma = typeof m.total_karma === 'number' ? m.total_karma : null;
      // У части ников архив отдаёт нули вместо кармы — это «неизвестно», а не «0 кармы».
      if (m.post_karma || m.comment_karma) { lk = m.post_karma || 0; ck = m.comment_karma || 0; }
    }
  } catch { /* без профиля — возраст неизвестен */ }
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
