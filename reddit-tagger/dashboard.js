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

// Вопрос «Допомагати поповнювати базу Хрюнебота?» — сразу при установке (фон открывает эту страницу) и пока нет ответа.
// До ответа расширение ничего в очередь не отправляет (queueAction в score.js). Ответ меняется галочкой в настройках.
function renderConsent() {
  const box = $('#consentBox');
  if (!box) return;
  if (queueConsent(settings.helpQueue) !== 'ask') { box.style.display = 'none'; box.textContent = ''; return; }
  box.style.display = '';
  box.innerHTML = `<b style="font-size:16px">${esc(T('Помогать пополнять базу Хрюнебота?'))}</b>
    <div class="mut" style="margin:8px 0 12px">${esc(T('Хрюнебот будет отправлять владельцу ники пользователей reddit, которых проверил сам, и предварительные результаты проверки. Не отправляются: куки, токены, тексты комментариев. Публикует владелец только после своей проверки. Изменить можно в настройках.'))}</div>
    <div class="row" style="display:flex;gap:10px">
      <button class="btn pri" id="consentYes" style="min-height:40px;padding:8px 22px">${esc(T('Да'))}</button>
      <button class="btn" id="consentNo" style="min-height:40px;padding:8px 22px">${esc(T('Нет'))}</button>
    </div>`;
  const answer = (v) => { settings.helpQueue = v; saveSettings(); renderConsent(); render(); };
  $('#consentYes').onclick = () => answer(true);
  $('#consentNo').onclick = () => answer(false);
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
const saveSettings = () => chrome.storage.local.set({ [K_SET]: settings });

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
        <td>${u.complaints ? `${u.complaints} <span class="mut">${T('от {n} чел.', { n: u.complainers })}</span>` : '<span class="mut">—</span>'}</td>
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
    <hr style="border:none;border-top:1px solid var(--line);margin:18px 0">`;
  $('#main').prepend(box);

  box.querySelectorAll('[data-who]').forEach((el) => (el.onclick = () => { adminWho = el.dataset.who; renderComplaints(); }));
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

function renderSettings() {
  $('#main').innerHTML = `
    <div class="card set">
      <div class="row"><b>${T('Язык')}</b>
        <select id="langSel"><option value="uk" ${LANG === 'uk' ? 'selected' : ''}>Українська</option><option value="ru" ${LANG === 'ru' ? 'selected' : ''}>Русский</option></select>
      </div>
      <label>${T('Быстрые метки (через запятую)')}
        <input id="presets" value="${esc(settings.presets.join(', '))}">
      </label>
      <div class="row" style="font-weight:400">${T('Размер значков у ника')}
        <select id="sizeSel">${[['s', T('маленький')], ['m', T('средний')], ['l', T('большой')]].map(([v, t]) => `<option value="${v}" ${(settings.size || 'm') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="row" style="font-weight:400">${T('Сворачивать длинные метки (значок и число, полный текст — при наведении)')}
        <select id="compactSel">${[['auto', T('при 3 и больше метках')], ['always', T('всегда')], ['never', T('никогда')]].map(([v, t]) => `<option value="${v}" ${(settings.compact || 'auto') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="row" style="font-weight:400">${T('Метка «свій»')}
        <select id="trustStyleSel">${[['bar', T('зелёная полоска')], ['text', T('текст')]].map(([v, t]) => `<option value="${v}" ${(settings.trustStyle === 'text' ? 'text' : 'bar') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <label class="row" style="font-weight:400"><input type="checkbox" id="showAdd" ${settings.showAdd ? 'checked' : ''}> ${T('Показывать 🏷 рядом с непомеченными никами')}</label>
      <label class="row" style="font-weight:400"><input type="checkbox" id="pubOn" ${settings.pubOn !== false ? 'checked' : ''}> ${T('Общий слой: мои жалобы и базовые метки (зрадойоб, орк, новорег, консерва) видят все пользователи Хрюнебота, а я — их. Чужая метка видна, когда её поставили 3+ человека.')}</label>
      <label class="row" style="font-weight:400"><input type="checkbox" id="helpQueue" ${settings.helpQueue === true ? 'checked' : ''}> ${T('Помогать пополнять базу: ник, который Хрюнебот проверил сам и которого нет на сервере, уходит владельцу в очередь (только ник и цифры проверки). Публикует владелец после своей проверки.')}</label>
      <div class="row" style="font-weight:400">${T('🐽 Нахрюкометр: баллов до 50%')}
        <input id="halfAt" type="number" min="1" max="50" value="${settings.halfAt || 7}" style="width:70px"></div>
      <div class="mut" id="halfHint"></div>
      <div class="mut">${T('Баллы: каждый отдельный человек, который пожаловался, — 1 балл (повторные жалобы от него — по 0,25). Нахрюки (посты и комменты юзера в сабах из правил) — баллы правила за каждые 10. Чем больше число — тем строже шкала.')}</div>
      <div class="mut">${T('Кто пожаловался, другие пользователи не видят. Владелец сервера видит только обезличенный номер участника (например «Ж-3fa9c1») — чтобы находить и стирать спам. IP и точное время не хранятся.')}</div>
      <label>${T('🔑 Ключ админа (только для владельца сервера)')}
        <input id="adminKey" type="password" value="${esc(adminKey)}" placeholder="${T('пусто — обычный пользователь')}" autocomplete="off">
      </label>
      <hr style="border:none;border-top:1px solid var(--line);width:100%">
      <div><b>${T('🔍 Автопроверка по сабреддитам')}</b>
        <div class="mut">${T('Для каждого ника на странице смотрим его последние ~100 комментов и ~100 постов. Каждый пост или коммент в сабах из правила — это нахрюк. Если нахрюков не меньше «мин.», у ника появляется пунктирная метка «🔍 метка ×число», а нахрюкометр растёт с числом нахрюков. Запросы идут только на reddit, кэш — сутки.')}</div></div>
      <label class="row" style="font-weight:400"><input type="checkbox" id="autoOn" ${settings.autoOn !== false ? 'checked' : ''}> ${T('Включить автопроверку по сабам')}</label>
      <label>${T('Проверять историю только у ников из сабов (через запятую; пусто — везде)')}
        <input id="autoSubs" value="${esc((settings.autoSubs || []).join(', '))}" placeholder="tjournal_refugees">
      </label>
      <div class="mut">${T('Так проверка быстрее и меньше запросов к reddit. Метки, жалобы и уже посчитанные результаты видны на всех сабах.')}</div>
      <label class="row" style="font-weight:400"><input type="checkbox" id="homeDownOn" ${settings.homeDownOn !== false ? 'checked' : ''}> ${T('«👎 минусуют тут»: в этих сабах его в основном минусуют (60%+), а снаружи плюсуют — 2 балла; без контраста — 1')}</label>
      <label class="row" style="font-weight:400"><input type="checkbox" id="hiddenOn" ${settings.hiddenOn !== false ? 'checked' : ''}> ${T('«🙈 профиль скрыт»: карма есть, а посты и комменты спрятаны — 1 балл (скрывают и обычные люди, это лишь повод присмотреться)')}</label>
      <label class="row" style="font-weight:400"><input type="checkbox" id="clownOn" ${settings.clownOn !== false ? 'checked' : ''}> ${T('«🤡 клоун»: пишет в r/RedditUaTalks — до 2 баллов (метка места, не обвинение; можно выключить)')}</label>
      <label class="row" style="font-weight:400"><input type="checkbox" id="archFallback" ${settings.archFallback !== false ? 'checked' : ''}> ${T('Если reddit просит подождать — брать историю из открытого архива ArcticShift (быстрее; ник проверяемого уходит в архив)')}</label>
      <div id="rules" style="display:grid;gap:8px">${(settings.autoRules || []).map(ruleRow).join('')}</div>
      <div class="row"><button class="btn" id="addRule">${T('+ Правило')}</button></div>
      <div class="mut">${T('Учитывается, как человека встретили в этих сабах: если его там в основном плюсуют — метка правила (👹 орк); если минусят — «🥊 спорщик», в нахрюкометр не идёт; если оценок мало или поровну — «🤷 орк?», половина баллов.')}</div>
      <div><b>${T('❗ Новореги')}</b></div>
      <div class="row" style="font-weight:400">
        <label class="row" style="font-weight:400"><input type="checkbox" id="accOn" ${settings.accOn ? 'checked' : ''}> ${T('Помечать аккаунты моложе')}</label>
        <input id="newDays" type="number" min="1" value="${settings.newDays}" style="width:70px"> ${T('дн. (скрытый профиль — моложе 90 дн.), баллов нахрюкометра')}
        <input id="accPoints" type="number" min="0" max="10" step="0.5" value="${settings.accPoints}" style="width:64px">
      </div>
      <div><b>${T('🥫 Консервы')}</b></div>
      <div class="row" style="font-weight:400">
        <label class="row" style="font-weight:400"><input type="checkbox" id="konsOn" ${settings.konsOn !== false ? 'checked' : ''}> ${T('Искать консервы, баллов нахрюкометра')}</label>
        <input id="konsPoints" type="number" min="0" max="10" step="0.5" value="${settings.konsPoints ?? 4}" style="width:64px">
        ${T('«консерва?» —')}
        <input id="konsWeakPoints" type="number" min="0" max="10" step="0.5" value="${settings.konsWeakPoints ?? 1}" style="width:64px">
      </div>
      <div class="mut">${T('Консерва — аккаунт, который раньше писал по-английски (часто в NSFW), а за последние 3 месяца заговорил кириллицей. Нужно, чтобы аккаунту было 2+ года — или чтобы он пропадал на 4+ месяца перед этим. Много NSFW раньше — «🥫 консерва», мало — «🥫 консерва?» (подозрение, меньше баллов). Ещё «🥫 консерва» — если аккаунт молчал полгода+ и снова пишет, или похож на ферму кармы (фотки в кучу сабов за день, заголовки в пару слов) и сейчас пишет кириллицей. Если аккаунт старше полугода и по reddit раньше не писал кириллицей, ник уходит в открытый архив reddit ArcticShift (arctic-shift.photon-reddit.com): архив видит и удалённые посты. Оттуда берём лишь числа — сколько постов, на каком языке, сколько NSFW и даты. Чужие тексты не показываем и не храним.')}</div>
      <div class="mut" id="reviewInfo"></div>
      <div class="row"><span class="mut" id="histInfo"></span><button class="btn" id="clearHist">${T('Сбросить кэш проверок')}</button></div>
      <div class="row"><button class="btn pri" id="saveSet">${T('Сохранить настройки')}</button><span class="mut" id="saved"></span></div>
      <hr style="border:none;border-top:1px solid var(--line);width:100%">
      <div class="row">
        <button class="btn" id="export">${T('Экспорт в JSON')}</button>
        <button class="btn" id="importBtn">${T('Импорт из JSON')}</button>
        <input type="file" id="importFile" accept=".json,application/json" hidden>
        <button class="btn dng" id="wipe">${T('Удалить всё')}</button>
      </div>
      <div class="mut">${T('Импорт объединяет данные: метки складываются, счётчики по сабам берутся максимальные.')}</div>
    </div>`;

  // Язык меняется сразу, без кнопки «Сохранить»
  $('#langSel').onchange = (e) => { settings.lang = e.target.value; saveSettings(); };
  // Размер тоже сразу — открытые вкладки reddit перерисуются сами
  $('#sizeSel').onchange = (e) => { settings.size = e.target.value; saveSettings(); };
  $('#compactSel').onchange = (e) => { settings.compact = e.target.value; saveSettings(); };
  $('#trustStyleSel').onchange = (e) => { settings.trustStyle = e.target.value; saveSettings(); };
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
  // Ручные оценки вердиктов (хранятся отдельно, сброс кэша их не трогает)
  chrome.storage.local.get('rt_review').then(({ rt_review: r = {} }) => {
    const v = Object.values(r), c = (m) => v.filter((x) => x.mark === m).length;
    const el = document.getElementById('reviewInfo');
    if (el) el.textContent = T('Ручных оценок вердиктов: {n} (✔ {a} · ✖ {b} · ? {c}) — попадают в «Экспорт в JSON»', { n: v.length, a: c('ok'), b: c('bad'), c: c('doubt') });
  });

  $('#saveSet').onclick = () => {
    settings.presets = $('#presets').value.split(',').map((s) => s.trim()).filter(Boolean);
    settings.showAdd = $('#showAdd').checked;
    settings.pubOn = $('#pubOn').checked;
    settings.helpQueue = $('#helpQueue').checked;
    settings.halfAt = Math.min(50, Math.max(1, +$('#halfAt').value || 7));
    adminKey = $('#adminKey').value.trim();
    adminData = null;
    chrome.storage.local.set({ rt_admin: { key: adminKey } });
    remoteComplaints = null;
    settings.autoOn = $('#autoOn').checked;
    settings.archFallback = $('#archFallback').checked;
    settings.homeDownOn = $('#homeDownOn').checked;
    settings.hiddenOn = $('#hiddenOn').checked;
    settings.clownOn = $('#clownOn').checked;
    settings.autoSubs = $('#autoSubs').value.split(/[\s,]+/).map((s) => s.trim().toLowerCase().replace(/^\/?r\//, '')).filter(Boolean);
    const oldRules = settings.autoRules || [];
    settings.autoRules = [...document.querySelectorAll('.rule')].map((r) => ({
      icon: r.querySelector('.r-icon').value.trim() || '🔍',
      tag: r.querySelector('.r-tag').value.trim(),
      subs: r.querySelector('.r-subs').value.split(/[\s,]+/).map((s) => s.trim().toLowerCase().replace(/^\/?r\//, '')).filter(Boolean),
      min: Math.max(1, +r.querySelector('.r-min').value || 1),
      points: Math.max(0, +r.querySelector('.r-pts').value || 0),
    })).filter((r) => r.tag && r.subs.length).map((r) => keepRuleExtras(r, oldRules));
    settings.accOn = $('#accOn').checked;
    settings.newDays = Math.max(1, +$('#newDays').value || 30);
    settings.accPoints = Math.max(0, +$('#accPoints').value || 0);
    settings.konsOn = $('#konsOn').checked;
    settings.konsPoints = Math.max(0, +$('#konsPoints').value || 0);
    settings.konsWeakPoints = Math.max(0, +$('#konsWeakPoints').value || 0);
    saveSettings().then(() => { $('#saved').textContent = T('Сохранено'); });
  };
  $('#export').onclick = async () => {
    const { rt_review: reviews = {} } = await chrome.storage.local.get('rt_review'); // ручные оценки вердиктов тоже выгружаем
    const blob = new Blob([JSON.stringify({ version: 1, users, settings, reviews }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `reddit-tagger-${new Date().toISOString().slice(0, 10)}.json`;
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
      alert(T('Импортировано: {n}', { n }));
    } catch (err) {
      alert(T('Не получилось прочитать файл: {e}', { e: err.message }));
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
