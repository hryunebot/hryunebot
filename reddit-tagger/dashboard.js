'use strict';
// Все надписи идут через T() из i18n.js: ключ — русский текст, по умолчанию показывается украинский перевод.

const K_USERS = 'rt_users';
const K_SET = 'rt_settings';
const DEFAULT_SET = {
  presets: DEFAULT_PRESETS.slice(), // список — в score.js
  presetsV: PRESETS_VERSION,
  showAdd: true,
  size: 'm',
  trustStyle: 'bar',
  compact: 'auto',
  autoOn: true,
  autoSubs: ['tjournal_refugees'],
  archFallback: true,
  homeDownOn: true,
  hiddenOn: true,
  clownOn: true,
  hiddenPoints: 1,
  autoRules: DEFAULT_RULES.map((r) => ({ ...r })),
  accOn: true,
  newDays: 30,
  lowKarma: 100,
  accPoints: 2,
  konsOn: true,
  konsPoints: 4,
  konsWeakPoints: 1,
  pubOn: true,
  helpQueue: null, // помогать пополнять базу: null — ещё не спрашивали (вопрос на reddit), true/false — ответ
  welcomed: false, // первый экран «как это работает» уже закрыли (1.3.96)
  halfAt: 7, // сколько нахрюков (разных людей) дают 50% на шкале
  lang: 'uk', // основной язык украинский, можно переключить на русский
};
const PALETTE = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f', '#8b8d98'];

let users = {};
let settings = { ...DEFAULT_SET };
let tab = 'users';
let q = '';
let tagFilter = '';
let subFilter = '';
let sort = { col: 'updated', dir: -1 };

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const textColor = (hex) => {
  const h = (hex || '#888888').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111' : '#fff';
};
const badge = (t, c) => { c = safeColor(c); return `<span class="badge" style="background:${c};color:${textColor(c)}">${esc(t)}</span>`; };
// Ссылка на коммент — только https://…reddit.com (см. score.js)
const linkCell = (link, empty) => (safeRedditLink(link) ? `<a href="${esc(safeRedditLink(link))}" target="_blank" rel="noopener noreferrer">${T('открыть')}</a>` : empty);
const total = (u) => Object.values(u.subs || {}).reduce((a, b) => a + b, 0);
const compN = (u) => (u.complaints || []).length;
// Нахрюкометр (формула — в score.js): people — сколько разных людей нахрюкали, complaints — всего нахрюков.
const meterColor = (p) => (p < 30 ? '#46a758' : p < 60 ? '#ffc53d' : p < 85 ? '#f76b15' : '#e5484d');
const meter = (people, complaints) => {
  const p = botPercent(botPoints(people, complaints), settings.halfAt);
  return p ? badge(`🐽 ${p}%`, meterColor(p)) : '<span class="mut">—</span>';
};
const ago = (ts) => {
  if (!ts) return '—';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return T('только что');
  if (m < 60) return T('{n} мин назад', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return T('{n} ч назад', { n: h });
  const d = Math.round(h / 24);
  if (d < 31) return T('{n} дн назад', { n: d });
  return new Date(ts).toLocaleDateString(LOCALE());
};
// Для жалоб — только день, без времени.
const dayStr = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts), today = new Date();
  const diff = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  return diff === 0 ? T('сегодня') : diff === 1 ? T('вчера') : d.toLocaleDateString(LOCALE(), { day: '2-digit', month: '2-digit', year: '2-digit' });
};

let adminKey = '';
let adminData = null; // { complaints, perWho, members, err }
let adminWho = '';

async function load() {
  const d = await chrome.storage.local.get([K_USERS, K_SET, 'rt_group', 'rt_admin']);
  users = d[K_USERS] || {};
  settings = { ...DEFAULT_SET, ...(d[K_SET] || {}) };
  setLang(settings.lang);
  settings.autoRules = migrateRules(settings.autoRules); migratePresets(settings);
  group = d.rt_group || {};
  adminKey = d.rt_admin?.key || '';
  translateStatic();
  render();
  checkRedditAccess();
  renderConsent();
}

// ---------- первый запуск и согласие (1.3.96) ----------
// Коротко: где появляются метки и что делать нажатием; сразу — попробовать на Reddit. Вопрос про очередь ников —
// понятно, что уходит и зачем; текущий выбор виден и меняется здесь же. Доверие и синхронизация — позже, в настройках.
const CONTACT = 'https://github.com/hryunebot/hryunebot/issues'; // связаться с владельцем (без личных контактов)
const TRY_URL = 'https://www.reddit.com/r/tjournal_refugees/';
function consentText() {
  return T('Хрюнебот сам проверяет историю ников, которых ещё нет в общей базе. Если вы согласны, после такой проверки он отправит владельцу ник и короткий итог (коды меток и цифры). Владелец перепроверит ник и добавит в общую базу — другие пользователи увидят результат сразу. Не отправляются: ваш ник, куки, токены, тексты комментариев.');
}
function consentChoice() {
  const c = queueConsent(settings.helpQueue);
  return c === 'ask' ? T('Вы ещё не ответили — пока ничего не отправляется.') : c === 'yes' ? T('Сейчас: да, отправлять.') : T('Сейчас: нет, не отправлять.');
}
function renderConsent() {
  const box = $('#consentBox');
  if (!box) return;
  const welcome = settings.welcomed !== true && !Object.keys(users).length;
  const ask = queueConsent(settings.helpQueue) === 'ask';
  if (!welcome && !ask) { box.style.display = 'none'; box.textContent = ''; return; }
  box.style.display = '';
  const ex = `<span class="badge" style="background:#ffc53d;color:#111">🐽 34%</span><span class="badge out">👹<span class="q">?</span>×12</span><span class="badge out">+2</span>`;
  box.innerHTML = (welcome ? `<h2 style="margin:0 0 8px">${T('Хрюнебот готов 🐽')}</h2>
      <ol class="steps-intro">
        <li>${T('На Reddit рядом с никами появляются метки, например:')} <span class="ex">${ex}</span></li>
        <li>${T('🐽 — нахрюкометр: оценка по правилам Хрюнебота, а не факт. «?» — метка с сомнением. «+2» — ещё метки, раскрываются нажатием.')}</li>
        <li>${T('Нажмите на метки или 🏷 рядом с ником — откроется карточка: почему такие метки, ваши метки, заметка, жалоба.')}</li>
      </ol>
      <div class="row" style="gap:10px;margin:10px 0 4px"><a class="btn pri" href="${TRY_URL}" target="_blank" rel="noopener">${T('Попробовать на Reddit →')}</a>
        <button class="btn" id="welcomeOk">${T('Понятно, скрыть')}</button></div>
      <div class="mut">${T('Доверенный пользователь и синхронизация между устройствами — в «Настройках», когда понадобятся.')}</div>` : '')
    + `<div class="consent ${welcome ? 'in' : ''}"><b>${T('Помогать пополнять общую базу?')}</b>
      <div class="mut" style="margin:6px 0 8px">${consentText()}</div>
      <div class="row" style="gap:10px;align-items:center">
        <button class="btn ${settings.helpQueue === true ? 'pri' : ''}" id="consentYes" aria-pressed="${settings.helpQueue === true}">${T('Да, помогать')}</button>
        <button class="btn ${settings.helpQueue === false ? 'pri' : ''}" id="consentNo" aria-pressed="${settings.helpQueue === false}">${T('Нет')}</button>
        <span class="mut" id="consentNow">${consentChoice()}</span></div>
      <div class="mut" style="margin-top:6px">${T('Поменять можно в любой момент: Настройки → Общие оценки и участие.')}</div></div>`;
  const answer = (v) => { settings.helpQueue = v; saveSettings(); };
  $('#consentYes').onclick = () => answer(true);
  $('#consentNo').onclick = () => answer(false);
  const ok = $('#welcomeOk');
  if (ok) ok.onclick = () => { settings.welcomed = true; if (settings.helpQueue === null) settings.helpQueue = false; saveSettings(); };
}

// В Firefox пользователь может отключить расширению доступ к reddit — тогда метки не появятся.
// Показываем предупреждение с кнопкой «дать доступ» (запрос разрешения требует клика).
const REDDIT_ORIGINS = { origins: ['*://*.reddit.com/*'] };
async function checkRedditAccess() {
  const box = $('#permBanner');
  if (!box || !chrome.permissions?.contains) return;
  let ok = true;
  try { ok = await chrome.permissions.contains(REDDIT_ORIGINS); } catch { ok = true; }
  if (ok) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.innerHTML = `<b>${T('Нет доступа к reddit')}</b> — ${T('без него метки у ников не появятся.')}
    <button class="btn pri" id="permGrant" style="margin-left:8px">${T('Дать доступ к reddit')}</button>`;
  $('#permGrant').onclick = async () => {
    try { await chrome.permissions.request(REDDIT_ORIGINS); } catch { /* отказ */ }
    checkRedditAccess();
  };
}
const saveUsers = () => chrome.storage.local.set({ [K_USERS]: users });
// Своя запись настроек не перерисовывает страницу целиком (иначе пропадает «✓ Сохранено» и открытые разделы);
// перерисовка — только если сменили язык.
let selfSetUntil = 0;
const saveSettings = () => { selfSetUntil = Date.now() + 1500; return chrome.storage.local.set({ [K_SET]: settings }); };

// Надписи в самом HTML (вкладки, диалог) помечены data-t / data-tp.
function translateStatic() {
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-t]').forEach((el) => (el.textContent = T(el.dataset.t)));
  document.querySelectorAll('[data-tp]').forEach((el) => (el.placeholder = T(el.dataset.tp)));
  document.querySelectorAll('#langSw button').forEach((b) => b.classList.toggle('on', b.dataset.lang === LANG));
}

document.querySelectorAll('#langSw button').forEach((b) => (b.onclick = () => {
  settings.lang = b.dataset.lang;
  saveSettings();
}));

// Кэш автопроверки пишется часто — из-за него не перерисовываем (иначе слетают несохранённые настройки).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  if (keys.length === 1 && keys[0] === 'rt_hist') return;
  // служебные записи синхронизации — обновляем только её блок, не всю страницу (иначе слетают несохранённые поля)
  if (keys.every((k) => k === 'rt_sync' || k === 'rt_sync_lost' || k === 'rt_hist')) { renderSyncBox(); return; }
  if (keys.length === 1 && keys[0] === K_SET && Date.now() < selfSetUntil && (changes[K_SET].newValue || {}).lang === LANG) {
    renderConsent();
    const c2 = document.getElementById('consentNow2');
    if (c2) c2.textContent = consentChoice();
    const hq = document.getElementById('helpQueue');
    if (hq) hq.checked = settings.helpQueue === true;
    return;
  }
  load();
});

// ---------- агрегаты ----------

function aggSubs() {
  const subs = {};
  for (const u of Object.values(users)) {
    for (const [s, n] of Object.entries(u.subs || {})) {
      const x = (subs[s] ??= { name: s, total: 0, users: [], tags: {}, complaints: 0 });
      x.total += n;
      x.users.push({ u, n });
      for (const t of u.tags || []) x.tags[t] = (x.tags[t] || 0) + 1;
    }
    for (const c of u.complaints || []) {
      if (!c.sub) continue;
      (subs[c.sub] ??= { name: c.sub, total: 0, users: [], tags: {}, complaints: 0 }).complaints++;
    }
  }
  return Object.values(subs).sort((a, b) => b.users.length - a.users.length || b.total - a.total);
}

function aggTags() {
  const tags = {};
  for (const u of Object.values(users)) {
    for (const t of u.tags || []) {
      const x = (tags[t] ??= { name: t, color: u.color, users: [], subs: {} });
      x.users.push(u);
      for (const [s, n] of Object.entries(u.subs || {})) x.subs[s] = (x.subs[s] || 0) + n;
    }
  }
  return Object.values(tags).sort((a, b) => b.users.length - a.users.length);
}

// ---------- рендер ----------

function render() {
  const list = Object.values(users);
  const subs = aggSubs();
  $('#kpis').innerHTML = `
    <span><b>${list.length}</b>${T('юзеров')}</span>
    <span><b>${aggTags().length}</b>${T('меток')}</span>
    <span><b>${subs.length}</b>${T('сабреддитов')}</span>
    <span><b>${list.reduce((s, u) => s + total(u), 0)}</b>${T('встреч')}</span>
    <span><b>${list.reduce((s, u) => s + compN(u), 0)}</b>${T('жалоб')}</span>`;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ({ users: renderUsers, subs: renderSubs, tags: renderTags, complaints: renderComplaints, group: renderGroup, settings: renderSettings })[tab]();
}

// ---------- группа (общий сервер) ----------

const K_GROUP = 'rt_group';
const DEFAULT_SERVER = 'https://reddit-tagger.reddit-tagger-server.workers.dev';
let group = {};
let groupStats = null;
let groupErr = '';

// pub: true — общий слой жалоб (все пользователи); admin: true — админка владельца
function api(path, body, server, pub, admin) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'api', path, body, server, pub: !!pub, admin: !!admin }, (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!r?.ok) reject(new Error(r?.error || T('Нет ответа')));
      else resolve(r.data);
    });
  });
}
const saveGroup = () => chrome.storage.local.set({ [K_GROUP]: group });

async function refreshGroupStats() {
  groupErr = '';
  try { groupStats = await api('/stats'); } catch (e) { groupErr = e.message; }
  if (tab === 'group') renderGroup();
}

function renderGroup() {
  const server = group.server || DEFAULT_SERVER;
  if (!group.token) {
    $('#main').innerHTML = `
      <div class="card set">
        <div>${T('Группа — это общая база меток для вас и друзей. У ника показывается метка группы, если её поставили несколько участников, а статистика по сабреддитам считается по всем.')}</div>
        <label>${T('Адрес сервера')}
          <input id="gServer" value="${esc(server)}" placeholder="https://reddit-tagger.ваш-аккаунт.workers.dev">
        </label>
        <h2 style="margin:0">${T('Создать группу')}</h2>
        <div class="row">
          <input id="gName" placeholder="${T('Название')}" class="grow">
          <label class="row" style="font-weight:400">${T('порог')} <input id="gMin" type="number" min="1" max="50" value="2" style="width:70px"></label>
          <button class="btn pri" id="gCreate">${T('Создать')}</button>
        </div>
        <div class="mut">${T('Порог — сколько участников должны поставить одинаковую метку, чтобы её увидели все. Для 2–3 друзей ставьте 1–2.')}</div>
        <h2 style="margin:0">${T('…или войти по коду')}</h2>
        <div class="row">
          <input id="gCode" placeholder="${T('Код приглашения')}" class="grow">
          <button class="btn" id="gJoin">${T('Войти')}</button>
        </div>
        <div class="err" id="gErr">${esc(groupErr)}</div>
      </div>`;
    const go = async (path, body) => {
      const srv = $('#gServer').value.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(srv)) { $('#gErr').textContent = T('Укажите адрес сервера'); return; }
      try {
        const r = await api(path, body, srv);
        group = { server: srv, token: r.token, ...r.group, share: true };
        await saveGroup();
        groupErr = '';
        refreshGroupStats();
      } catch (e) { $('#gErr').textContent = e.message; }
    };
    $('#gCreate').onclick = () => go('/groups', { name: $('#gName').value, minVotes: +$('#gMin').value });
    $('#gJoin').onclick = () => go('/join', { code: $('#gCode').value });
    return;
  }

  const s = groupStats;
  const colorOf = (t) => safeColor((Object.values(users).find((u) => (u.tags || []).includes(t)) || {}).color || '#8b8d98');
  $('#main').innerHTML = `
    <div class="card set" style="max-width:none">
      <div class="row" style="justify-content:space-between">
        <div><b style="font-size:16px">${esc(group.name)}</b>
          <div class="mut">${s ? T('{m} участн. · {v} ставили метки · {g} голосов · {c} жалоб · ', { m: s.meta.members, v: s.meta.voters, g: s.meta.votes, c: s.meta.complaints || 0 }) : ''}${T('порог')} ${group.minVotes}</div></div>
        <div class="row">${T('Код для друзей:')} <span class="code">${esc(group.code)}</span><button class="btn" id="gCopy">${T('Копировать')}</button></div>
      </div>
      <div class="row">
        <label class="row" style="font-weight:400"><input type="checkbox" id="gShare" ${group.share !== false ? 'checked' : ''}> ${T('Отправлять мои метки в группу')}</label>
        <button class="btn" id="gPush">${T('Отправить все мои метки')}</button>
        <button class="btn" id="gRefresh">${T('Обновить')}</button>
        <button class="btn dng" id="gLeave">${T('Выйти из группы')}</button>
        <span class="mut" id="gMsg"></span>
      </div>
      ${groupErr ? `<div class="err">${esc(groupErr)}</div>` : ''}
    </div>
    ${!s ? `<div class="empty">${T('Загрузка…')}</div>` : `
    <h2>${T('Сабреддиты группы')}</h2>
    ${s.subs.length ? `<div class="card scroll"><table>
      <thead><tr><th>${T('Сабреддит')}</th><th class="num">${T('Помеченных')}</th><th class="num">${T('Встреч')}</th><th class="num">${T('Жалоб')}</th><th>${T('Состав по меткам')}</th><th>${T('Кто там')}</th></tr></thead>
      <tbody>${s.subs.map((x) => {
        const tl = Object.entries(x.tags).sort((a, b) => b[1] - a[1]);
        const sum = tl.reduce((a, [, n]) => a + n, 0) || 1;
        return `<tr>
          <td><a href="https://www.reddit.com/r/${esc(x.name)}/" target="_blank">r/${esc(x.name)}</a></td>
          <td class="num">${x.users}</td><td class="num">${x.total}</td><td class="num">${x.complaints || 0}</td>
          <td>${tl.map(([t, n]) => `${badge(t, colorOf(t))}<span class="mut">×${n}</span> `).join('')}
            <div class="bars">${tl.map(([t, n]) => `<span style="width:${(n / sum) * 100}%;background:${colorOf(t)}"></span>`).join('')}</div></td>
          <td>${x.top.map((u) => `<span class="chip">u/${esc(u.name)} · ${u.n}</span>`).join('')}</td>
        </tr>`;
      }).join('')}</tbody></table></div>` : `<div class="card empty">${T('Встреч пока нет — копится, когда участники листают reddit.')}</div>`}
    <h2>${T('Юзеры с метками и жалобами группы')}</h2>
    ${s.users.length ? `<div class="card scroll"><table>
      <thead><tr><th>${T('Юзер')}</th><th>${T('Нахрюкометр')}</th><th>${T('Жалобы')}</th><th>${T('Метки (голосов)')}</th><th>${T('Где встречается')}</th><th class="num">${T('Встреч')}</th></tr></thead>
      <tbody>${s.users.map((u) => `<tr>
        <td><a href="https://www.reddit.com/user/${esc(u.name)}/" target="_blank">u/${esc(u.name)}</a></td>
        <td>${meter(u.complainers, u.complaints)}</td>
        <td>${u.complaints ? `${u.complaints} <span class="mut">${T('от {n}', { n: N(u.complainers, 'человека|человек|человек') })}</span>` : '<span class="mut">—</span>'}</td>
        <td>${Object.entries(u.tags).sort((a, b) => b[1] - a[1]).map(([t, c]) => badge(`${t} ×${c}`, colorOf(t))).join('') || '<span class="mut">—</span>'}</td>
        <td>${Object.entries(u.subs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([sub, n]) => `<span class="chip">r/${esc(sub)} · ${n}</span>`).join('') || '<span class="mut">—</span>'}</td>
        <td class="num">${u.total}</td>
      </tr>`).join('')}</tbody></table></div>` : `<div class="card empty">${T('Пока нет ни жалоб, ни меток, набравших порог ({n}).', { n: group.minVotes })}</div>`}
    ${s.recent?.length ? `<h2>${T('Последние жалобы группы')}</h2>
    <div class="card scroll"><table>
      <thead><tr><th>${T('Когда')}</th><th>${T('Юзер')}</th><th>${T('Саб')}</th><th>${T('Причина')}</th><th>${T('Коммент')}</th></tr></thead>
      <tbody>${s.recent.map((c) => `<tr>
        <td class="mut">${dayStr(c.created)}</td>
        <td><a href="https://www.reddit.com/user/${esc(c.name)}/" target="_blank">u/${esc(c.name)}</a></td>
        <td>${c.sub ? `r/${esc(c.sub)}` : '—'}</td>
        <td>${c.reason ? badge(c.reason, colorOf(c.reason)) : '<span class="mut">—</span>'}</td>
        <td>${linkCell(c.link, '—')}</td>
      </tr>`).join('')}</tbody></table></div>` : ''}`}`;

  $('#gCopy').onclick = () => navigator.clipboard.writeText(group.code).then(() => ($('#gMsg').textContent = T('Код скопирован')));
  $('#gShare').onchange = (e) => { group.share = e.target.checked; saveGroup(); };
  $('#gRefresh').onclick = () => refreshGroupStats();
  $('#gLeave').onclick = () => {
    if (confirm(T('Выйти из группы? Ваши локальные метки останутся.'))) { group = { server: group.server }; groupStats = null; saveGroup(); }
  };
  $('#gPush').onclick = async () => {
    const items = Object.values(users).filter((u) => u.tags?.length).map((u) => ({ user: u.name, tags: u.tags, sub: u.taggedIn }));
    try {
      for (let i = 0; i < items.length; i += 100) await api('/vote', { items: items.slice(i, i + 100) });
      $('#gMsg').textContent = T('Отправлено: {n}', { n: items.length });
      refreshGroupStats();
    } catch (e) { $('#gMsg').textContent = e.message; }
  };
  if (!s && !groupErr) refreshGroupStats();
}

function renderUsers() {
  const allTags = aggTags().map((t) => t.name);
  const allSubs = aggSubs().map((s) => s.name);
  let list = Object.entries(users).map(([k, u]) => ({ k, ...u, _total: total(u) }));
  const qq = q.trim().toLowerCase();
  if (qq) list = list.filter((u) => u.name.toLowerCase().includes(qq) || (u.note || '').toLowerCase().includes(qq) || (u.tags || []).some((t) => t.toLowerCase().includes(qq)));
  if (tagFilter) list = list.filter((u) => (u.tags || []).includes(tagFilter));
  if (subFilter) list = list.filter((u) => u.subs && u.subs[subFilter]);

  const val = (u) => ({ name: u.name.toLowerCase(), total: subFilter ? u.subs[subFilter] : u._total, updated: u.updated || 0, lastSeen: u.lastSeen || 0, comp: compN(u) }[sort.col]);
  list.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sort.dir);
  const arrow = (c) => (sort.col === c ? (sort.dir > 0 ? ' ↑' : ' ↓') : '');

  $('#main').innerHTML = `
    <div class="bar">
      <input class="grow" id="q" placeholder="${T('Поиск по нику, метке, заметке')}" value="${esc(q)}">
      <select id="tf"><option value="">${T('Все метки')}</option>${allTags.map((t) => `<option ${t === tagFilter ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select id="sf"><option value="">${T('Все сабы')}</option>${allSubs.map((s) => `<option value="${esc(s)}" ${s === subFilter ? 'selected' : ''}>r/${esc(s)}</option>`).join('')}</select>
      <button class="btn pri" id="add">${T('+ Добавить')}</button>
    </div>
    <div class="card scroll">
      ${list.length ? `<table>
        <thead><tr>
          <th data-sort="name">${T('Юзер')}${arrow('name')}</th>
          <th>${T('Метки')}</th>
          <th data-sort="comp">${T('Нахрюкометр / жалобы')}${arrow('comp')}</th>
          <th>${T('Заметка')}</th>
          <th>${T('Где встречается')}</th>
          <th class="num" data-sort="total">${subFilter ? T('В r/{s}', { s: esc(subFilter) }) : T('Встреч')}${arrow('total')}</th>
          <th data-sort="lastSeen">${T('Последний раз')}${arrow('lastSeen')}</th>
          <th></th>
        </tr></thead>
        <tbody>${list.map((u) => {
          const top = Object.entries(u.subs || {}).sort((a, b) => b[1] - a[1]);
          return `<tr>
            <td><a href="https://www.reddit.com/user/${esc(u.name)}/" target="_blank">u/${esc(u.name)}</a>
              ${u.taggedIn ? `<div class="mut">${T('помечен в r/{s}', { s: esc(u.taggedIn) })}</div>` : ''}</td>
            <td>${(u.tags || []).map((t) => badge(t, u.color)).join('') || '<span class="mut">—</span>'}</td>
            <td>${meter(compN(u) ? 1 : 0, compN(u))}${compN(u) ? `<div class="mut">${T('жалоб: {n}', { n: compN(u) })}</div>` : ''}</td>
            <td class="note">${esc(u.note) || '<span class="mut">—</span>'}</td>
            <td>${top.slice(0, 4).map(([s, n]) => `<span class="chip click" data-sub="${esc(s)}">r/${esc(s)} · ${n}</span>`).join('')}${top.length > 4 ? `<span class="mut">+${top.length - 4}</span>` : ''}${top.length ? '' : `<span class="mut">${T('ещё не встречен')}</span>`}</td>
            <td class="num">${subFilter ? u.subs[subFilter] : u._total}</td>
            <td class="mut">${ago(u.lastSeen)}${u.lastSub ? `<br>r/${esc(u.lastSub)}` : ''}</td>
            <td class="acts"><button data-edit="${esc(u.k)}" title="${T('Изменить')}">✎</button><button data-del="${esc(u.k)}" title="${T('Удалить')}">🗑</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : `<div class="empty">${Object.keys(users).length ? T('Никого не нашлось') : T('Список пуст. Зайдите на reddit и нажмите 🏷 рядом с ником — или добавьте вручную.')}</div>`}
    </div>`;

  const qi = $('#q');
  qi.oninput = () => { q = qi.value; renderUsers(); const n = $('#q'); n.focus(); n.setSelectionRange(q.length, q.length); };
  $('#tf').onchange = (e) => { tagFilter = e.target.value; renderUsers(); };
  $('#sf').onchange = (e) => { subFilter = e.target.value; renderUsers(); };
  $('#add').onclick = () => openDialog(null);
  document.querySelectorAll('th[data-sort]').forEach((th) => (th.onclick = () => {
    const c = th.dataset.sort;
    sort = sort.col === c ? { col: c, dir: -sort.dir } : { col: c, dir: c === 'name' ? 1 : -1 };
    renderUsers();
  }));
  document.querySelectorAll('[data-sub]').forEach((el) => (el.onclick = () => { subFilter = el.dataset.sub; renderUsers(); }));
  document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openDialog(b.dataset.edit)));
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => {
    const u = users[b.dataset.del];
    if (confirm(T('Удалить u/{n}?', { n: u.name }))) { delete users[b.dataset.del]; saveUsers(); }
  }));
}

function renderSubs() {
  const subs = aggSubs();
  $('#main').innerHTML = subs.length ? `
    <div class="card scroll"><table>
      <thead><tr><th>${T('Сабреддит')}</th><th class="num">${T('Помеченных')}</th><th class="num">${T('Встреч')}</th><th class="num">${T('Жалоб')}</th><th>${T('Состав по меткам')}</th><th>${T('Кто там')}</th></tr></thead>
      <tbody>${subs.map((s) => {
        const tagList = Object.entries(s.tags).sort((a, b) => b[1] - a[1]);
        const colorOf = (t) => safeColor((Object.values(users).find((u) => (u.tags || []).includes(t)) || {}).color || '#8b8d98');
        const sum = tagList.reduce((a, [, n]) => a + n, 0) || 1;
        return `<tr>
          <td><a href="https://www.reddit.com/r/${esc(s.name)}/" target="_blank">r/${esc(s.name)}</a></td>
          <td class="num">${s.users.length}</td>
          <td class="num">${s.total}</td>
          <td class="num">${s.complaints || '<span class="mut">0</span>'}</td>
          <td>${tagList.map(([t, n]) => `${badge(t, colorOf(t))}<span class="mut">×${n}</span> `).join('')}
            <div class="bars">${tagList.map(([t, n]) => `<span style="width:${(n / sum) * 100}%;background:${colorOf(t)}"></span>`).join('')}</div></td>
          <td>${s.users.sort((a, b) => b.n - a.n).slice(0, 6).map(({ u, n }) => `<span class="chip click" data-user="${esc(u.name)}">u/${esc(u.name)} · ${n}</span>`).join('')}${s.users.length > 6 ? `<span class="chip click" data-subu="${esc(s.name)}">${T('ещё {n}…', { n: s.users.length - 6 })}</span>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>` : `<div class="card empty">${T('Пока нет данных. Статистика копится, когда помеченные юзеры попадаются вам в постах и комментах.')}</div>`;

  document.querySelectorAll('[data-user]').forEach((el) => (el.onclick = () => { tab = 'users'; q = el.dataset.user; tagFilter = ''; subFilter = ''; render(); }));
  document.querySelectorAll('[data-subu]').forEach((el) => (el.onclick = () => { tab = 'users'; q = ''; tagFilter = ''; subFilter = el.dataset.subu; render(); }));
}

function renderTags() {
  const tags = aggTags();
  $('#main').innerHTML = tags.length ? `
    <div class="card scroll"><table>
      <thead><tr><th>${T('Метка')}</th><th class="num">${T('Юзеров')}</th><th>${T('Где чаще водятся')}</th></tr></thead>
      <tbody>${tags.map((t) => `<tr>
        <td><span class="click" data-tag="${esc(t.name)}" style="cursor:pointer">${badge(t.name, t.color)}</span></td>
        <td class="num">${t.users.length}</td>
        <td>${Object.entries(t.subs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => `<span class="chip">r/${esc(s)} · ${n}</span>`).join('') || '<span class="mut">—</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : `<div class="card empty">${T('Меток пока нет.')}</div>`;
  document.querySelectorAll('[data-tag]').forEach((el) => (el.onclick = () => { tab = 'users'; q = ''; subFilter = ''; tagFilter = el.dataset.tag; render(); }));
}

// Все жалобы в одном месте: общий слой (все пользователи) + своя группа + мои локальные.
let remoteComplaints = null; // { pub: [...], group: [...], err, t }
let complaintsOnlyMine = false;

async function fetchComplaints() {
  const [pub, grp] = await Promise.all([
    settings.pubOn !== false ? api('/complaints', null, null, true).then((r) => r.complaints, (e) => ({ err: e.message })) : [],
    group.token ? api('/complaints').then((r) => r.complaints, (e) => ({ err: e.message })) : [],
  ]);
  remoteComplaints = {
    pub: Array.isArray(pub) ? pub : [],
    group: Array.isArray(grp) ? grp : [],
    err: pub.err || grp.err || '',
    t: Date.now(),
  };
  if (tab === 'complaints') renderComplaints();
}

function renderComplaints() {
  if (!remoteComplaints || Date.now() - remoteComplaints.t > 60000) {
    if (!remoteComplaints) remoteComplaints = { pub: [], group: [], err: '', t: 0, loading: true };
    fetchComplaints();
  }
  const rc = remoteComplaints;
  const when = dayStr; // только дата: точное время выдавало бы, кто когда сидел на reddit

  // Склеиваем: серверные строки + мои локальные, которых нет на сервере. Один человек на один коммент = одна строка.
  const rows = [];
  const seen = new Set();
  const add = (r) => {
    const key = `${r.user}|${r.thing}|${r.mine ? 'me' : r.src}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(r);
  };
  for (const [k, u] of Object.entries(users)) {
    for (const c of u.complaints || []) {
      add({ user: k, name: u.name, thing: c.thing, sub: c.sub, reason: c.reason, link: c.link, created: c.t, mine: true, src: 'me', k });
    }
  }
  for (const r of rc.pub) add({ ...r, src: 'pub' });
  for (const r of rc.group) add({ ...r, src: 'group' });
  rows.sort((a, b) => b.created - a.created);
  const shown = complaintsOnlyMine ? rows.filter((r) => r.mine) : rows;

  // Топ: сколько жалоб и от скольких «источников»
  const top = {};
  for (const r of rows) {
    const t = (top[r.user] ??= { name: r.name, n: 0, others: 0, mine: 0 });
    t.n++;
    r.mine ? t.mine++ : t.others++;
  }
  const topList = Object.values(top).sort((a, b) => b.n - a.n).slice(0, 12);
  const srcLabel = (r) => (r.mine ? `<b>${T('я')}</b>` : r.src === 'group' ? T('группа') : T('другие'));

  $('#main').innerHTML = `
    <div class="bar">
      <label class="row" style="font-weight:400;gap:6px"><input type="checkbox" id="onlyMine" ${complaintsOnlyMine ? 'checked' : ''}> ${T('Только мои')}</label>
      <span class="mut grow">${settings.pubOn === false ? T('Общие жалобы выключены в настройках — видны только ваши') : T('Здесь жалобы всех пользователей Хрюнебота. Чужие видны, когда на юзера пожаловались минимум 2 разных человека.')}</span>
      <button class="btn" id="cRefresh">${T('Обновить')}</button>
    </div>
    ${rc.err ? `<div class="err" style="margin-bottom:10px">${T('Сервер:')} ${esc(rc.err)}</div>` : ''}
    ${!rows.length
      ? `<div class="card empty">${rc.loading ? T('Загрузка…') : T('Жалоб пока нет. На reddit нажмите на метку или 🏷 у ника → «⚠ Пожаловаться на этот коммент».')}</div>`
      : `
    <h2 style="margin-top:0">${T('Самые зажалованные')}</h2>
    <div class="card" style="padding:12px">${topList.map((t) => `<span class="chip click" data-cuser="${esc(t.name)}">u/${esc(t.name)} · ${t.n}${t.others ? ` <span class="mut">${T('(чужих {n})', { n: t.others })}</span>` : ''} ${meter((t.mine ? 1 : 0) + t.others, t.n)}</span>`).join('')}</div>
    <h2>${T('Все жалобы')} <span class="mut">(${shown.length})</span></h2>
    <div class="card scroll"><table>
      <thead><tr><th>${T('Когда')}</th><th>${T('Кто')}</th><th>${T('На кого')}</th><th>${T('Саб')}</th><th>${T('Причина')}</th><th>${T('Коммент')}</th><th></th></tr></thead>
      <tbody>${shown.slice(0, 1000).map((r) => `<tr>
        <td class="mut">${when(r.created)}</td>
        <td>${srcLabel(r)}</td>
        <td><a href="https://www.reddit.com/user/${esc(r.name)}/" target="_blank">u/${esc(r.name)}</a></td>
        <td>${r.sub ? `r/${esc(r.sub)}` : '<span class="mut">—</span>'}</td>
        <td>${r.reason ? badge(r.reason, users[r.user]?.color || '#8b8d98') : '<span class="mut">—</span>'}</td>
        <td>${linkCell(r.link, '<span class="mut">—</span>')}</td>
        <td class="acts">${r.mine ? `<button data-unc="${esc(r.user)}" data-name="${esc(r.name)}" data-thing="${esc(r.thing)}" title="${T('Отозвать')}">↩</button>` : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>`}`;

  if (adminKey) renderAdmin();
  $('#onlyMine').onchange = (e) => { complaintsOnlyMine = e.target.checked; renderComplaints(); };
  $('#cRefresh').onclick = () => fetchComplaints();
  document.querySelectorAll('[data-cuser]').forEach((el) => (el.onclick = () => {
    const name = el.dataset.cuser;
    if (users[name.toLowerCase()]) { tab = 'users'; q = name; tagFilter = ''; subFilter = ''; render(); }
    else window.open(`https://www.reddit.com/user/${encodeURIComponent(name)}/`, '_blank');
  }));
  document.querySelectorAll('[data-unc]').forEach((b) => (b.onclick = async () => {
    const k = b.dataset.unc, thing = b.dataset.thing, name = b.dataset.name;
    const u = users[k];
    if (u) {
      u.complaints = (u.complaints || []).filter((c) => c.thing !== thing);
      await saveUsers();
    }
    const payload = { user: name, thing, undo: true };
    await Promise.all([
      settings.pubOn !== false ? api('/complain', payload, null, true).catch(() => {}) : null,
      group.token ? api('/complain', payload).catch(() => {}) : null,
    ]);
    fetchComplaints();
  }));
}

// ---------- раздел владельца: кто жаловался (обезличенные номера) ----------

async function fetchAdmin() {
  try {
    const r = await api('/admin/complaints', null, null, false, true);
    adminData = { ...r, err: '' };
  } catch (e) {
    adminData = { complaints: [], perWho: {}, members: 0, err: e.message };
  }
  if (tab === 'complaints') renderComplaints();
}

// ---------- довірені користувачі (п.14) ----------
// ---------- синхронизация между устройствами (п.15) ----------
const syncMsg = (op, extra = {}) => new Promise((res, rej) => chrome.runtime.sendMessage({ type: 'sync', op, ...extra }, (r) => {
  if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
  if (!r || !r.ok) return rej(new Error((r && r.error) || '?'));
  res(r.data);
}));
// Ключ показывается ОДИН раз — держим его на экране, пока человек сам не нажмёт «Я сохранил ключ» (перерисовки не стирают)
let syncShownKey = null, syncGen = 0, syncAttachOpen = false, syncNote = null;
const copyBtn = (id, label) => `<button class="btn" id="${id}">${label || T('Копировать')}</button>`;
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); if (btn) { const o = btn.textContent; btn.textContent = T('✓ Скопировано'); setTimeout(() => { btn.textContent = o; }, 1500); } }
  catch { if (btn) btn.textContent = T('Выделите и скопируйте вручную'); }
}
async function renderSyncBox(shownKey) {
  if (shownKey) syncShownKey = shownKey;
  shownKey = syncShownKey;
  const box = document.querySelector('#syncBox');
  if (!box) return;
  const gen = ++syncGen, stale = () => gen !== syncGen || !box.isConnected; // рисует только последний вызов
  const $ = (q) => box.querySelector(q);
  const intro = `<div class="mut">${T('Ваши метки, заметки, оценки ✔/✖/?, список своих жалоб и настройки — одинаковые на компьютере и телефоне. Сервер хранит их только в зашифрованном виде; подключённые устройства расшифровывают их у себя. Ключ на сервер не передаётся — ни сервер, ни владелец Хрюнебота ваших данных не прочитают. Работает и без общего слоя.')}</div>`;
  let st;
  try { st = await syncMsg('status'); } catch (e) { if (stale()) return; box.innerHTML = intro + `<div class="err">${esc(T(e.message))}</div>`; return; }
  if (stale()) return;
  const note = syncNote ? `<div class="${syncNote.kind === 'err' ? 'err' : 'okc'}" style="margin-top:6px">${esc(syncNote.text)}</div>` : '';
  if (!st.on) {
    box.innerHTML = intro + `<div class="row" style="gap:10px;margin-top:10px">
        <button class="btn pri" id="syCreate">${T('Создать ключ')}</button>
        <button class="btn" id="syAttachOpen" aria-expanded="${syncAttachOpen}">${T('Подключить устройство')}</button></div>
      <div class="mut" style="margin-top:6px">${T('«Создать ключ» — на первом устройстве. «Подключить устройство» — на остальных: введите ключ с первого.')}</div>
      ${syncAttachOpen ? `<div class="row" style="gap:8px;margin-top:8px">
        <input id="syKey" placeholder="HRYU-…" style="width:340px;max-width:100%" autocomplete="off" spellcheck="false" aria-label="${T('Ключ синхронизации')}">
        <button class="btn pri" id="syAttach">${T('Подключить')}</button></div>` : ''}${note}`;
    $('#syCreate').onclick = async (e) => {
      e.target.disabled = true; syncNote = { kind: 'busy', text: T('Создаю ключ…') };
      try { const r = await syncMsg('create'); syncNote = null; renderSyncBox(r.key); } catch (er) { syncNote = { kind: 'err', text: T('Не получилось: {e}', { e: T(er.message) }) }; renderSyncBox(); }
    };
    $('#syAttachOpen').onclick = () => { syncAttachOpen = !syncAttachOpen; renderSyncBox(); setTimeout(() => { const i = document.querySelector('#syKey'); if (i) i.focus(); }, 50); };
    const att = $('#syAttach');
    if (att) {
      const go = async () => {
        const key = $('#syKey').value.trim();
        if (!key) return;
        att.disabled = true; att.textContent = T('Подключаю…');
        try { await syncMsg('attach', { key }); syncAttachOpen = false; syncNote = { kind: 'ok', text: T('✓ Устройство подключено, данные подтянуты') }; renderSyncBox(); }
        catch (er) { att.disabled = false; att.textContent = T('Подключить'); const n = box.querySelector('.err') || box.appendChild(document.createElement('div')); n.className = 'err'; n.textContent = T('Не получилось: {e}', { e: T(er.message) }); }
      };
      att.onclick = go;
      $('#syKey').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    }
    return;
  }
  let dv = null;
  try { dv = await syncMsg('devices'); } catch { /* покажем ошибку из статуса */ }
  if (stale()) return;
  const when = (t) => (t ? new Date(t).toLocaleString(LOCALE()) : '—');
  // одно понятное состояние: всё сохранено / есть несинхронизированные изменения / ошибка / конфликт заметки
  const lost = st.lost || [];
  const state = st.broken ? ['err', '⛔', T('Это устройство отключено или ключ сменили на другом устройстве. Введите новый ключ или выключите синхронизацию здесь.')]
    : st.err ? ['err', '⚠', T('Ошибка синхронизации: {e}. Повторю сама через несколько минут.', { e: T(st.err) })]
    : lost.length ? ['warn', '⚠', T('Конфликт заметки: {n}. Ниже — ваш вариант, его можно вернуть.', { n: lost.length })]
    : st.dirty ? ['warn', '⏳', T('Есть несинхронизированные изменения ({n}) — отправлю в течение минуты.', { n: st.dirty })]
    : ['ok', '✅', T('Всё сохранено. Последняя синхронизация: {t}', { t: when(st.last) })];
  box.innerHTML = intro
    + (shownKey ? `<div class="keybox"><div>${T('Ключ синхронизации — введите его на другом своём устройстве:')}</div>
        <div class="row" style="gap:8px;margin:6px 0"><code class="key">${esc(shownKey)}</code>${copyBtn('syCopy')}</div>
        <div class="err">${T('⚠ Сохраните ключ сейчас (в менеджере паролей или на бумаге) — больше он не показывается. Только с ним можно восстановить данные, если потеряете все устройства. Ключ даёт доступ к вашим данным и доверию: никому не пересылайте.')}</div>
        <button class="btn" id="syKeySaved" style="margin-top:6px">${T('Я сохранил ключ — скрыть')}</button></div>` : '')
    + `<div class="state st-${state[0]}" role="status"><span aria-hidden="true">${state[1]}</span> ${esc(state[2])}</div>${note}`
    + (lost.length ? lost.map((x, i) => `<div class="lost"><div><b>u/${esc(x.name)}</b> <span class="mut">${when(x.t)}</span></div>
          <div class="mut">${T('Ваш вариант:')}</div><div class="lost-text">${esc(x.local)}</div>
          <div class="mut">${T('Сейчас (с другого устройства):')} ${x.server ? esc(x.server) : T('(удалено)')}</div>
          <div class="row" style="gap:8px;margin-top:6px"><button class="btn pri" data-lrestore="${i}">${T('Вернуть мой вариант')}</button>
            <button class="btn" data-lcopy="${i}">${T('Копировать мой')}</button><button class="btn" data-ldrop="${i}">${T('Оставить текущий')}</button></div></div>`).join('') : '')
    + (dv ? `<div class="mut" style="margin-top:8px">${T('Устройства ({n}):', { n: dv.devices.length })} ${dv.devices.map((d) => `${d.me ? '<b>' + T('это') + '</b>' : '#' + esc(d.id)} — ${T('последний раз {l}', { l: when(d.last) })}`).join('; ')}</div>` : '')
    + `<div class="row" style="gap:8px;margin-top:10px">
        <button class="btn" id="syNow">${T('Синхронизировать сейчас')}</button>
        <button class="btn" id="syLeave">${T('Выключить на этом устройстве')}</button>
        <button class="btn dng" id="syRotate">${T('Отключить устройство и сменить ключ')}</button></div>
      <div class="mut" style="margin-top:6px">${T('Потеряли телефон? «Отключить устройство и сменить ключ»: данные перешифруются новым ключом и сохранятся, все остальные устройства и старый ключ потеряют доступ — на своих введите новый ключ. Доверие вашего аккаунта сохраняется. То, что уже скачано на потерянном устройстве, на нём остаётся.')}</div>`;
  box.querySelectorAll('[data-lcopy]').forEach((b) => { b.onclick = () => copyText(lost[+b.dataset.lcopy].local, b); });
  box.querySelectorAll('[data-ldrop]').forEach((b) => { b.onclick = async () => { await syncMsg('lostDrop', { i: +b.dataset.ldrop }); renderSyncBox(); }; });
  box.querySelectorAll('[data-lrestore]').forEach((b) => { b.onclick = async () => {
    try { await syncMsg('lostRestore', { i: +b.dataset.lrestore }); syncNote = { kind: 'ok', text: T('✓ Ваш вариант возвращён и уйдёт на другие устройства') }; }
    catch (e) { syncNote = { kind: 'err', text: T('Не получилось: {e}', { e: T(e.message) }) }; }
    renderSyncBox();
  }; });
  if (shownKey) {
    $('#syCopy').onclick = (e) => copyText(shownKey, e.target);
    $('#syKeySaved').onclick = () => { if (confirm(T('Точно сохранили? После этого ключ больше не показывается.'))) { syncShownKey = null; renderSyncBox(); } };
  }
  $('#syNow').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = T('Синхронизирую…');
    try { await syncMsg('now'); syncNote = null; } catch (er) { syncNote = { kind: 'err', text: T('Не получилось: {e}', { e: T(er.message) }) }; }
    renderSyncBox();
  };
  $('#syRotate').onclick = async () => {
    if (!confirm(T('Сменить ключ? Все остальные устройства будут отключены — на них нужно будет ввести новый ключ.'))) return;
    try { const r = await syncMsg('rotate'); renderSyncBox(r.key); } catch (e) { syncNote = { kind: 'err', text: T('Не получилось: {e}', { e: T(e.message) }) }; renderSyncBox(); }
  };
  $('#syLeave').onclick = async () => {
    if (!confirm(T('Выключить синхронизацию на этом устройстве? Данные на нём останутся.'))) return;
    try { await syncMsg('leave'); syncNote = null; } catch (e) { syncNote = { kind: 'err', text: T(e.message) }; }
    renderSyncBox();
  };
}

// ---------- доверенный пользователь: один последовательный экран ----------
// 1 ник → 2 код → 3 комментарий → 4 проверка → 5 результат. Видно текущий шаг и следующее действие.
async function renderTrustBox() {
  const box = $('#trustBox');
  if (!box) return;
  const intro = `<div class="mut">${T('В общий слой идут только метки и жалобы доверенных — так новореги не навешают меток нормальным людям. Доверенным становится «свой» в r/tjournal_refugees без плохих меток, подтвердив, что ник его.')}</div>`;
  const privacy = `<details class="mut" style="margin-top:8px"><summary>${T('Что происходит с моими данными')}</summary>${T('Во время подтверждения сервер обрабатывает ваш ник reddit и хранит технический идентификатор аккаунта (не ник) — чтобы один аккаунт был одним голосом. Пока заявка ждёт, ник видит владелец (чтобы подтвердить знакомого вручную); после проверки или когда истечёт срок кода ник удаляется. Кто что поставил, другие не видят.')}</details>`;
  const steps = (cur) => `<ol class="stepper">${[T('Ник'), T('Код'), T('Комментарий'), T('Проверка'), T('Результат')].map((s, i) => `<li class="${i + 1 < cur ? 'done' : i + 1 === cur ? 'cur' : ''}"${i + 1 === cur ? ' aria-current="step"' : ''}>${s}</li>`).join('')}</ol>`;
  let st;
  try { st = await api('/trust/status', undefined, null, true); }
  catch (e) { box.innerHTML = intro + `<div class="err" style="margin-top:6px">${T('Сервер не ответил: {e}', { e: esc(T(e.message)) })}</div><button class="btn" id="trRetry" style="margin-top:6px">${T('Повторить')}</button>`; $('#trRetry').onclick = renderTrustBox; return; }
  if (!st.on) { box.innerHTML = intro + `<div class="mut">${T('Доверие ещё не включено на сервере.')}</div>`; return; }
  const contact = `<a href="${CONTACT}" target="_blank" rel="noopener">${T('Написать владельцу')}</a>`;
  if (st.status === 'trusted') { box.innerHTML = intro + steps(6) + `<div class="state st-ok">✅ ${T('Вы доверенный пользователь')}${st.by === 'manual' ? ' ' + T('(допуск владельца)') : ''}. ${T('Ваши базовые метки и жалобы учитываются в общем слое.')}</div><div class="mut">${T('Комментарий с кодом теперь можно удалить.')}</div>` + privacy; return; }
  if (st.status === 'revoked') { box.innerHTML = intro + `<div class="state st-err">⛔ ${T('Доверие отозвал владелец. Если это ошибка —')} ${contact}.</div>` + privacy; return; }
  if (st.status === 'blocked') { box.innerHTML = intro + `<div class="state st-err">⛔ ${T('Это устройство отключено сменой ключа синхронизации: новые метки и жалобы с него не учитываются (уже принятые остаются). Введите новый ключ в блоке «Синхронизация».')}</div>` + privacy; return; }
  if (st.status === 'pending') {
    const waited = st.tries ? T('Сервер искал комментарий {n}, последний — в {t}. Архив его пока не видит — это обычно, он отстаёт от reddit на часы, иногда на сутки.', { n: N(st.tries, 'раз|раза|раз'), t: new Date(st.checked).toLocaleTimeString(LOCALE()) }) : T('Сервер ещё не проверял — проверка раз в несколько минут.');
    box.innerHTML = intro + steps(st.tries ? 4 : 3) + `
      <div class="step"><b>${T('Ваш код:')}</b> <code class="key">${esc(st.code)}</code> ${copyBtn('trCopy')}</div>
      <div class="step"><b>${T('Напишите его комментарием в r/tjournal_refugees со своего аккаунта')}</b> — ${T('в любом посте.')}
        <a class="btn" href="${TRY_URL}" target="_blank" rel="noopener" style="margin-left:6px">${T('Открыть r/tjournal_refugees ↗')}</a></div>
      <div class="err">${T('⚠ Публикуйте только код, который получили здесь, в своём расширении. Чужой код подтвердит вашим аккаунтом ЧУЖОЕ расширение.')}</div>
      <div class="state st-wait">⏳ ${esc(waited)}</div>
      <div class="mut">${T('Заявка ждёт на сервере — страницу можно закрыть. Не удаляйте комментарий до подтверждения; после — можно. Код действует до {d}.', { d: new Date(st.expires).toLocaleString(LOCALE()) })}</div>
      <div class="row" style="gap:8px;margin-top:8px"><button class="btn" id="trCheck">${T('Обновить статус')}</button><button class="btn dng" id="trCancel">${T('Отменить заявку')}</button></div>` + privacy;
    $('#trCopy').onclick = (e) => copyText(st.code, e.target);
    $('#trCheck').onclick = (e) => { e.target.textContent = T('Проверяю…'); renderTrustBox(); };
    $('#trCancel').onclick = async () => { try { await api('/trust/cancel', {}, null, true); } catch { /* ignore */ } renderTrustBox(); };
    return;
  }
  const why = st.status === 'denied' ? `<div class="state st-err">${T('Не получилось: {r}.', { r: esc(T(st.reason || '')) })} ${T('Если считаете это ошибкой —')} ${contact}.</div>`
    : st.status === 'expired' ? `<div class="state st-warn">${T('Срок кода истёк — получите новый.')}</div>` : '';
  box.innerHTML = intro + steps(1) + why + `<div class="row" style="gap:8px;margin-top:8px">
      <input id="trNick" placeholder="${T('ваш ник reddit')}" style="width:220px" autocomplete="off" aria-label="${T('ваш ник reddit')}">
      <button class="btn pri" id="trStart">${T('Получить код')}</button></div><div class="err" id="trErr"></div>` + privacy;
  const go = async () => {
    const nick = $('#trNick').value.trim();
    if (!nick) return;
    $('#trStart').disabled = true;
    try { await api('/trust/start', { nick }, null, true); renderTrustBox(); }
    catch (e) { $('#trStart').disabled = false; $('#trErr').textContent = T('Не получилось: {e}', { e: T(e.message) }); }
  };
  $('#trStart').onclick = go;
  $('#trNick').onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

// Админка: ручной допуск / отзыв по нику, список (только короткие id — ников сервер не хранит)
async function renderAdminTrust(el) {
  if (!el) return;
  let d;
  try { d = await api('/admin/trust', undefined, null, false, true); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const act = d.trusted.filter((x) => !x.revoked).length;
  el.innerHTML = `<div>${T('Доверенных: {n} (авто {a}, вручную {m}), отозвано {r}, заявок в ожидании {p}. Порог: метка — {t}, жалобы — {c}.', {
      n: act, a: d.trusted.filter((x) => !x.revoked && x.by === 'auto').length, m: d.trusted.filter((x) => !x.revoked && x.by === 'manual').length,
      r: d.trusted.length - act, p: d.pending, t: d.tagMin, c: d.complaintMin })}</div>
    <div class="row" style="gap:8px;margin-top:8px"><input id="atNick" placeholder="${T('ник reddit')}" style="width:200px" autocomplete="off">
      <button class="btn" id="atGrant">${T('Дать доверие')}</button><button class="btn dng" id="atRevoke">${T('Отозвать')}</button></div>
    <div class="mut" style="margin-top:6px">${T('Отзыв сразу убирает голоса и жалобы этого аккаунта из общего слоя. Ников сервер не хранит — в списке только короткие id.')}</div>
    ${d.requests && d.requests.length ? `<div style="margin-top:10px"><b>${T('Заявки в ожидании')}</b> <span class="mut">${T('(архив может отставать — знакомого можно подтвердить вручную)')}</span>
      <div class="mut">${T('Ник в заявке может быть чужим. Прежде чем подтвердить — попросите человека в знакомом канале связи назвать код из своего расширения и сверьте с кодом здесь.')}</div>
      ${d.requests.map((x) => `<div class="row" style="gap:8px;margin-top:4px"><span>u/${esc(x.nick)}</span> <code>${esc(x.code)}</code> <span class="mut">${dayStr(x.created)} · ${T('проверок {n}', { n: x.tries })}</span>
        <button class="btn" data-approve="${esc(x.code)}" data-nick="${esc(x.nick)}">${T('Подтвердить')}</button></div>`).join('')}</div>` : ''}
    <div style="margin-top:8px">${d.trusted.slice(0, 200).map((x) => `<span class="chip" title="${esc(x.by)}">${esc(x.id)} · ${x.by === 'manual' ? '✋' : '🤖'}${x.devices > 1 ? ' · ' + x.devices + '📱' : ''}${x.revoked ? ' · ⛔' : ''}</span>`).join('')}</div>`;
  const go = async (path) => {
    const user = el.querySelector('#atNick').value.trim();
    if (!user) return;
    if (path.endsWith('revoke') && !confirm(T('Отозвать доверие {u}? Его голоса перестанут считаться.', { u: user }))) return;
    try { const r = await api(path, { user }, null, false, true); alert(T('Готово: {id}', { id: r.id })); } catch (e) { alert(T(e.message)); }
    renderAdminTrust(el);
  };
  el.querySelector('#atGrant').onclick = () => go('/admin/trust/grant');
  el.querySelectorAll('[data-approve]').forEach((b) => (b.onclick = async () => {
    const code = b.dataset.approve;
    if (!confirm(T('Подтвердить u/{u} с кодом {c}? Вы сверили этот код с человеком в знакомом канале связи.', { u: b.dataset.nick, c: code }))) return;
    try { const r = await api('/admin/trust/approve', { code }, null, false, true); alert(T('Готово: {id}', { id: r.id })); } catch (e) { alert(T(e.message)); }
    renderAdminTrust(el);
  }));
  el.querySelector('#atRevoke').onclick = () => go('/admin/trust/revoke');
}

function renderAdmin() {
  if (!adminData) { adminData = { complaints: [], perWho: {}, members: 0, err: '', loading: true }; fetchAdmin(); }
  const a = adminData;
  const whoList = Object.entries(a.perWho || {}).sort((x, y) => y[1] - x[1]);
  const mine = adminWho ? a.complaints.filter((c) => c.who === adminWho) : [];
  const myVotes = adminWho ? (a.votes || []).filter((v) => v.who === adminWho) : [];
  const box = document.createElement('div');
  box.innerHTML = `
    <h2 style="margin-top:0">${T('🔑 Владелец: кто жаловался')} <span class="mut">${T('({n} участн. в общем слое)', { n: a.members || 0 })}</span></h2>
    ${a.err ? `<div class="err">${esc(a.err)}</div>` : ''}
    <div class="card" style="padding:12px">
      ${a.loading ? `<span class="mut">${T('Загрузка…')}</span>` : whoList.length
        ? whoList.map(([w, n]) => `<span class="chip click" data-who="${esc(w)}" style="${w === adminWho ? 'outline:2px solid var(--acc)' : ''}">${esc(w)} · ${n}</span>`).join('')
        : `<span class="mut">${T('Жалоб нет')}</span>`}
      <div class="mut" style="margin-top:6px">${T('Номер постоянный для одного участника, но не связан ни с ником, ни с IP. Клик — его жалобы.')}</div>
    </div>
    ${adminWho ? `
    <div class="row" style="margin:10px 0;display:flex;gap:8px;align-items:center">
      <b>${esc(adminWho)}</b> <span class="mut">${T('— {n} жалоб', { n: mine.length })}${myVotes.length ? T(', {n} меток', { n: myVotes.length }) : ''}</span>
      <button class="btn dng" id="purgeWho">${T('Стереть все его жалобы и метки')}</button>
      <button class="btn" id="closeWho">${T('Скрыть')}</button>
    </div>
    <div class="card scroll"><table>
      <thead><tr><th>${T('Когда')}</th><th>${T('На кого')}</th><th>${T('Саб')}</th><th>${T('Причина')}</th><th>${T('Коммент')}</th></tr></thead>
      <tbody>${mine.map((c) => `<tr>
        <td class="mut">${dayStr(c.created)}</td>
        <td><a href="https://www.reddit.com/user/${esc(c.name)}/" target="_blank">u/${esc(c.name)}</a></td>
        <td>${c.sub ? `r/${esc(c.sub)}` : '—'}</td>
        <td>${c.reason ? badge(c.reason, '#8b8d98') : '—'}</td>
        <td>${linkCell(c.link, '—')}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${myVotes.length ? `<div class="card" style="padding:10px;margin-top:8px">${myVotes.map((v) => `<span class="chip">u/${esc(v.name)} · ${esc(v.tag)}</span>`).join('')}</div>` : ''}` : ''}
    <h2>${T('🛡 Доверенные пользователи')}</h2>
    <div class="card" style="padding:12px" id="adminTrust"><span class="mut">${T('Загрузка…')}</span></div>
    <hr style="border:none;border-top:1px solid var(--line);margin:18px 0">`;
  $('#main').prepend(box);

  box.querySelectorAll('[data-who]').forEach((el) => (el.onclick = () => { adminWho = el.dataset.who; renderComplaints(); }));
  renderAdminTrust(box.querySelector('#adminTrust'));
  const close = box.querySelector('#closeWho');
  if (close) close.onclick = () => { adminWho = ''; renderComplaints(); };
  const purge = box.querySelector('#purgeWho');
  if (purge) purge.onclick = async () => {
    if (!confirm(T('Стереть все жалобы и метки {w} из общего слоя? Это не отменить.', { w: adminWho }))) return;
    try {
      const r = await api('/admin/purge', { who: adminWho }, null, false, true);
      alert(T('Удалено записей: {n}', { n: r.removed }));
      adminWho = '';
      remoteComplaints = null;
      fetchAdmin();
    } catch (e) { alert(e.message); }
  };
}

function ruleRow(r) {
  return `<div class="rule row card" style="padding:10px;gap:6px">
    <input class="r-icon" title="${T('Значок')}" value="${esc(r.icon || '🔍')}" maxlength="4" style="width:46px;text-align:center">
    <input class="r-tag" placeholder="${T('Метка')}" value="${esc(r.tag)}" style="width:130px">
    <input class="r-subs grow" placeholder="${T('сабы через запятую: sub1, sub2')}" value="${esc((r.subs || []).join(', '))}">
    <label class="row" style="font-weight:400;gap:4px">${T('мин.')} <input class="r-min" type="number" min="1" value="${r.min || 1}" style="width:60px"></label>
    <label class="row" style="font-weight:400;gap:4px">${T('баллов за 10 нахрюков')} <input class="r-pts" type="number" min="0" max="10" step="0.5" value="${r.points ?? 2}" style="width:60px"></label>
    <button class="btn dng rule-del" title="${T('Удалить правило')}">✕</button>
  </div>`;
}

// ---------- настройки (1.3.96): по задачам ----------
// Вид и язык · Мои метки · Общие оценки и участие · Синхронизация · Доверенный пользователь · Расширенные.
// Переключатели сохраняются сразу (результат — рядом); баллы, пороги, правила и диагностика — в «Расширенных».
const openSecs = new Set(['view', 'mine', 'share']);
function renderSettings() {
  const sec = (id, title, body, hint) => `<details class="card sec" data-sec="${id}" ${openSecs.has(id) ? 'open' : ''}>
      <summary><span>${title}</span>${hint ? `<span class="mut">${hint}</span>` : ''}</summary><div class="set">${body}</div></details>`;
  const sel = (id, cur, opts) => `<select id="${id}">${opts.map(([v, t]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  // переключатель: что он делает и что изменится
  const tog = (id, on, title, what) => `<label class="tog"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}>
      <span><b>${title}</b><span class="mut">${what}</span></span><span class="saved" data-for="${id}" aria-live="polite"></span></label>`;
  const S = settings;
  $('#main').innerHTML = `<div class="secs">
    ${sec('view', T('Вид и язык'), `
      <div class="row"><b>${T('Язык')}</b>${sel('langSel', LANG, [['uk', 'Українська'], ['ru', 'Русский']])}<span class="saved" data-for="langSel"></span></div>
      <div class="row">${T('Размер значков у ника')} ${sel('sizeSel', S.size || 'm', [['s', T('маленький')], ['m', T('средний')], ['l', T('большой')]])}<span class="saved" data-for="sizeSel"></span></div>
      <div class="row">${T('Сколько меток показывать у ника')} ${sel('compactSel', S.compact || 'auto', [['auto', T('1–2 главные, остальные под «+N» (рекомендуется)')], ['always', T('1–2 главные, всегда коротко: значок и число')], ['never', T('все и полностью')]])}<span class="saved" data-for="compactSel"></span></div>
      <div class="row">${T('Метка «свой»')} ${sel('trustStyleSel', S.trustStyle === 'text' ? 'text' : 'bar', [['bar', T('зелёная полоска')], ['text', T('текст «свой»')]])}<span class="saved" data-for="trustStyleSel"></span></div>
      ${tog('showAdd', S.showAdd, T('Показывать 🏷 у ников без меток'), T('Чтобы быстро поставить метку. Выключите — у ников без меток ничего не будет.'))}
    `)}
    ${sec('mine', T('Мои метки и что показывать'), `
      <label class="stack"><b>${T('Быстрые метки (через запятую)')}</b><span class="mut">${T('Кнопки в карточке ника. Свои метки видите только вы (базовые — ещё и общий слой, если он включён).')}</span>
        <span class="row"><input id="presets" class="grow" value="${esc(S.presets.join(', '))}"><button class="btn" id="savePresets">${T('Сохранить')}</button><span class="saved" data-for="presets"></span></span></label>
      <div class="mut" style="margin-top:4px">${T('Что показывать у ников — меняет только то, что видите вы. Общая база, чужие оценки и ваши голоса от этого не меняются.')}</div>
      ${tog('clownOn', S.clownOn !== false, T('«🤡 клоун»'), T('Пишет в r/RedditUaTalks. Это метка места, а не обвинение.'))}
      ${tog('homeDownOn', S.homeDownOn !== false, T('«👎 минусуют тут»'), T('В r/tjournal_refugees его в основном минусуют.'))}
      ${tog('konsOn', S.konsOn !== false, T('«🥫 консерва»'), T('Купленный или долго лежавший аккаунт: молчал, раньше писал по-английски, похож на ферму кармы.'))}
      ${tog('accOn', !!S.accOn, T('«❗ новорег»'), T('Аккаунт моложе {d} дн.', { d: S.newDays || 30 }))}
      ${tog('hiddenOn', S.hiddenOn !== false, T('«🙈 профиль скрыт»'), T('Карма есть, а посты и комменты спрятаны — так делают и обычные люди.'))}
      ${tog('trustOn', S.trustOn !== false, T('Учитывать «свой»'), T('У активных участников TJ слабые подозрения («?», 🥫, 🤡, 👀) скрыты и баллы меньше.'))}
      <div class="row" style="margin-top:6px"><button class="btn" id="export">${T('Экспорт в JSON')}</button><button class="btn" id="importBtn">${T('Импорт из JSON')}</button>
        <input type="file" id="importFile" accept=".json,application/json" hidden><span class="saved" data-for="import"></span></div>
      <div class="mut">${T('Экспорт — ваши метки, заметки, жалобы, оценки и настройки одним файлом. Импорт объединяет: метки складываются.')}</div>
    `)}
    ${sec('share', T('Общие оценки и участие'), `
      ${tog('pubOn', S.pubOn !== false, T('Общий слой'), T('Включён: вы видите общие метки и жалобы, а ваши базовые метки (зрадойоб, орк, новорег, консерва) и жалобы отправляются в общий слой и учитываются, если вы доверенный пользователь. Выключен: ничего не отправляется и не показывается из общего слоя; уже отправленное остаётся, пока вы его не снимете.'))}
      ${tog('helpQueue', S.helpQueue === true, T('Отправлять ники в очередь проверки'), consentText())}
      <div class="mut" id="consentNow2">${consentChoice()}</div>
      <div class="mut">${T('Это разные вещи: скрыть метку у себя — раздел выше; общий слой — ваши голоса для всех; очередь — помощь базе новыми никами.')}</div>
      <div class="mut">${T('Кто пожаловался, другие пользователи не видят. Владелец видит только обезличенный номер участника (например «Ж-3fa9c1») — чтобы стирать спам. IP и точное время не хранятся.')}</div>
    `)}
    ${sec('sync', T('Синхронизация между устройствами'), '<div id="syncBox"></div>')}
    ${sec('trust', T('Доверенный пользователь'), '<div id="trustBox"></div>')}
    ${sec('adv', T('Расширенные'), `
      <div class="mut">${T('Баллы, пороги, правила автопроверки и диагностика. Менять не обязательно — значения по умолчанию подобраны.')}</div>
      <div class="row">${T('🐽 Нахрюкометр: баллов до 50%')} <input id="halfAt" type="number" min="1" max="50" value="${S.halfAt || 7}" style="width:70px"></div>
      <div class="mut" id="halfHint"></div>
      <div class="mut">${T('Баллы: каждый отдельный человек, который пожаловался, — 1 балл (повторные жалобы от него — по 0,25). Нахрюки (посты и комменты юзера в сабах из правил) — баллы правила за каждые 10. Чем больше число — тем строже шкала.')}</div>
      ${tog('autoOn', S.autoOn !== false, T('Автопроверка по сабам'), T('Хрюнебот сам смотрит последние ~100 комментов и постов ника, если его нет в общей базе.'))}
      <label class="stack">${T('Проверять историю только у ников из сабов (через запятую; пусто — везде)')}<input id="autoSubs" value="${esc((S.autoSubs || []).join(', '))}" placeholder="tjournal_refugees"></label>
      ${tog('archFallback', S.archFallback !== false, T('Если reddit просит подождать — брать историю из архива ArcticShift'), T('Быстрее; ник проверяемого уходит в открытый архив.'))}
      <div id="rules" style="display:grid;gap:8px">${(S.autoRules || []).map(ruleRow).join('')}</div>
      <div class="row"><button class="btn" id="addRule">${T('+ Правило')}</button></div>
      <div class="mut">${T('Учитывается, как человека встретили в этих сабах: если его там в основном плюсуют — метка правила (👹 орк); если минусят — «🥊 спорщик», в нахрюкометр не идёт; если оценок мало или поровну — «🤷 орк?», половина баллов.')}</div>
      <div class="row">${T('«❗ новорег»: моложе')} <input id="newDays" type="number" min="1" value="${S.newDays}" style="width:70px"> ${T('дн., баллов')} <input id="accPoints" type="number" min="0" max="10" step="0.5" value="${S.accPoints}" style="width:64px"></div>
      <div class="row">${T('«🥫 консерва»: баллов')} <input id="konsPoints" type="number" min="0" max="10" step="0.5" value="${S.konsPoints ?? 4}" style="width:64px"> ${T('«консерва?» —')} <input id="konsWeakPoints" type="number" min="0" max="10" step="0.5" value="${S.konsWeakPoints ?? 1}" style="width:64px"></div>
      <div class="row"><button class="btn pri" id="saveSet">${T('Сохранить расширенные')}</button><span class="saved" data-for="saveSet" aria-live="polite"></span></div>
      <hr>
      <div class="mut" id="reviewInfo"></div>
      <div class="row"><span class="mut" id="histInfo"></span><button class="btn" id="clearHist">${T('Сбросить кэш проверок')}</button></div>
      <label class="stack">${T('🔑 Ключ админа (только для владельца сервера)')}
        <span class="row"><input id="adminKey" type="password" value="${esc(adminKey)}" placeholder="${T('пусто — обычный пользователь')}" autocomplete="off"><button class="btn" id="saveAdmin">${T('Сохранить')}</button><span class="saved" data-for="adminKey"></span></span></label>
      <div class="row"><button class="btn dng" id="wipe">${T('Удалить все мои метки и статистику')}</button></div>
    `)}
  </div>`;

  // запоминаем, какие разделы открыты (на время сеанса)
  document.querySelectorAll('details.sec').forEach((d) => d.addEventListener('toggle', () => { if (d.open) openSecs.add(d.dataset.sec); else openSecs.delete(d.dataset.sec); }));
  const flash = (id, text = T('✓ Сохранено'), bad = false) => {
    const el = document.querySelector(`.saved[data-for="${id}"]`);
    if (!el) return;
    el.textContent = text; el.classList.toggle('err', bad);
    clearTimeout(el.t); el.t = setTimeout(() => { el.textContent = ''; }, 2500);
  };
  const saveNow = (id) => saveSettings().then(() => flash(id), (e) => flash(id, T('Не сохранилось: {e}', { e: e.message }), true));
  $('#langSel').onchange = (e) => { settings.lang = e.target.value; saveNow('langSel'); };
  $('#sizeSel').onchange = (e) => { settings.size = e.target.value; saveNow('sizeSel'); };
  $('#compactSel').onchange = (e) => { settings.compact = e.target.value; saveNow('compactSel'); };
  $('#trustStyleSel').onchange = (e) => { settings.trustStyle = e.target.value; saveNow('trustStyleSel'); };
  for (const id of ['showAdd', 'clownOn', 'homeDownOn', 'konsOn', 'accOn', 'hiddenOn', 'trustOn', 'pubOn', 'autoOn', 'archFallback']) {
    $('#' + id).onchange = (e) => { settings[id] = e.target.checked; saveNow(id); };
  }
  $('#helpQueue').onchange = (e) => { settings.helpQueue = e.target.checked; saveNow('helpQueue'); };
  const savePresets = () => { settings.presets = $('#presets').value.split(',').map((s) => s.trim()).filter(Boolean); saveNow('presets'); };
  $('#savePresets').onclick = savePresets;
  $('#presets').onkeydown = (e) => { if (e.key === 'Enter') savePresets(); };
  renderTrustBox();
  renderSyncBox();
  // Подсказка: сколько процентов даст 1, 3 и 10 человек при выбранной строгости
  const hint = () => {
    const h = Math.max(1, +$('#halfAt').value || 7);
    const nah = (n) => botPercent(nahrukPoints(n, 2), h);
    $('#halfHint').textContent = T('Жалобы: 1 человек ≈ {a}%, 3 ≈ {b}%, 10 ≈ {c}%. Нахрюки (правило на 2 балла): 1 ≈ {d}%, 10 ≈ {e}%, 50 ≈ {f}%.', {
      a: botPercent(botPoints(1, 1), h), b: botPercent(botPoints(3, 3), h), c: botPercent(botPoints(10, 10), h),
      d: nah(1), e: nah(10), f: nah(50),
    });
  };
  $('#halfAt').oninput = hint;
  hint();
  const bindRules = () => document.querySelectorAll('.rule-del').forEach((b) => (b.onclick = () => b.closest('.rule').remove()));
  bindRules();
  $('#addRule').onclick = () => {
    $('#rules').insertAdjacentHTML('beforeend', ruleRow({ icon: '🔍', tag: '', subs: [], min: 3, points: 2 }));
    bindRules();
  };
  chrome.storage.local.get('rt_hist').then((d) => {
    const n = Object.keys(d.rt_hist || {}).length;
    const el = $('#histInfo');
    if (el) el.textContent = n ? T('Проверено ников: {n}', { n }) : T('Пока никого не проверяли');
  });
  $('#clearHist').onclick = async () => { await chrome.storage.local.remove('rt_hist'); $('#histInfo').textContent = T('Кэш сброшен'); };
  chrome.storage.local.get('rt_review').then(({ rt_review: r = {} }) => {
    const v = Object.values(r), c = (m) => v.filter((x) => x.mark === m).length;
    const el = document.getElementById('reviewInfo');
    if (el) el.textContent = T('Ручных оценок вердиктов: {n} (✔ {a} · ✖ {b} · ? {c}) — попадают в «Экспорт в JSON»', { n: v.length, a: c('ok'), b: c('bad'), c: c('doubt') });
  });
  $('#saveAdmin').onclick = () => {
    adminKey = $('#adminKey').value.trim();
    adminData = null; remoteComplaints = null;
    chrome.storage.local.set({ rt_admin: { key: adminKey } }).then(() => flash('adminKey'));
  };
  $('#saveSet').onclick = () => {
    settings.halfAt = Math.min(50, Math.max(1, +$('#halfAt').value || 7));
    settings.autoSubs = $('#autoSubs').value.split(/[\s,]+/).map((s) => s.trim().toLowerCase().replace(/^\/?r\//, '')).filter(Boolean);
    const oldRules = settings.autoRules || [];
    settings.autoRules = [...document.querySelectorAll('.rule')].map((r) => ({
      icon: r.querySelector('.r-icon').value.trim() || '🔍',
      tag: r.querySelector('.r-tag').value.trim(),
      subs: r.querySelector('.r-subs').value.split(/[\s,]+/).map((s) => s.trim().toLowerCase().replace(/^\/?r\//, '')).filter(Boolean),
      min: Math.max(1, +r.querySelector('.r-min').value || 1),
      points: Math.max(0, +r.querySelector('.r-pts').value || 0),
    })).filter((r) => r.tag && r.subs.length).map((r) => keepRuleExtras(r, oldRules));
    settings.newDays = Math.max(1, +$('#newDays').value || 30);
    settings.accPoints = Math.max(0, +$('#accPoints').value || 0);
    settings.konsPoints = Math.max(0, +$('#konsPoints').value || 0);
    settings.konsWeakPoints = Math.max(0, +$('#konsWeakPoints').value || 0);
    saveNow('saveSet');
  };
  $('#export').onclick = async () => {
    const { rt_review: reviews = {} } = await chrome.storage.local.get('rt_review'); // ручные оценки вердиктов тоже выгружаем
    const blob = new Blob([JSON.stringify({ version: 1, users, settings, reviews }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hryunebot-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const incoming = data.users || data;
      let n = 0;
      for (const [k, u] of Object.entries(incoming)) {
        if (!u || !u.name || !/^[A-Za-z0-9_-]{1,32}$/.test(u.name)) continue;
        u.color = safeColor(u.color);
        (u.complaints || []).forEach((c) => { c.link = safeRedditLink(c.link); });
        const cur = users[k];
        if (!cur) { users[k] = u; n++; continue; }
        cur.tags = [...new Set([...(cur.tags || []), ...(u.tags || [])])];
        cur.note = cur.note || u.note;
        cur.subs = cur.subs || {};
        for (const [s, c] of Object.entries(u.subs || {})) cur.subs[s] = Math.max(cur.subs[s] || 0, c);
        const have = new Set((cur.complaints || []).map((c) => c.thing));
        cur.complaints = [...(cur.complaints || []), ...(u.complaints || []).filter((c) => !have.has(c.thing))];
        n++;
      }
      await saveUsers();
      flash('import', T('✓ Импортировано: {n}', { n }));
    } catch (err) {
      flash('import', T('Не получилось прочитать файл: {e}', { e: err.message }), true);
    }
  };
  $('#wipe').onclick = () => {
    if (confirm(T('Удалить все метки и статистику? Это не отменить.'))) { users = {}; saveUsers(); }
  };
}

// ---------- диалог редактирования ----------

let dlgKey = null;
let dlgColor = PALETTE[0];

function openDialog(k) {
  dlgKey = k;
  const u = k ? users[k] : null;
  dlgColor = u?.color || PALETTE[0];
  $('#dlgTitle').textContent = u ? `u/${u.name}` : T('Новый юзер');
  $('#dlgName').value = u?.name || '';
  $('#dlgName').disabled = !!u;
  $('#dlgTags').value = (u?.tags || []).join(', ');
  $('#dlgNote').value = u?.note || '';
  const drawColors = () => {
    $('#dlgColors').innerHTML = PALETTE.map((c) => `<span class="sw ${c === dlgColor ? 'on' : ''}" data-c="${c}" style="background:${c}"></span>`).join('');
    $('#dlgColors').querySelectorAll('.sw').forEach((s) => (s.onclick = () => { dlgColor = s.dataset.c; drawColors(); }));
  };
  drawColors();
  $('#dlgPresets').innerHTML = settings.presets.map((p) => `<span class="chip click" data-p="${esc(p)}">+ ${esc(p)}</span>`).join('');
  $('#dlgPresets').querySelectorAll('[data-p]').forEach((el) => (el.onclick = () => {
    const cur = $('#dlgTags').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!cur.includes(el.dataset.p)) cur.push(el.dataset.p);
    $('#dlgTags').value = cur.join(', ');
  }));
  $('#dlg').showModal();
}

$('#dlg').addEventListener('close', () => {
  if ($('#dlg').returnValue !== 'ok') return;
  const name = $('#dlgName').value.trim().replace(/^\/?u\//i, '');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) { alert(T('Некорректный ник')); return; }
  const k = dlgKey || name.toLowerCase();
  const tags = [...new Set($('#dlgTags').value.split(',').map((s) => s.trim()).filter(Boolean))];
  const note = $('#dlgNote').value.trim();
  const prev = users[k];
  users[k] = { subs: {}, seen: [], created: Date.now(), ...prev, name: prev?.name || name, tags, color: dlgColor, note, updated: Date.now() };
  saveUsers();
});

document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));

load();
