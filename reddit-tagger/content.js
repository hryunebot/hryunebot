// Reddit Tagger — content script.
// Находит ссылки на профили (u/имя) на странице, дописывает рядом метки,
// даёт поставить метку в один клик и считает, в каких сабреддитах
// помеченный юзер встречается.
(() => {
  'use strict';

  const K_USERS = 'rt_users';
  const K_SET = 'rt_settings';
  const DEFAULT_SET = {
    presets: DEFAULT_PRESETS.slice(), // список — в score.js
    presetsV: PRESETS_VERSION,
    showAdd: true,
    size: 'm', // размер значков у ника: s / m / l
    trustStyle: 'bar', // «свій»: зелёная полоска справа от ника ('bar') или текстовая плашка ('text') — 1.3.90
    compact: 'auto', // сворачивать длинные метки в «значок + число»: auto (при 3+ метках) / always / never
    // Автопроверка: [{ icon, tag, subs: ['sub1', ...], min: 1, points: 2 }] — points: баллов за 10 нахрюков
    autoOn: true,
    // Историю юзера проверяем только для ников, встреченных в этих сабах (пусто — везде). Результаты видны везде.
    autoSubs: ['tjournal_refugees'],
    archFallback: true,
    homeDownOn: true, // «👎 минусуют тут»
    hiddenOn: true, // «🙈 профиль скрыт»
    clownOn: true, // «🤡 клоун» (RedditUaTalks) — можно выключить
    hiddenPoints: 1, // reddit просит ждать — история из архива ArcticShift
    autoRules: DEFAULT_RULES.map((r) => ({ ...r })),
    // Проверка аккаунта: моложе newDays дней и карма меньше lowKarma — «❗ свежак»
    accOn: true,
    newDays: 30,
    lowKarma: 100,
    accPoints: 2,
    // «🥫 консерва»: старый акк, раньше английский + NSFW, теперь кириллица. Старую историю берём из архива ArcticShift.
    konsOn: true,
    konsPoints: 4,
    konsWeakPoints: 1, // «🥫 консерва?» — раньше только английский, NSFW мало: подозрение
    // Общий слой жалоб: жалобы видят все пользователи расширения (с порогом в 2 разных человека)
    pubOn: true,
    // Помогать пополнять базу (1.3.80): ник, который расширение проверило само и которого нет на сервере, уходит в очередь
    // владельцу (только ник + предварительные метки и цифры). Публикует владелец после своей проверки.
    // null — ещё не спрашивали: при первой такой проверке показываем вопрос «Так / Ні»; до «Так» ничего не шлём.
    helpQueue: null,
    halfAt: 7, // сколько нахрюков (разных людей) дают 50% на шкале
    lang: 'uk', // основной язык украинский, можно переключить на русский
  };
  const PALETTE = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f', '#8b8d98'];
  // Сенсорный экран (телефон): нет наведения, крупнее кнопки, без автофокуса в поле (1.3.84, Firefox Android).
  const TOUCH = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  const SEEN_CAP = 400; // сколько id постов/комментов помнить на юзера, чтобы не считать дважды

  const K_GROUP = 'rt_group';
  const LOOKUP_TTL = 10 * 60 * 1000;

  let users = {};
  let settings = { ...DEFAULT_SET };
  let group = {}; // { server, token, name, code, minVotes, share }
  let ready = false;

  // ---------- общая группа ----------
  const shared = new Map(); // ник (lower) -> { tags: {метка: голосов}, t }
  const lookupQueue = new Set();
  const remoteSightings = new Map();
  let lookupTimer = null;
  let remoteTimer = null;

  const groupOn = () => !!(group.server && group.token);
  const pubOn = () => settings.pubOn !== false; // общий слой жалоб для всех пользователей

  // pub: true — запрос в общий слой, иначе в свою группу
  // pub: 'open' — открытый запрос без входа (вердикты владельца)
  function api(path, body, pub) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'api', path, body, pub: pub === true, open: pub === 'open' }, (r) => {
          if (chrome.runtime.lastError || !r || !r.ok) resolve(null);
          else resolve(r.data);
        });
      } catch { resolve(null); }
    });
  }

  function needLookup(k) {
    const s = shared.get(k);
    if (s && Date.now() - s.t < LOOKUP_TTL) return;
    if (!s) shared.set(k, { tags: {}, t: 0 }); // заглушка, чтобы не ставить в очередь повторно
    shared.get(k).t = Date.now();
    lookupQueue.add(k);
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(runLookup, 400);
  }

  async function runLookup() {
    const names = [...lookupQueue];
    lookupQueue.clear();
    if (!names.length) return;
    const [r, p, v] = await Promise.all([
      groupOn() ? api('/lookup', { users: names }) : null,
      pubOn() ? api('/lookup', { users: names }, true) : null,
      api('/verdicts', { users: names }, 'open'), // вердикты владельца — без входа, быстро
    ]);
    // Вердикты владельца — только из ответа основного сервера (открытый /verdicts или общий слой), см. score.js.
    const verdicts = srvVerdictsFrom(v, p);
    if (!r && !p && !v) {
      // Сервер не ответил: запомненные вердикты не трогаем, но помечаем как «из памяти, не свежие».
      for (const k of names) { const s = shared.get(k); if (s) s.failed = true; }
      renderAll();
      return;
    }
    for (const k of names) {
      shared.set(k, {
        tags: r?.users?.[k] || {},
        ptags: p?.users?.[k] || {}, // базовые метки общего слоя (видны при 3+ разных людях)
        comp: r?.complaints?.[k] || null,
        pcomp: p?.complaints?.[k] || null,
        // вердикт автопроверки, который выгрузил владелец (общий для всех)
        // undefined — основной сервер про вердикты не ответил (тогда смотрим память и помечаем «не свежие»)
        verdict: verdicts ? verdicts[k] || null : undefined,
        failed: !verdicts,
        t: Date.now(),
      });
    }
    // Запоминаем вердикты: в следующий раз метка появится сразу, ещё до ответа сервера.
    // Сервер ответил — его слово главное: новый вердикт заменяет запомненный, а если вердикт сняли — забываем и мы.
    if (srvCacheMerge(srvCache, names, verdicts, Date.now())) srvDirty = true;
    if (verdicts) for (const k of names) noCache.delete(k); // сервер ответил — «перевірити заново» по серверу выполнено
    renderAll();
    scan();
  }

  // Метки группы + базовые метки общего слоя. Друзья могут быть и там, и там — берём максимум, а не сумму.
  const sharedTags = (k) => {
    const s = shared.get(k) || {};
    const out = { ...(s.tags || {}) };
    for (const [t, c] of Object.entries(s.ptags || {})) out[t] = Math.max(out[t] || 0, c);
    return out;
  };
  const groupComp = (k) => (shared.get(k) || {}).comp || { n: 0, p: 0 };
  const pubComp = (k) => (shared.get(k) || {}).pcomp || { n: 0, p: 0 };
  // Жалобы «снаружи»: группа и общий слой пересекаются (друзья там и там), поэтому берём максимум, а не сумму.
  const outerComp = (k) => {
    const g = groupComp(k), p = pubComp(k);
    return { n: Math.max(g.n, p.n), p: Math.max(g.p, p.p), pub: p };
  };
  const hasShared = (k) => Object.keys(sharedTags(k)).length > 0 || groupComp(k).n > 0;

  // ---------- автопроверка истории ----------
  // Берём последние 100 комментов и 100 постов юзера через reddit (.json, с вашими куками),
  // считаем, где он пишет, и сверяем со списком правил из настроек. Кэш — сутки.
  const K_HIST = 'rt_hist';
  // Ручные оценки вердиктов (✔ вірно / ✖ помилка / ? сумнівно) — отдельный ключ: ни сброс кэша проверок,
  // ни обновление вердиктов с сервера их не трогают. { ник: { mark, t, tags: [метки на момент оценки] } }
  const K_REVIEW = 'rt_review';
  let reviews = {};
  const K_SRV = 'rt_srv'; // вердикты владельца с сервера — запасной вариант, пока сервер не ответил (3 дня)
  const SRV_TTL = 3 * 86400000;
  let srvCache = {};
  let srvDirty = false;
  const HIST_TTL = 24 * 3600 * 1000;
  const HIST_CAP = 5000;
  const HIST_DELAY = 1200; // пауза между запросами, чтобы reddit не резал
  // Лимит reddit: в каждом ответе есть x-ratelimit-remaining (сколько запросов осталось) и x-ratelimit-reset
  // (через сколько секунд счётчик сбросится). Когда запросы кончаются — ждём сброса заранее, а не ловим 429.
  let rlUntil = 0;
  const archTried = new Set(); // ники, для которых архив уже пробовали в этот раз (чтобы не крутиться)
  async function redditGet(url, k) {
    // Лимит надолго, а архив для этого ника ещё не пробовали — не ждём, отдаём «429»: ник уйдёт в архив.
    if (rlUntil - Date.now() > 15000 && settings.archFallback !== false && !archTried.has(k)) {
      return { status: 429, ok: false, headers: new Headers() };
    }
    if (Date.now() < rlUntil) {
      setStage(k, 'wait', rlUntil);
      await sleep(rlUntil - Date.now());
      setStage(k, 'reddit');
    }
    const r = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20000) });
    const left = parseFloat(r.headers.get('x-ratelimit-remaining'));
    const reset = parseFloat(r.headers.get('x-ratelimit-reset'));
    if (r.status === 429) rlUntil = Date.now() + ((reset > 0 ? reset : 30) + 1) * 1000;
    else if (left >= 0 && left < 3 && reset > 0) rlUntil = Date.now() + (reset + 1) * 1000;
    return r;
  }
  let hist = {};
  const histQueue = [];
  const histQueued = new Set();
  let histBusy = false;
  let histDirty = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const rules = () => (settings.autoOn !== false ? settings.autoRules || [] : []).filter((r) => r.tag && r.subs && r.subs.length && !(r.tag === 'клоун' && settings.clownOn === false));

  // Кэш свежий: сутки; если архив тогда не ответил — только 10 минут (и для старых записей тоже).
  // Из архива (reddit был в лимите) — час: потом перепроверим через reddit, там настоящие оценки.
  const histFresh = (h) => !!h && h.v === 7 && Date.now() - h.t <
    (h.arch && h.arch.err ? 10 * 60 * 1000 : h.src === 'arch' ? 60 * 60 * 1000 : HIST_TTL);

  // Можно ли запускать проверку истории для ника, встреченного в сабе sub.
  const autoHere = (sub) => {
    const only = settings.autoSubs || [];
    return !only.length || (!!sub && only.includes(String(sub).toLowerCase()));
  };

  // Открыли окно метки — этот ник проверяем первым.
  function bumpHist(k, name, sub, force) {
    if (name) histNames.set(k, name);
    if (!autoHere(sub)) return;
    const h = hist[k];
    if (!force && histFresh(h)) return;
    const i = histQueue.findIndex((x) => x.k === k);
    if (i > 0) histQueue.unshift(histQueue.splice(i, 1)[0]);
    else if (i < 0 && !histQueued.has(k)) { histQueued.add(k); histQueue.unshift({ k, name }); pumpHist(); }
  }

  const histNames = new Map(); // ник (lower) → как пишется (для очереди владельцу)
  function needHist(k, name, sub) {
    if (name) histNames.set(k, name);
    if (!autoHere(sub)) return;
    if ((!rules().length && !settings.accOn && !settings.konsOn) || /^\[deleted\]$/i.test(k) || isServiceBot(k)) return;
    const h = hist[k];
    // v4 — кэш с плюсами/минусами по сабам и языком свежих постов; старые записи перепроверяем.
    if (histFresh(h)) return;
    if (histQueued.has(k)) return;
    histQueued.add(k);
    histQueue.unshift({ k, name }); // кто только что появился на экране — раньше тех, кого уже пролистали
    setTimeout(pumpHist, 1500); // сначала пусть придёт ответ сервера: вдруг ник уже проверен владельцем
  }

  // Что сейчас проверяется и на каком этапе — показываем в окне метки.
  let histNow = { k: null, stage: '' };
  // Пока ждём лимит — раз в секунду обновляем отсчёт в открытом окне.
  setInterval(() => {
    if (histNow.stage === 'wait' && pop && pop.isConnected) {
      const el = pop.querySelector('.rt-checkline');
      if (el) el.innerHTML = checkHtml(pop.dataset.user);
    }
  }, 1000);
  function setStage(k, stage, until) {
    histNow = { k, stage, until };
    if (pop && pop.isConnected) {
      const el = pop.querySelector('.rt-checkline');
      if (el) el.innerHTML = checkHtml(pop.dataset.user);
    }
  }

  // Очередь не должна умирать от ошибки на одном нике: ловим, пропускаем ник и идём дальше.
  async function pumpHist() {
    if (histBusy) return;
    histBusy = true;
    try { await pumpLoop(); } catch (e) {
      console.warn('Хрюнебот: автопроверка', e);
      if (histNow.k) histQueued.delete(histNow.k);
    } finally {
      histBusy = false;
      histNow = { k: null, stage: '' };
    }
    if (histQueue.length && alive()) setTimeout(pumpHist, 1000);
  }

  // Запись готова — сохраняем и перерисовываем ник (и строку в открытом окне).
  // ---------- очередь новых ников для владельца (1.3.80) ----------
  // Только после СВОЕЙ полной проверки (архив, если спрашивали, ответил) и только если на сервере вердикта нет.
  // Уходит ник, предварительные коды меток и немного цифр. Ни кук reddit, ни токенов, ни текстов.
  const K_QUEUED = 'rt_queued'; // { ник: когда отправили } — повторно не шлём
  let queued = null;
  const queuePending = new Map();
  let queueTimer = null;
  function preTags(k) {
    const tags = [];
    for (const h of autoHitsRaw(k)) {
      const code = RULE_CODES[h.tag];
      if (h.kons) tags.push(h.kons === 'full' ? 'kons' : 'kons?');
      else if (h.homeDown) tags.push('homedown');
      else if (h.acc) tags.push('novoreg');
      else if (h.hiddenP) tags.push('hidden');
      else if (code) tags.push(h.verdict === 'debater' ? 'deb_' + code : h.verdict === 'unclear' ? code + '?' : code);
    }
    return tags.length ? tags : ['clean'];
  }
  function preEv(h) {
    const ev = {};
    for (const r of DEFAULT_RULES) {
      const o = ruleCount(r, h.subs, h.votes, h.subsP, h.votesP);
      if (o.n) ev[RULE_CODES[r.tag]] = { n: o.n, up: o.up, down: o.down };
    }
    const hv = homeVotes(h.votes, settings.autoSubs || []);
    ev.home = { up: hv.up, down: hv.down };
    ev.src = h.src === 'arch' ? 'arch' : 'reddit';
    return ev;
  }
  async function enqueueNew(k, name, entry) {
    const act = queueAction(settings.helpQueue); // send / hold (не спрашивали) / drop (отказ) — score.js
    if (act === 'drop' || !pubOn() || isServiceBot(k) || /^\[deleted\]$/i.test(k)) return;
    if (!entry || entry.v !== 7 || (entry.arch && entry.arch.err)) return; // проверка неполная — не шлём
    if (srvVerdict(k)) return; // на сервере уже есть вердикт
    if (!queued) queued = (await chrome.storage.local.get(K_QUEUED))[K_QUEUED] || {};
    if (queued[k]) return;
    queuePending.set(k, { user: name || entry.name || k, tags: preTags(k), ev: preEv(entry) });
    if (act === 'hold') { askConsent(); return; } // придерживаем в памяти, пока не ответят
    clearTimeout(queueTimer);
    queueTimer = setTimeout(flushQueue, 20000);
  }
  // Вопрос о согласии — один раз, маленькой панелью внизу страницы. Ответ сохраняется в настройках (можно поменять там же).
  let consentShown = false;
  function askConsent() {
    if (consentShown || queueConsent(settings.helpQueue) !== 'ask') return;
    consentShown = true;
    // Узкая полоска в одну строку (1.3.85): обычно вопрос задаётся при установке на странице расширения, а сюда
    // попадают только обновившиеся. Полное пояснение — по «Докладніше», чтобы не закрывать reddit.
    const box = document.createElement('div');
    box.className = 'rt-consent rt-consent-mini';
    const row = document.createElement('div');
    row.className = 'rt-consent-row';
    const q = document.createElement('span');
    q.className = 'rt-consent-q';
    q.textContent = '🐽 ' + T('Помогать пополнять базу Хрюнебота?');
    const yes = document.createElement('button');
    yes.textContent = T('Да');
    yes.className = 'rt-consent-yes';
    const no = document.createElement('button');
    no.textContent = T('Нет');
    const more = document.createElement('button');
    more.textContent = T('Подробнее');
    more.className = 'rt-consent-more';
    row.append(q, yes, no, more);
    const small = document.createElement('div');
    small.className = 'rt-consent-why';
    small.hidden = true;
    small.textContent = T('Хрюнебот будет отправлять владельцу ники пользователей reddit, которых проверил сам, и предварительные результаты проверки. Не отправляются: куки, токены, тексты комментариев. Публикует владелец только после своей проверки. Изменить можно в настройках.');
    more.onclick = () => { small.hidden = !small.hidden; };
    box.append(row, small);
    const answer = async (v) => {
      box.remove();
      const cur = (await chrome.storage.local.get(K_SET))[K_SET] || {};
      await chrome.storage.local.set({ [K_SET]: { ...cur, helpQueue: v } });
      settings.helpQueue = v;
      if (v) { clearTimeout(queueTimer); queueTimer = setTimeout(flushQueue, 2000); } else queuePending.clear();
    };
    yes.onclick = () => answer(true);
    no.onclick = () => answer(false);
    document.body.append(box);
  }
  async function flushQueue() {
    if (!queuePending.size) return;
    if (queueAction(settings.helpQueue) !== 'send') return; // без «Так» в сеть ничего не уходит
    const items = [...queuePending.values()].slice(0, 30);
    const r = await api('/queue', { items }, true);
    if (!r) { queueTimer = setTimeout(flushQueue, 5 * 60000); return; } // сервер не ответил — попробуем позже
    const now = Date.now();
    for (const it of items) { const k = it.user.toLowerCase(); queuePending.delete(k); queued[k] = now; }
    const keys = Object.keys(queued);
    if (keys.length > 5000) keys.sort((a, b) => queued[a] - queued[b]).slice(0, keys.length - 5000).forEach((x) => delete queued[x]);
    chrome.storage.local.set({ [K_QUEUED]: queued });
    if (queuePending.size) queueTimer = setTimeout(flushQueue, 20000);
  }

  function finishHist(k, entry) {
    histQueued.delete(k);
    hist[k] = entry;
    enqueueNew(k, histNames.get(k), entry).catch(() => { /* очередь не должна ломать проверку */ });
    histNow = { k: null, stage: '' };
    histDirty = true;
    if (pop && pop.isConnected && pop.dataset.user === k) {
      const el = pop.querySelector('.rt-checkline');
      if (el) el.innerHTML = checkHtml(k);
      // нахрюкометр тоже пересчитываем — автопроверка добавляет баллы
      const sc = botScore(k);
      const ml = pop.querySelector('.rt-meterline');
      if (ml) ml.textContent = sc.pct ? meterLine(sc) : T('Нахрюкометр: жалоб нет');
      const bar = pop.querySelector('.rt-meterbar span');
      if (bar) { bar.style.width = sc.pct + '%'; bar.style.background = meterColor(sc.pct); }
    }
    document.querySelectorAll(`.rt-wrap[data-user="${CSS.escape(k)}"]`).forEach(render);
  }

  // reddit упёрся в лимит надолго — берём всё из архива ArcticShift (у него свой лимит).
  async function fromArchive(k, name) {
    setStage(k, 'arch');
    const a = await archStats(name, 0, true);
    if (!a || a.err) return false;
    // Профиля в архиве нет — возраст по самому старому посту/комменту (аккаунт не моложе).
    if (!(a.first > 0)) a.first = Math.min(...[a.old && a.old.oldest, a.recent && a.recent.oldest].filter((x) => x > 0), Infinity);
    if (!isFinite(a.first)) a.first = 0;
    const ageOk = a.first > 0;
    finishHist(k, {
      v: 7, t: Date.now(), src: 'arch', subs: a.subs || {}, votes: a.votes || {}, subsP: a.subsP || {}, votesP: a.votesP || {}, farm: a.farm || null,
      // created — первая активность (аккаунт не моложе); karma для «новорега» не берём: возраст неточный.
      acc: ageOk ? { created: a.first * 1000, karma: null, approx: true, lk: a.lk, ck: a.ck } : null,
      rec: { n: a.recent.n, cyr: a.recent.cyr, lat: a.recent.lat, cyrPosts: a.recent.cyrPosts, sleep: Math.round(a.sleep || 0) },
      prev: { cyr: a.old.cyr, lat: a.old.lat },
      arch: a,
    });
    return true;
  }

  async function pumpLoop() {
    while (histQueue.length && alive()) {
      const { k, name } = histQueue.shift();
      // На сервере уже есть свежий вердикт — сами не проверяем (кроме «перевірити заново»).
      if (srvVerdict(k) && !forced.has(k)) { histQueued.delete(k); continue; }
      forced.delete(k);
      if (rlUntil - Date.now() > 15000 && settings.archFallback !== false && !archTried.has(k)) {
        archTried.add(k);
        if (await fromArchive(k, name)) { archTried.delete(k); continue; }
      }
      setStage(k, 'reddit');
      const subs = {};
      const votes = {}; // саб -> { up, down } — как к нахрюкам отнеслись в самом сабе
      const subsP = {}, votesP = {}; // то же только по постам (пост весит больше — POST_W в score.js)
      let ok = true;
      let acc = null;
      const rec = { n: 0, cyr: 0, lat: 0, cyrPosts: 0 }; // язык постов/комментов за последние ~3 месяца
      const prev = { cyr: 0, lat: 0 }; // язык того, что старше 3 месяцев (сколько reddit отдал)
      const times = []; // даты постов/комментов — для «спящего» акка
      const posts = []; // посты — для «фермы кармы»
      let seen = 0;
      let arch = null;
      // Возраст и карма аккаунта
      try {
        const r = await redditGet(`${location.origin}/user/${encodeURIComponent(name)}/about.json?raw_json=1`, k);
        if (r.status === 429) { histQueue.unshift({ k, name }); continue; } // лимит — тот же ник повторим первым
        if (r.ok) {
          const d = (await r.json().catch(() => null))?.data;
          if (d?.created_utc) acc = { created: d.created_utc * 1000, karma: (d.link_karma || 0) + (d.comment_karma || 0), lk: d.link_karma || 0, ck: d.comment_karma || 0 };
        }
        await sleep(HIST_DELAY);
      } catch { /* сеть — пропускаем */ }
      // overview — посты и комменты вместе одним запросом (лимит reddit маленький, экономим).
      for (const kind of ['overview']) {
        let r;
        try {
          r = await redditGet(`${location.origin}/user/${encodeURIComponent(name)}/${kind}.json?limit=100&raw_json=1`, k);
        } catch { ok = false; break; }
        if (r.status === 429) { // слишком часто — ждём и пробуем снова (тот же ник — первым, не в конец)
          histQueue.unshift({ k, name });
          ok = null;
          break; // ожидание до сброса лимита — в redditGet перед следующим запросом
        }
        if (r.ok) {
          const j = await r.json().catch(() => null);
          for (const c of j?.data?.children || []) {
            const d = c.data || {};
            const s = (d.subreddit || '').toLowerCase();
            if (!s) continue;
            subs[s] = (subs[s] || 0) + 1;
            if (c.kind === 't3') subsP[s] = (subsP[s] || 0) + 1;
            seen++;
            if (d.created_utc) times.push(d.created_utc);
            if (c.kind === 't3') posts.push({ t: d.created_utc, s, img: postIsImg(d.url, d.selftext), words: titleWords(d.title) });
            if (d.created_utc && Date.now() / 1000 - d.created_utc < KONS_RECENT) {
              rec.n++;
              const l = textLang((d.title || '') + ' ' + (d.selftext || '') + ' ' + (d.body || ''));
              if (l) rec[l]++;
              if (l === 'cyr' && c.kind === 't3') rec.cyrPosts++; // t3 — пост, t1 — коммент
            } else if (d.created_utc) {
              const l = textLang((d.title || '') + ' ' + (d.selftext || '') + ' ' + (d.body || ''));
              if (l) prev[l]++;
            }
            // Оценка сообщества: заплюсовали (score >= 2) — «свой», заминусовали (score <= 0) — спорил.
            // Свежие (< 2 ч) и со скрытым рейтингом не считаем: их ещё не успели оценить.
            const fresh = d.created_utc && Date.now() / 1000 - d.created_utc < 2 * 3600;
            if (fresh || d.score_hidden || typeof d.score !== 'number') continue;
            const v = (votes[s] ??= { up: 0, down: 0 });
            const vp = c.kind === 't3' ? (votesP[s] ??= { up: 0, down: 0 }) : null;
            if (d.score >= 2) { v.up++; if (vp) vp.up++; }
            else if (d.score <= 0) { v.down++; if (vp) vp.down++; }
          }
        }
        await sleep(HIST_DELAY);
      }
      if (ok === null) continue; // повтор в очереди
      // Кандидат в консервы (старый акк, свежие посты кириллицей) — смотрим старую историю в архиве.
      // Старый акк, который по видимой на reddit истории раньше не писал кириллицей, — смотрим архив:
      // там и старая история, и свежие посты (включая удалённые модераторами).
      // Скрытый профиль: reddit отдал карму, а история пустая (юзер сам спрятал посты и комменты).
      const hiddenNow = ok === true && seen === 0 && !!acc && (acc.lk || 0) + (acc.ck || 0) > 50;
      // Архив нужен для консервы — и для скрытых профилей любого возраста: иначе сабы/оценки неизвестны
      // (комменты публичные, архив их хранит).
      if (ok && acc && ((settings.konsOn && konsNeedArch((Date.now() - acc.created) / 86400000, prev)) || (hiddenNow && settings.archFallback !== false))) {
        setStage(k, 'arch');
        arch = (await archStats(name, acc.created / 1000)) || { err: 'no answer' }; // err — архив не ответил
      }
      // reddit не отдал профиль (не лимит, а другая ошибка) — пробуем всё взять из архива.
      if (!acc && ok !== null && settings.archFallback !== false && !archTried.has(k)) {
        archTried.add(k);
        if (await fromArchive(k, name)) { archTried.delete(k); continue; }
      }
      archTried.delete(k);
      // Архив не ответил — запись «протухнет» через 10 минут (а не через сутки), и проверим снова.
      const t = arch && arch.err ? Date.now() - HIST_TTL + 10 * 60 * 1000 : Date.now();
      // Самое долгое молчание по reddit (до регистрации — только если reddit отдал всю историю, < 100).
      rec.sleep = acc ? Math.round(konsSleep(times, acc.created / 1000, seen < 100, Date.now() / 1000)) : 0;
      // период, за который перерывы видны: вся история (если reddit отдал всё) или от самого старого из 100
      rec.spanFrom = times.length ? Math.min(...times) : 0;
      rec.span = acc && seen < 100 ? Math.round((Date.now() - acc.created) / 86400000) : times.length ? Math.round(Date.now() / 86400000 - Math.min(...times) / 86400) : 0;
      // Очень активный (reddit показал меньше года) и в архив не ходили — досматриваем перерывы по отрезкам.
      if (acc && !arch && ok === true && settings.konsOn && rec.span < 365 && (Date.now() - acc.created) / 86400000 >= 180 && settings.archFallback !== false) {
        setStage(k, 'arch');
        const g = await gapsAsk(name, rec.spanFrom, acc.created / 1000);
        if (g && !g.err) { rec.sleep = Math.max(rec.sleep || 0, g.sleep || 0); rec.probeSpan = g.span || 0; }
      }
      // Сабы и оценки: reddit (свежие) + архив (видит больше и удалённое) — по каждому сабу берём больше.
      const mSubs = ok ? { ...subs } : {}, mVotes = ok ? JSON.parse(JSON.stringify(votes)) : {};
      const mSubsP = ok ? { ...subsP } : {}, mVotesP = ok ? JSON.parse(JSON.stringify(votesP)) : {};
      const mergeMax = (dS, dV, sS, sV) => {
        for (const [x, n] of Object.entries(sS || {})) dS[x] = Math.max(dS[x] || 0, n);
        for (const [x, v] of Object.entries(sV || {})) {
          const m = (dV[x] ??= { up: 0, down: 0 });
          m.up = Math.max(m.up, v.up || 0);
          m.down = Math.max(m.down, v.down || 0);
        }
      };
      if (arch && !arch.err) { mergeMax(mSubs, mVotes, arch.subs, arch.votes); mergeMax(mSubsP, mVotesP, arch.subsP, arch.votesP); }
      // Профиль скрыт: reddit отдал карму, а история пустая (сам юзер спрятал посты и комменты).
      const hidden = hiddenNow;
      finishHist(k, { v: 7, t, subs: mSubs, votes: mVotes, subsP: mSubsP, votesP: mVotesP, acc, rec, prev, arch, farm: farmStats(posts), hidden });
    }
  }

  // Архив ArcticShift: история до и после «3 месяца назад». Запрос делает фон; приходят только числа
  // (сколько постов, сколько по-английски / кириллицей / в NSFW, даты), сами тексты не сохраняются.
  const KONS_RECENT = 90 * 86400; // «свежая» история — последние 3 месяца (сек)
  // Архив целиком — не дольше 2 минут: иначе один медленный ник держит всю очередь.
  let staleBg = ''; // версия фона, если она отстаёт от страничной части
  function archStats(name, created, full) {
    return Promise.race([archAsk(name, created, full), sleep(120000).then(() => ({ err: 'timeout 120s' }))]);
  }
  function gapsAsk(name, from, created) {
    return Promise.race([new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'gaps', user: name, from, created }, (r) => resolve(chrome.runtime.lastError || !r || !r.ok ? null : r.data));
      } catch { resolve(null); }
    }), sleep(90000).then(() => null)]);
  }
  function archAsk(name, created, full) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'arch', user: name, split: Math.floor(Date.now() / 1000) - KONS_RECENT, created: created || 0, full: !!full }, (r) => {
          // Фон другой версии — браузер не перезапустил его после обновления.
          try { if (r && r.bgv !== chrome.runtime.getManifest().version) staleBg = (r.bgv || '?'); } catch { /* нет getManifest — не страшно */ }
          // Ошибка — { err: причина }: покажем её в окне метки и повторим скоро.
          resolve(chrome.runtime.lastError ? { err: chrome.runtime.lastError.message || 'runtime' }
            : !r ? { err: 'no answer' } : !r.ok ? { err: r.error || 'error' } : r.data);
        });
      } catch { resolve(null); }
    });
  }

  // Сохраняем кэш пачками (и не чаще раза в 10 с), чтобы не дёргать перерисовку во всех вкладках.
  setInterval(async () => {
    if (srvDirty && alive()) {
      srvDirty = false;
      const now = Date.now();
      for (const x of Object.keys(srvCache)) if (now - srvCache[x].t > SRV_TTL) delete srvCache[x];
      await chrome.storage.local.set({ [K_SRV]: srvCache });
    }
    if (!histDirty || !alive()) return;
    histDirty = false;
    const stored = (await chrome.storage.local.get(K_HIST))[K_HIST] || {};
    Object.assign(stored, hist);
    const keys = Object.keys(stored);
    if (keys.length > HIST_CAP) {
      keys.sort((a, b) => stored[a].t - stored[b].t).slice(0, keys.length - HIST_CAP).forEach((x) => delete stored[x]);
    }
    await chrome.storage.local.set({ [K_HIST]: stored });
  }, 10000);

  // Какие правила сработали на юзера: [{ tag, n, where: [[sub, n]], points }]
  // ---------- вердикты с сервера (выгрузил владелец) ----------
  const forced = new Set(); // «перевірити заново» — проверяем сами, даже если на сервере есть вердикт
  const noCache = new Set(); // «перевірити заново»: запомненный вердикт не показываем, пока сервер не ответит
  // Свежий ответ сервера, иначе память браузера (с пометкой stale, если сервер сейчас не ответил). Логика — srvPick в score.js.
  const srvVerdict = (k) => {
    const s = shared.get(k) || {};
    return srvPick(s.t ? s.verdict : undefined, srvCache[k], Date.now(), SRV_TTL, !!s.failed, noCache.has(k));
  };
  // Метки из серверного вердикта — в том же виде, что и свои (для render и нахрюкометра).
  function srvHits(k) {
    const v = srvVerdict(k);
    if (!v) return [];
    const ev = v.ev || {}, out = [];
    const base = { srv: v, n: 1, where: [] };
    for (const t of v.tags) {
      if (t === 'kons' || t === 'kons?') {
        if (!settings.konsOn) continue;
        out.push({ ...base, icon: '🥫', tag: 'консерва', kons: t === 'kons' ? 'full' : 'weak',
          points: t === 'kons' ? settings.konsPoints ?? 4 : settings.konsWeakPoints ?? 1 });
      } else if (t === 'homedown' && settings.homeDownOn !== false) {
        const hd = ev.home || { up: 0, down: 0, eUp: 0, eDown: 0 };
        const hv = homeVotes({ a: { up: hd.up, down: hd.down }, b: { up: hd.eUp, down: hd.eDown } }, ['a']);
        out.push({ ...base, icon: '👎', tag: 'минусуют', homeDown: hv, n: hd.down || 0, points: hv.contrast ? 2 : 1 });
      } else if (parseRuleCode(t)) {
        // орк / клоун / слежу и спорщик с источником (deb_ork, deb_clown, deb_watch); цифры — того же источника
        const { kind, verdict } = parseRuleCode(t);
        const o = ev[kind] || { n: 0 };
        if (kind === 'clown' && settings.clownOn === false) continue; // «клоун» выключен в настройках
        const full = srvRuleFull(kind, o.n); // слежу 1, клоун — за нахрюки до 2, орк — за нахрюки (score.js)
        out.push({ ...base, icon: RULE_KIND[kind].icon, tag: RULE_KIND[kind].tag, kind, n: o.n || 0, up: o.up || 0, down: o.down || 0, posts: o.posts, comments: o.comments, bySub: o.bySub,
          verdict, points: ruleHitPoints(full, verdict, o.up || 0, o.down || 0) });
      }
    }
    return out;
  }

  // «Свій»: давний и хорошо принятый в tj (homeTrust в score.js) — слабые подозрения прячем, автобаллы пополам,
  // сильные метки и спорщик остаются, сверху — зелёная плашка «свій». Жалобы людей это не трогает.
  function autoHits(k) {
    const hits = autoHitsRaw(k);
    if (settings.trustOn === false) return hits;
    const h = hist[k];
    let tv = null;
    // «свій» — из того же источника, что и метки: есть серверный вердикт — по его цифрам, иначе по своей проверке
    const sv = srvVerdict(k);
    if (sv) {
      const e = sv.ev && sv.ev.home;
      if (e) tv = trustOf(e); // в цифрах вердикта: up/down, а с 1.3.79 ещё cUp/cDown/trunc (без них — только путь 100+)
    } else if (h && h.v === 7) {
      const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
      tv = homeTrust(h.votes, settings.autoSubs || [], h.votesP, sum(h.subs) - sum(h.subsP)); // видно комментов — для 2-го пути
    }
    if (!tv || !tv.trusted) return hits;
    // слабые прячем; остальное пополам, кроме уверенных орка/клоуна у «свого» по новому пути (trustedPoints в score.js)
    const kept = hits.filter((x) => !isWeakHit(x)).map((x) => ({ ...x, points: trustedPoints(x, tv.way) }));
    // скрытое не теряем: на значках его нет, а в окне ника — строкой «приховано» (1.3.89, прозрачность; баллы те же)
    return [{ trust: tv, tag: 'свой', n: 1, where: [], points: 0, hidden: hits.filter(isWeakHit) }].concat(kept);
  }

  // Метки ника: серверный вердикт главнее своей проверки (hitsSource в score.js, 1.3.88). Своя — localHits, отдельной строкой.
  function autoHitsRaw(k) {
    const h = hist[k];
    const src = hitsSource(!!srvVerdict(k), !!(h && h.v === 7));
    if (src === 'server') return srvHits(k);
    if (src === 'none') return [];
    return localHits(k);
  }
  // Своя проверка расширения (reddit, при лимите — архив). Только для ников без серверного вердикта и для строки «ваша перевірка».
  function localHits(k) {
    const h = hist[k];
    if (!h || h.v !== 7) return [];
    const out = [];
    for (const r of rules()) {
      const where = r.subs.map((s) => [s, h.subs[s] || 0]).filter(([, n]) => n > 0);
      // n — с весом: пост = POST_W комментов; оценки up/down — по реальным записям (ruleCount в score.js)
      const rc = ruleCount(r, h.subs, h.votes, h.subsP, h.votesP);
      const n = rc.n;
      // n — нахрюки: посты/комменты юзера в сабах правила. Баллы растут с их числом
      // (r.points — баллов за каждые 10 нахрюков), а не дают сразу полный балл.
      // Вердикт — по тому, как его встретили в самих этих сабах (см. nahrukVerdict в score.js).
      if (n >= (r.min || 1) && !ruleHidden(r, h.votes, settings.autoSubs || [])) {
        const up = rc.up, down = rc.down;
        const verdict = ruleVerdictOf(r, rc); // уверенный орк/клоун — от 6 нахрюков (score.js)
        const full = rulePoints(r, n);
        out.push({
          icon: r.icon || '🔍', tag: r.tag, n, where, up, down, verdict, posts: rc.posts, comments: rc.comments,
          points: ruleHitPoints(full, verdict, up, down), // вариант C — score.js
        });
      }
    }
    // Свежий аккаунт с маленькой кармой
    const a = h.acc;
    if (settings.accOn && a) {
      const days = Math.floor((Date.now() - a.created) / 86400000);
      // Новорег — сразу, без условия по карме (владелец, 09.11). Скрытый профиль младше 90 дней — тоже новорег.
      if (!a.approx && (days < (settings.newDays ?? 30) || (h.hidden && days < 90))) {
        out.push({ tag: '❗ ' + T('новорег {n} дн.', { n: days }), acc: true, days, karma: a.karma, n: 1, where: [], points: settings.accPoints ?? 2 });
      }
    }
    // Скрытый профиль
    if (h.hidden && settings.hiddenOn !== false) out.push({ icon: '🙈', tag: 'профиль скрыт', hiddenP: true, n: 1, where: [], points: settings.hiddenPoints ?? 1 });
    // Минусуют в «своих» сабах, а снаружи плюсуют
    const home = settings.autoSubs || [];
    if (settings.homeDownOn !== false && home.length) {
      const hv = homeVotes(h.votes, home);
      if (hv.hit) out.push({ icon: '👎', tag: 'минусуют', homeDown: hv, n: hv.down, where: [], points: hv.contrast ? 2 : 1 });
    }
    // Консерва
    const farm = farmOf(h);
    const hdHit = settings.homeDownOn !== false && (settings.autoSubs || []).length && homeVotes(h.votes, settings.autoSubs).hit;
    const kv = settings.konsOn && a ? konservaVerdict((Date.now() - a.created) / 86400000, h.rec, h.arch, sleepOf(h), farm, hdHit) : false;
    if (kv) {
      out.push({
        icon: '🥫', tag: 'консерва', kons: kv, n: 1, where: [], years: Math.floor((Date.now() - a.created) / (365.25 * 86400000)),
        rec: recView(h), old: (h.arch && h.arch.old) || null, gap: Math.round(konsGap(h.arch)), sleep: Math.round(sleepOf(h)), farm, farmText: farmText(h), points: kv === 'full' ? settings.konsPoints ?? 4 : settings.konsWeakPoints ?? 1,
      });
    }
    return out;
  }
  const pc = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  // Возраст аккаунта: младше года — в днях («74 дн.»), старше — в годах.
  const ageStr = (days) => (days < 365 ? T('{n} дн.', { n: Math.floor(days) }) : T('{n} лет', { n: Math.floor(days / 365.25) }));
  // Самое долгое молчание: по reddit и по архиву (если смотрели).
  // Ферма кармы: по архиву (видит удалённые) или по reddit — где больше постов.
  function farmOf(h) {
    const a = h.arch && !h.arch.err && h.arch.farm, r = h.farm;
    const f = a && (!r || a.posts >= r.posts) ? a : r;
    const k = farmKarma(h.acc && h.acc.lk, h.acc && h.acc.ck, h.votes, h.votesP); // неизвестная карма — null (score.js)
    return konsFarm(f, k.lk, k.ck);
  }
  // Сколько последних дней реально просмотрено на перерывы (reddit или архив — где больше).
  // За сколько дней зонд по отрезкам проверил, что перерывов 90+ дней нет (или нашёл).
  const probeSpanOf = (h) => Math.max((h.rec && h.rec.probeSpan) || 0, (h.arch && !h.arch.err && h.arch.probeSpan) || 0);
  const spanOf = (h) => Math.max((h.rec && h.rec.span) || 0, (h.arch && !h.arch.err && h.arch.sleepSpan) || 0);
  const sleepOf = (h) => Math.max((h.rec && h.rec.sleep) || 0, (h.arch && !h.arch.err && h.arch.sleep) || 0);
  // Свежая история: reddit и архив вместе (архив видит и удалённые посты) — берём, где больше данных.
  function recView(h) {
    const r = h.rec || {}, a = (h.arch && h.arch.recent) || {};
    const lr = (r.cyr || 0) + (r.lat || 0), la = (a.cyr || 0) + (a.lat || 0);
    const src = la > lr ? a : r;
    return { cyrPosts: Math.max(r.cyrPosts || 0, a.cyrPosts || 0), cyr: src.cyr || 0, lat: src.lat || 0 };
  }
  // Строка автопроверки для окна метки (HTML, всё экранировано).
  // Своя проверка одной строкой — рядом с серверным вердиктом, для сравнения (не влияет на метки и проценты).
  function ownLine(k) {
    const h = hist[k];
    const hs = localHits(k);
    const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
    const tv = settings.trustOn === false ? null : homeTrust(h.votes, settings.autoSubs || [], h.votesP, sum(h.subs) - sum(h.subsP));
    const shown = tv && tv.trusted ? hs.filter((x) => !isWeakHit(x)) : hs;
    const names = shown.map((x) => x.acc ? `❗${x.days}${T('д')}`
      : x.kons ? `🥫${x.kons === 'weak' ? '?' : ''}`
      : x.homeDown ? `👎×${x.n}`
      : x.hiddenP ? '🙈'
      : x.verdict === 'debater' ? `🥊${x.icon || ''}`
      : `${x.icon || '🔍'}${x.verdict === 'unclear' ? '?' : ''}×${x.n}`);
    if (tv && tv.trusted) names.unshift(T('свой'));
    return T('Ваша проверка ({s}): {r}', { s: h.src === 'arch' ? T('архив') : 'reddit', r: names.length ? names.join(' · ') : T('ничего не нашла') });
  }
  function checkHtml(k) {
    const h = hist[k];
    const done = h && h.v === 7 && !(histQueued.has(k));
    // Есть серверный вердикт — он главный (1.3.88). Своя проверка, если есть или идёт, — отдельной строкой, ничего не перекрывает.
    if (srvVerdict(k)) {
      const sv = srvVerdict(k);
      const lines = [autoLine(autoHits(k)) || (sv.ev && sv.ev.by === 'manual' ? T('Автопроверка: проверено владельцем — ничего не нашли') : T('Автопроверка Хрюнебота (сервер): ничего не нашли'))];
      if (done) lines.push(ownLine(k));
      else if (histQueued.has(k)) lines.push(T('Ваша проверка: идёт…'));
      return lines.flatMap((l) => String(l).split('\n')).map(esc).join('<br>');
    }
    if (!done) {
      if (histNow.k === k) {
        return esc(histNow.stage === 'wait' ? T('Автопроверка: лимит запросов reddit — продолжу через {s} с (залогиньтесь на reddit — лимит больше)', { s: Math.max(1, Math.round(((histNow.until || 0) - Date.now()) / 1000)) })
          : histNow.stage === 'arch' ? T('Автопроверка: смотрю архив ArcticShift…')
          : T('Автопроверка: читаю историю на reddit…'));
      }
      const i = histQueue.findIndex((x) => x.k === k);
      const now = histNow.k ? ' ' + T('(сейчас проверяю u/{u}: {s})', { u: histNow.k,
        s: histNow.stage === 'arch' ? T('архив') : histNow.stage === 'wait' ? T('жду лимит reddit, ещё {s} с', { s: Math.max(1, Math.round(((histNow.until || 0) - Date.now()) / 1000)) }) : 'reddit' }) : '';
      return esc(i >= 0 ? T('Автопроверка: в очереди, место {n}', { n: i + 1 }) + now
        : !autoHere(pop?.dataset.sub) ? T('Автопроверка: только в r/{s}', { s: (settings.autoSubs || []).join(', r/') })
        : T('Автопроверка: не запущена — обновите страницу'));
    }
    const hits = autoHits(k);
    const lines = [autoLine(hits), konsLine(k)].filter(Boolean);
    // Оценки в «своих» сабах — всегда, чтобы было видно, почему нет «👎 минусуют тут».
    const home = settings.autoSubs || [];
    if (settings.homeDownOn !== false && home.length && !hits.some((x) => x.homeDown)) {
      const hv = homeVotes(h.votes, home);
      lines.push(T('👎 tj: +{u} / −{d}', { u: hv.up, d: hv.down }));
    }
    if (!lines.length) {
      lines.push(!h.acc ? (h.src === 'arch' ? T('Автопроверка: ни reddit, ни архив не дали данных об аккаунте (удалён, забанен или ни разу не писал?)') : T('Автопроверка: reddit не отдал профиль (скрыт, удалён или забанен?)'))
        : !settings.konsOn ? T('Автопроверка: ничего не сработало')
        : T('Автопроверка: ничего не сработало; аккаунту {y}', { y: ageStr((Date.now() - h.acc.created) / 86400000) }));
    }
    // серверного вердикта нет, потому что сервер не ответил (а не потому, что вердикта нет) — так и пишем
    if ((shared.get(k) || {}).failed) lines.unshift(T('⚠ сервер не ответил — показана ваша проверка ({s})', { s: h.src === 'arch' ? T('архив') : 'reddit' }));
    if (staleBg) lines.unshift(T('⚠ Фоновая часть Хрюнебота старая ({v}): выключите и включите его на странице расширений', { v: staleBg }));
    return lines.flatMap((l) => String(l).split('\n')).map(esc).join('<br>');
  }
  // Строка для подсказки: почему у ника НЕТ «🥫 консервы» (чтобы было видно, какого признака не хватило).
  function konsLine(k) {
    const h = hist[k];
    if (!settings.konsOn || !h || h.v !== 7 || !h.acc) return '';
    if (srvVerdict(k)) return ''; // «почему не консерва» по своей проверке не показываем, когда главный — серверный вердикт
    const age = (Date.now() - h.acc.created) / 86400000;
    if (konservaVerdict(age, h.rec, h.arch, sleepOf(h), farmOf(h), homeVotes(h.votes, settings.autoSubs || []).hit)) return '';
    const r = recView(h), o = (h.arch && h.arch.old) || {};
    const why = konservaWhyNot(age, h.rec, h.arch, h.prev);
    // Коротко: возраст · паузы · кириллица · (ферма, если хоть 1 признак) · причина. Без дат.
    const pspan = probeSpanOf(h), slp = Math.round(sleepOf(h));
    const parts = [T('аккаунт {y}', { y: ageStr(age) })];
    parts.push(slp >= 90 ? T('молчал {s} дн.', { s: slp }) : pspan ? T('долгих пауз нет') : T('пауза до {s} дн.', { s: slp }));
    parts.push(T('кириллицей {c}%', { c: pc(r.cyr || 0, (r.cyr || 0) + (r.lat || 0)) }));
    const fm = farmOf(h), fn = (fm.burst ? 1 : 0) + (fm.img ? 1 : 0) + (fm.ratio ? 1 : 0);
    if (fn) parts.push(T('ферма {n} из 3', { n: fn }));
    // «bad user» отвечает только старый фон (до 1.3.13): браузер не перезапустил фоновую часть расширения.
    if (why === 'noarch' && h.arch && h.arch.err === 'bad user') parts.push(T('фоновая часть устарела: выключите и включите Хрюнебот'));
    else parts.push({
      young: T('моложе полугода'), wascyr: T('раньше тоже кириллицей'), norec: T('кириллицей не пишет'),
      noarch: T('архив не ответил, повторю через 10 минут'), fewold: T('мало истории в архиве'),
      mixed: T('раньше по-английски {l}%', { l: pc(o.lat, o.cyr + o.lat) }),
    }[why] || '');
    return '🥫 ' + T('не консерва') + ': ' + parts.filter(Boolean).join(' · ');
  }

  // Признаки фермы кармы — коротко, для окна ника.
  function farmText(h) {
    const a = h.arch && !h.arch.err && h.arch.farm, r = h.farm;
    const f = (a && (!r || a.posts >= r.posts) ? a : r) || { posts: 0, burst: 0, imgShort: 0 };
    // Кармы нет (архив без профиля) — «?», а не 0/0.
    const known = h.acc && (h.acc.lk || h.acc.ck);
    const lk = known ? h.acc.lk || 0 : '?', ck = known ? h.acc.ck || 0 : '?';
    return T('{b} сабов/сутки, коротких картинок {p}%, карма {lk}/{ck}', { b: f.burst, p: pc(f.imgShort, f.posts), lk, ck });
  }
  // Подпись для метки с сервера: кто проверил, когда и главные цифры.
  // hs — все метки этого ника с сервера: одна строка с цифрами на все.
  function srvText(hs) {
    const h = hs[0];
    const ev = h.srv.ev || {};
    const d = new Date(h.srv.checked || Date.now()).toLocaleDateString(LOCALE());
    const ruleName = (x) => (x.tag === 'клоун' ? T('клоун') : x.tag === 'слежу' ? T('слежу') : T('орк'));
    // У спорщика — значок источника: где именно его минусуют (👹 орочьи, 🤡 клоунские, 👀 «слежу»).
    const name = hs.map((x) => (x.kons ? '🥫 ' + T('консерва') + (x.kons === 'weak' ? '?' : '') : x.homeDown ? '👎 ' + T('минусуют тут') : x.verdict === 'debater' ? '🥊 ' + T('спорщик') + ' ' + x.icon : x.icon + ' ' + ruleName(x) + (x.verdict === 'unclear' ? '?' : ''))).join(', ');
    const f = ev.farm || {};
    // Цифры по каждому сработавшему правилу сабов — именно его источника.
    // по каждому правилу — в каких сабах (1.3.90: «r/expectedrussians 12, r/vataru 2»), только числа
    const subsOf = (x) => x.bySub && typeof x.bySub === 'object' ? Object.entries(x.bySub).filter(([, n]) => +n > 0).map(([s, n]) => `r/${String(s).replace(/[^\w]/g, '')} ${+n}`).join(', ') + ': ' : '';
    const rules = hs.filter((x) => x.kind).map((x) => `${x.icon} ` + subsOf(x) + (x.posts != null ? T('{p} пост. + {c} комм.', { p: x.posts, c: x.comments }) : x.n) + ` (+${x.up || 0}/−${x.down || 0})`);
    // из памяти браузера, а сервер сейчас не ответил — так и пишем, не выдаём за свежее
    const stale = h.srv.stale ? T('⚠ из памяти браузера: сервер сейчас не ответил') + '\n' : '';
    // кто проверял: ручной вердикт владельца (ev.by = 'manual') или скрипт; без поля — скрипт (все старые — автоматические)
    const who = ev.by === 'manual' ? T('проверено владельцем') : T('автопроверка Хрюнебота');
    return stale + T('{n} — {w} {d}: аккаунту {a} дн., самый долгий перерыв {s} дн., ферма: до {b} сабов за сутки, коротких картинок {p}%; в r/tjournal_refugees минусов {m} из {t}',
      { n: name, w: who, d, a: ev.age ?? '?', s: ev.sleep ?? '?', b: f.burst ?? 0, p: pc(f.imgShort || 0, f.posts || 0), m: (ev.home || {}).down ?? 0, t: ((ev.home || {}).up || 0) + ((ev.home || {}).down || 0) }) +
      (rules.length ? T('; по сабам правил: {r}', { r: rules.join(', ') }) : '');
  }
  const autoLine = (hits) => {
    const tr = hits.find((h) => h.trust);
    const trustLine = !tr ? '' : tr.trust.way === 'new'
      ? T('свой: в r/tjournal_refugees заплюсовано {u} из {t} комментов (видна не вся история) — слабые подозрения скрыты, уверенные метки в полную силу', { u: tr.trust.cUp, t: tr.trust.cUp + tr.trust.cDown })
      : T('свой: в r/tjournal_refugees заплюсовано {u} из {t} — слабые подозрения скрыты, автобаллы пополам', { u: tr.trust.up, t: tr.trust.up + tr.trust.down });
    const hid = tr && tr.hidden && tr.hidden.length
      ? T('скрыто, потому что свой: {h}', { h: tr.hidden.map((x) => x.kons ? (x.kons === 'weak' ? '🥫?' : '🥫') : `${x.icon || '🔍'}${x.verdict === 'unclear' ? '?' : ''}×${x.n}`).join(' · ') }) : '';
    const rest = hits.filter((h) => !h.trust);
    const srv = rest.filter((h) => h.srv);
    const main = srv.length ? srvText(srv) : autoLineLocal(rest);
    return [trustLine, hid, main].filter(Boolean).join('\n');
  };
  // Коротко, по строке на метку (в окне — переносы, в подсказке — тоже). Без дат.
  // «r/саб, r/саб: 2 пости + 4 коменти (+5/−0)» — оценки уже с весом поста
  const ruleWhere = (h) => h.where.map(([s]) => `r/${s}`).join(', ') + ': ' +
    (h.posts != null ? T('{p} пост. + {c} комм.', { p: h.posts, c: h.comments }) : h.where.map(([, n]) => n).reduce((a, b) => a + b, 0)) +
    ` (+${h.up || 0}/−${h.down || 0})`;
  const autoLineLocal = (hits) => hits.map((h) => h.acc
      ? T('❗ новорег {d} дн. · карма {k}', { d: h.days, k: h.karma ?? '?' })
      : h.hiddenP ? T('🙈 профиль скрыт')
      : h.homeDown
        ? T('👎 минусуют: −{d} из {t}', { d: h.homeDown.down, t: h.homeDown.up + h.homeDown.down }) +
          (h.homeDown.contrast ? T(' · снаружи +{u} из {e}', { u: h.homeDown.eUp, e: h.homeDown.eUp + h.homeDown.eDown }) : '')
      : h.kons
        ? '🥫 ' + T('консерва') + (h.kons === 'weak' ? '?' : '') + ': ' + (
          h.sleep >= 180 ? T('молчал {s} дн.', { s: h.sleep })
          : h.farm && h.farm.hit ? T('ферма ({f})', { f: h.farmText }) + (h.kons === 'weak' ? T(' · кириллицей не пишет') : T(' · пишет кириллицей'))
          : T('раньше по-английски {l}%, NSFW {x}% → сейчас кириллицей {c}%', { l: pc(h.old.lat, h.old.cyr + h.old.lat), x: pc(h.old.nsfw, h.old.n), c: pc(h.rec.cyr, h.rec.cyr + h.rec.lat) }))
      : h.verdict === 'debater'
        ? '🥊 ' + T('спорщик') + ` ${h.icon || ''}: ` + ruleWhere(h)
        : `${h.verdict === 'unclear' ? '🤷' : h.icon} ${h.tag === 'слежу' ? T('слежу') : h.tag}${h.verdict === 'unclear' ? '?' : ''}: ` + ruleWhere(h)).join('\n');

  // ---------- нахрюкометр ----------
  // Формула — в score.js: главное число отдельных людей, повторы почти не добавляют,
  // плюс баллы автопроверки. Метки на шкалу не влияют.
  function botScore(k) {
    const mine = (users[k]?.complaints || []).length;
    const oc = outerComp(k);
    const hits = autoHits(k);
    // Мои жалобы уже входят в счёт группы/общего слоя — не считаем дважды.
    // Мои нахрюки уже входят в счёт группы/общего слоя, если он показан, — берём максимум, а не сумму.
    const people = Math.max(oc.p, mine ? 1 : 0);
    const complaints = Math.max(oc.n, mine);
    // автобаллы (со спорщиком — минус) не уходят ниже нуля; жалобы считаются отдельно и полностью
    const auto = Math.max(0, hits.reduce((a, h) => a + h.points, 0));
    const pts = botPoints(people, complaints, auto);
    // «звідки відсотки» (1.3.90): то же по отдельности — только автопроверка и только жалобы (шкала не складывается)
    const autoPct = botPercent(botPoints(0, 0, auto), settings.halfAt);
    const compPct = botPercent(botPoints(people, complaints, 0), settings.halfAt);
    return { pct: botPercent(pts, settings.halfAt), autoPct, compPct, mine, group: groupComp(k), pub: oc.pub, hits };
  }
  const meterColor = (p) => (p < 30 ? '#46a758' : p < 60 ? '#ffc53d' : p < 85 ? '#f76b15' : '#e5484d');
  function meterLine(s) {
    const parts = [T('Нахрюкометр: {p}%', { p: s.pct })];
    if (s.mine) parts.push(T('моих жалоб: {n}', { n: s.mine }));
    if (s.pub.n) parts.push(T('жалоб от всех пользователей: {n} от {p} чел.', { n: s.pub.n, p: s.pub.p }));
    if (s.group.n) parts.push(T('жалоб в группе: {n} от {p} чел.', { n: s.group.n, p: s.group.p }));
    const counted = s.hits.filter((h) => h.points > 0);
    if (counted.length) parts.push(T('сработала автопроверка: ') + counted.map((h) => (h.homeDown ? T('минусуют') : h.hiddenP ? T('профиль скрыт') : h.tag)).join(', '));
    // откуда проценты: если есть и автопроверка, и жалобы — сколько дало бы каждое само по себе
    if (s.autoPct && s.compPct) parts.push(T('по отдельности: автопроверка {a}%, жалобы {c}%', { a: s.autoPct, c: s.compPct }));
    return parts.join(' · ');
  }

  function queueRemoteSighting(k, sub, id) {
    if (!sub) return;
    remoteSightings.set(k + '|' + id, { user: k, sub, thing: id });
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(() => {
      const items = [...remoteSightings.values()];
      remoteSightings.clear();
      if (items.length) api('/sightings', { items });
    }, 3000);
  }
  const pending = new Map();
  let flushTimer = null;
  let scanTimer = null;
  let pop = null;

  const key = (n) => n.toLowerCase();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function textColor(hex) {
    const h = (hex || '#888888').replace('#', '');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111' : '#fff';
  }

  function alive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  // ---------- распознавание ников ----------

  function parseUser(a) {
    if (a.closest('.rt-wrap, .rt-pop')) return null;
    let url;
    try { url = new URL(a.getAttribute('href'), location.href); } catch { return null; }
    if (!/(^|\.)reddit\.com$/i.test(url.hostname)) return null;
    const m = url.pathname.match(/^\/(?:user|u)\/([A-Za-z0-9_-]{1,32})\/?$/);
    if (!m) return null;
    const name = m[1];
    // Только ссылки, где виден сам ник (не аватарки и не «посмотреть профиль»).
    const text = a.textContent.trim().replace(/^\/?u\//i, '');
    if (text.toLowerCase() !== name.toLowerCase()) return null;
    return name;
  }

  // Где находится ссылка: сабреддит, id поста/коммента и автор ли это.
  function getContext(a, name) {
    let sub = null, id = null, author = null, link = null;

    const old = a.closest('.thing[data-fullname]'); // old.reddit.com
    if (old) {
      id = old.dataset.fullname;
      sub = old.dataset.subreddit || null;
      author = old.dataset.author || null;
      link = old.dataset.permalink || null;
    }

    const sc = a.closest('shreddit-comment'); // новый reddit, комментарий
    if (sc) {
      id = id || sc.getAttribute('thingid');
      author = author || sc.getAttribute('author');
      link = link || sc.getAttribute('permalink');
      const m = (sc.getAttribute('permalink') || '').match(/\/r\/([^/]+)/);
      if (m) sub = sub || m[1];
    }

    const sp = a.closest('shreddit-post'); // новый reddit, пост
    if (sp) {
      if (!sc) {
        id = id || sp.getAttribute('id');
        author = author || sp.getAttribute('author');
        link = link || sp.getAttribute('permalink');
      }
      const s = sp.getAttribute('subreddit-prefixed-name') || sp.getAttribute('subreddit-name');
      if (s) sub = sub || s.replace(/^r\//i, '');
    }

    if (!sub) {
      const m = location.pathname.match(/^\/r\/([^/]+)/i);
      if (m) sub = m[1];
    }

    // Ссылка берётся из разметки страницы — пропускаем только настоящие https-ссылки на reddit.
    link = link ? safeRedditLink(link) : null;
    return {
      sub: sub ? sub.toLowerCase() : null,
      id,
      link,
      isAuthor: !!author && author.toLowerCase() === name.toLowerCase(),
    };
  }

  // ---------- рендер меток ----------

  function statsLine(u) {
    const subs = Object.entries(u.subs || {}).sort((a, b) => b[1] - a[1]);
    const total = subs.reduce((s, [, n]) => s + n, 0);
    if (!total) return T('Пока нигде не встречен');
    return T('Встречен {n} раз: ', { n: total }) + subs.slice(0, 5).map(([s, n]) => `r/${s} ${n}`).join(', ');
  }

  function sharedLine(k) {
    const s = shared.get(k) || {};
    const line = (lbl, o) => { const e = Object.entries(o || {}).sort((a, b) => b[1] - a[1]); return e.length ? lbl + e.map(([t, c]) => `${t} ×${c}`).join(', ') : ''; };
    return [line(T('Группа: '), s.tags), line(T('Все: '), s.ptags)].filter(Boolean).join('\n');
  }

  function render(wrap) {
    renderBadges(wrap);
    placeOnce(wrap);
  }
  // Значок «свій»: плашка-логотип TJ — в светлой теме белая с чёрным «TJ», в тёмной чёрная с белым; справа жёлтый
  // косой край (владелец, 09.11). Тема — по цвету текста вокруг: светлый текст = тёмная тема.
  // SVG рисуем прямо в разметке — CSP сайта не мешает. id обрезки уникальный на каждый значок.
  let tjSeq = 0;
  function darkAround(node) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(node).color || '');
    return !!m && (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) > 140;
  }
  function tjIcon(dark) {
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs, parent) => {
      const x = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) x.setAttribute(k, v);
      if (parent) parent.append(x);
      return x;
    };
    // фон плашки прозрачный — совпадает с фоном reddit в любой теме; цвет букв и рамки — под тему
    const bg = null, fg = dark ? '#fff' : '#111';
    const id = 'rt-tj-' + ++tjSeq;
    const svg = el('svg', { viewBox: '0 0 84 32', class: 'rt-tj' });
    el('rect', { x: 1, y: 1, width: 82, height: 30, rx: 15 }, el('clipPath', { id }, svg));
    const g = el('g', { 'clip-path': `url(#${id})` }, svg);
    if (bg) el('rect', { width: 84, height: 32, fill: bg }, g);
    el('path', { fill: '#f4c430', d: 'M64 32L82 0h4v32z' }, g);
    el('rect', { x: 1, y: 1, width: 82, height: 30, rx: 15, fill: 'none', stroke: fg, 'stroke-opacity': 0.6, 'stroke-width': 1.5 }, svg);
    const t = el('text', { x: 33, y: 24.5, 'text-anchor': 'middle', 'font-family': 'Arial Black, Arial, system-ui, sans-serif', 'font-weight': 900, 'font-size': 22, fill: fg }, svg);
    t.textContent = 'TJ';
    return svg;
  }
  function renderBadges(wrap) {
    const k = wrap.dataset.user;
    const u = users[k];
    const st = sharedTags(k);
    wrap.textContent = '';
    // Сервисный бот (AskGrok и т.п.) — без проверок и меток, только нейтральная плашка.
    if (isServiceBot(k)) {
      const b = document.createElement('span');
      b.className = 'rt-badge rt-auto';
      b.textContent = '🤖 ' + T('сервис-бот');
      b.title = T('Сервисный бот: пишет, когда его позовут. Не проверяем.');
      wrap.append(b);
      return;
    }
    const score = botScore(k);
    const tip = [u?.note, u ? statsLine(u) : '', sharedLine(k), autoLine(score.hits), konsLine(k), score.pct ? meterLine(score) : '', T('(клик — изменить)')].filter(Boolean).join('\n');
    // «свій» и нахрюкометр ниже 10% — не показываем (в подсказке и окне ника цифра остаётся)
    const trusted = score.hits.some((h) => h.trust);
    // Сколько меток будет у ника (без 🐽 и «свій») — от этого зависит, сворачивать ли длинные (настройка compact)
    const autoShown = score.hits.filter((h) => !h.trust && !u?.tags?.includes(h.tag));
    const sharedShown = Object.keys(st).filter((t) => !u?.tags?.includes(t));
    const compact = badgesCompact(settings.compact, autoShown.length + (u?.tags?.length || 0) + sharedShown.length);
    if (score.pct && !meterHidden(score.pct, trusted)) {
      const m = document.createElement('span');
      m.className = 'rt-badge rt-meter';
      m.textContent = `🐽 ${score.pct}%`;
      m.style.background = meterColor(score.pct);
      m.style.color = textColor(meterColor(score.pct));
      m.title = tip;
      wrap.append(m);
    }
    // Авто-метки (пунктир), если такой метки нет у меня вручную.
    for (const h of score.hits) {
      if (u?.tags?.includes(h.tag)) continue;
      // «свій» — тонкая зелёная полоска сразу справа от ника (1.3.90, владелец: «чтобы глаза не мозолила»);
      // старая текстовая плашка — настройкой trustStyle: 'text'. Полоса — первой, перед нахрюкометром.
      if (h.trust && settings.trustStyle !== 'text') {
        const bar = document.createElement('span');
        bar.className = 'rt-trust-bar';
        bar.title = T('свой');
        wrap.prepend(bar);
        continue;
      }
      const b = document.createElement('span');
      b.className = 'rt-badge rt-auto' + (h.verdict === 'debater' ? ' rt-debater' : '') + (h.trust ? ' rt-trust' : '');
      if (h.trust) {
        // «свій» — зелёная текстовая плашка (1.3.83). Плашка-логотип TJ (tjIcon) зарезервирована для ветеранов
        // оригинального TJournal — только ручная выдача модераторами (WISHLIST п.10), пока никому не показывается.
        b.textContent = T('свой');
      } else if (h.verdict === 'debater' && !h.acc) {
        // Спорщик: 🥊 перекрашенная в зелёный (цвет эмодзи в разных ОС разный, фильтр — одинаковый). Без счётчика — это не нахрюки.
        const g = document.createElement('span');
        g.className = 'rt-glove';
        g.textContent = '🥊';
        // значок — где спорит (👹 / 🤡 / 👀); свёрнуто — без слова «спорщик»
        b.append(g, compact ? (h.icon || '') : ' ' + T('спорщик') + (h.icon ? ' ' + h.icon : ''));
      } else if (compact) {
        // свёрнуто: значок и число, полный текст — в подсказке и окне ника
        b.classList.add('rt-short');
        b.textContent = h.acc ? `❗${h.days}${T('д')}`
          : h.kons ? `🥫${h.kons === 'weak' ? '?' : ''}`
          : h.homeDown ? `👎×${h.n}`
          : h.hiddenP ? '🙈'
          : h.verdict === 'unclear' ? `${h.icon || '🤷'}?×${h.n}`
          : `${h.icon || '🔍'}×${h.n}`;
      } else {
        b.textContent = h.acc ? h.tag
          : h.kons ? `🥫 ${T('консерва')}${h.kons === 'weak' ? '?' : ''}`
          : h.homeDown ? `👎 ${T('минусуют тут')} ×${h.n}`
          : h.hiddenP ? `🙈 ${T('профиль скрыт')}`
          : h.verdict === 'unclear' ? `🤷 ${h.tag === 'слежу' ? T('слежу') : h.tag}? ×${h.n}`
          : `${h.icon} ${h.tag === 'слежу' ? T('слежу') : h.tag} ×${h.n}`;
      }
      b.title = tip;
      wrap.append(b);
    }
    if (u && u.tags && u.tags.length) {
      for (const t of u.tags) {
        const b = document.createElement('span');
        b.className = 'rt-badge';
        b.textContent = st[t] ? `${t} ×${st[t]}` : t;
        b.style.background = u.color || PALETTE[0];
        b.style.color = textColor(u.color);
        b.title = tip;
        wrap.append(b);
      }
    }
    // Метки группы, которых нет у меня — контурные.
    for (const [t, c] of Object.entries(st).sort((a, b) => b[1] - a[1])) {
      if (u?.tags?.includes(t)) continue;
      const b = document.createElement('span');
      b.className = 'rt-badge rt-shared';
      b.textContent = `${t} ×${c}`;
      b.title = tip;
      wrap.append(b);
    }
    if (wrap.childElementCount) return;
    if (u && u.note) {
      const b = document.createElement('span');
      b.className = 'rt-add rt-noted';
      b.textContent = '📝';
      b.title = u.note + '\n' + statsLine(u);
      wrap.append(b);
    } else if (settings.showAdd) {
      const b = document.createElement('span');
      b.className = 'rt-add';
      b.textContent = '🏷';
      b.title = [T('Поставить метку'), autoLine(score.hits), konsLine(k)].filter(Boolean).join('\n');
      wrap.append(b);
    }
  }

  // Место значков проверяем один раз — когда в них впервые что-то появилось.
  function placeOnce(wrap) {
    if (wrap.rtLink && wrap.childElementCount && !wrap.dataset.placed) {
      wrap.dataset.placed = '1';
      placeInline(wrap.rtLink, wrap);
    }
  }

  function renderAll() {
    document.querySelectorAll('.rt-wrap').forEach(render);
  }

  function onWrapClick(e) {
    e.preventDefault();
    e.stopPropagation();
    openEditor(e.currentTarget);
  }

  // Ссылка на ник -> её значки. Значки не всегда стоят сразу за ссылкой (см. placeInline).
  const wrapOf = new WeakMap();

  // В шапке нового reddit ник лежит в обёртках (hovercard, колонки flex), и значки, вставленные прямо
  // за ссылкой, уезжают на строку ниже. Проверяем по факту: если значки не в одной строке с ником —
  // переносим их за обёртку уровнем выше (до 4 уровней), пока не встанут рядом. Не вышло — оставляем как было.
  function placeInline(a, wrap) {
    requestAnimationFrame(() => {
      if (!wrap.isConnected || !wrap.childElementCount) return;
      const sameLine = () => {
        const r = a.getBoundingClientRect(), w = wrap.getBoundingClientRect();
        if (!r.height || !w.height) return true; // не видно — не трогаем
        const mid = w.top + w.height / 2;
        return mid >= r.top - 2 && mid <= r.bottom + 2 && w.left >= r.left;
      };
      if (sameLine()) return;
      const home = { parent: wrap.parentNode, next: wrap.nextSibling };
      let el = a.parentElement;
      for (let i = 0; i < 4 && el && el !== document.body; i++, el = el.parentElement) {
        if (el.matches('shreddit-comment, shreddit-post, article, .thing')) break;
        el.after(wrap);
        if (sameLine()) return;
      }
      home.parent.insertBefore(wrap, home.next);
    });
  }

  function scan() {
    if (!ready || !alive()) return;
    const links = document.querySelectorAll('a[href*="/user/"], a[href*="/u/"]');
    for (const a of links) {
      const name = parseUser(a);
      if (!name) continue;
      const k = key(name);

      let wrap = wrapOf.get(a);
      if (!(wrap && wrap.isConnected && wrap.dataset.user === k)) {
        wrap = document.createElement('span');
        wrap.className = 'rt-wrap';
        wrap.dataset.user = k;
        wrap.dataset.name = name;
        const ctx0 = getContext(a, name);
        wrap.dataset.sub = ctx0.sub || '';
        // Жаловаться можно только на свой пост/коммент юзера, а не на упоминание.
        if (ctx0.isAuthor && ctx0.id) {
          wrap.dataset.thing = ctx0.id;
          wrap.dataset.link = ctx0.link || '';
        }
        wrap.addEventListener('click', onWrapClick, true);
        a.after(wrap);
        wrapOf.set(a, wrap);
        wrap.rtLink = a;
        render(wrap);
      }

      needLookup(k);
      // Историю проверяем, только когда ник на экране (лимит reddit не тратим на всю страницу).
      watchVisible(wrap); // свежий кэш needHist пропустит сам

      // Считаем «встречи» только для помеченных и только когда юзер — автор поста/коммента.
      if (users[k] && a.dataset.rtSeen !== k) {
        const ctx = getContext(a, name);
        if (ctx.id && ctx.isAuthor) {
          a.dataset.rtSeen = k;
          queueSighting(k, ctx.sub, ctx.id);
        }
      }
      // То же для общей статистики группы: если метка есть у меня или у группы.
      if (groupOn() && (users[k] || hasShared(k)) && a.dataset.rtSeenG !== k) {
        const ctx = getContext(a, name);
        if (ctx.id && ctx.isAuthor) {
          a.dataset.rtSeenG = k;
          queueRemoteSighting(k, ctx.sub, ctx.id);
        }
      }
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  }

  // ---------- хранилище ----------

  // Размер значков: класс на <html>, сами размеры — в content.css.
  function applySize() {
    document.documentElement.dataset.rtSize = ['s', 'm', 'l'].includes(settings.size) ? settings.size : 'm';
  }

  // Проверка: не лежит ли в папке расширения новая версия (фон сам перезагрузится, см. background.js)
  try { chrome.runtime.sendMessage({ type: 'ver' }, () => void chrome.runtime.lastError); } catch { /* фон недоступен */ }

  async function loadAll() {
    const d = await chrome.storage.local.get([K_USERS, K_SET, K_GROUP, K_HIST, K_SRV, K_REVIEW]);
    srvCache = d[K_SRV] || {};
    reviews = d[K_REVIEW] || {};
    users = d[K_USERS] || {};
    settings = { ...DEFAULT_SET, ...(d[K_SET] || {}) };
    setLang(settings.lang); settings.autoRules = migrateRules(settings.autoRules); migratePresets(settings);
    group = d[K_GROUP] || {};
    hist = d[K_HIST] || {};
  }

  function queueSighting(k, sub, id) {
    pending.set(k + '|' + id, { k, sub, id });
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 1500);
  }

  async function flush() {
    if (!alive()) return;
    const items = [...pending.values()];
    pending.clear();
    const data = (await chrome.storage.local.get(K_USERS))[K_USERS] || {};
    let changed = false;
    for (const { k, sub, id } of items) {
      const u = data[k];
      if (!u) continue;
      u.seen = u.seen || [];
      if (u.seen.includes(id)) continue;
      u.seen.push(id);
      if (u.seen.length > SEEN_CAP) u.seen.splice(0, u.seen.length - SEEN_CAP);
      const s = sub || '?';
      u.subs = u.subs || {};
      u.subs[s] = (u.subs[s] || 0) + 1;
      u.lastSeen = Date.now();
      u.lastSub = s;
      changed = true;
    }
    if (changed) await chrome.storage.local.set({ [K_USERS]: data });
  }

  async function saveUser(k, name, patch, sub) {
    const data = (await chrome.storage.local.get(K_USERS))[K_USERS] || {};
    if (patch === null) {
      delete data[k];
    } else {
      const prev = data[k];
      data[k] = {
        name,
        tags: [],
        color: PALETTE[0],
        note: '',
        subs: {},
        seen: [],
        created: Date.now(),
        taggedIn: sub || null,
        ...prev,
        ...patch,
        updated: Date.now(),
      };
    }
    await chrome.storage.local.set({ [K_USERS]: data });

    // Отправляем свои метки в группу (пустой список = убрать мои голоса).
    const tags = patch ? patch.tags || [] : [];
    const sent = [];
    if (groupOn() && group.share !== false) sent.push(api('/vote', { items: [{ user: name, tags, sub }] }));
    // В общий слой — только базовые метки (сервер свои тоже отбросит).
    if (pubOn()) sent.push(api('/vote', { items: [{ user: name, tags: tags.filter((t) => DEFAULT_PRESETS.includes(t)), sub }] }, true));
    if (sent.length) {
      await Promise.all(sent);
      shared.delete(k);
      needLookup(k);
    }
  }

  // Жалоба на пост/коммент (или «ручная», если коммента нет). undo — отозвать.
  async function complain(k, name, c, undo) {
    const data = (await chrome.storage.local.get(K_USERS))[K_USERS] || {};
    const u = (data[k] ??= {
      name, tags: [], color: PALETTE[0], note: '', subs: {}, seen: [], created: Date.now(), taggedIn: c.sub || null,
    });
    u.complaints = u.complaints || [];
    if (undo) u.complaints = u.complaints.filter((x) => x.thing !== c.thing);
    else if (!u.complaints.some((x) => x.thing === c.thing)) {
      u.complaints.push({ thing: c.thing, sub: c.sub || null, link: c.link || null, reason: c.reason || null, t: Date.now() });
      if (u.complaints.length > 300) u.complaints.splice(0, u.complaints.length - 300);
    }
    u.updated = Date.now();
    if (!u.tags.length && !u.note && !u.complaints.length) delete data[k];
    await chrome.storage.local.set({ [K_USERS]: data });

    // Отправляем в общий слой (видят все пользователи) и в свою группу, если она есть.
    const payload = { user: name, thing: c.thing, sub: c.sub, reason: c.reason, link: c.link, undo: !!undo };
    await Promise.all([
      groupOn() ? api('/complain', payload) : null,
      pubOn() ? api('/complain', payload, true) : null,
    ]);
    if (groupOn() || pubOn()) {
      shared.delete(k);
      needLookup(k);
    }
  }

  // ---------- всплывающий редактор ----------

  // Ник попал на экран — ставим в очередь проверки истории.
  const seenObs = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      seenObs.unobserve(e.target);
      const w = e.target;
      needHist(w.dataset.user, w.dataset.name, w.dataset.sub);
    }
  }) : null;
  function watchVisible(wrap) {
    if (wrap.dataset.watch) return;
    wrap.dataset.watch = '1';
    if (seenObs) seenObs.observe(wrap);
    else needHist(wrap.dataset.user, wrap.dataset.name, wrap.dataset.sub);
  }

  // Кнопки ручной оценки вердикта для окна ника.
  function reviewHtml(k) {
    const cur = reviews[k] && reviews[k].mark;
    const btn = (m, label) => `<button class="rt-rv${cur === m ? ' rt-rv-on' : ''}" data-m="${m}">${label}</button>`;
    return `${T('Вердикт:')} ${btn('ok', T('✔ верно'))}${btn('bad', T('✖ ошибка'))}${btn('doubt', T('? сомнительно'))}`;
  }

  function closePop() {
    if (pop) pop.remove();
    pop = null;
  }

  function openEditor(wrap) {
    closePop();
    const k = wrap.dataset.user;
    const name = wrap.dataset.name;
    const sub = wrap.dataset.sub || null;
    const u = users[k];
    let tags = [...(u?.tags || [])];
    let color = safeColor(u?.color || PALETTE[0]);
    const thing = wrap.dataset.thing || '';
    const already = !!thing && (u?.complaints || []).some((x) => x.thing === thing);
    const score = botScore(k);

    pop = document.createElement('div');
    pop.className = 'rt-pop';
    pop.dataset.user = k;
    pop.dataset.sub = sub || '';
    bumpHist(k, name, sub);
    pop.innerHTML = `
      <div class="rt-pop-h">
        <b>u/${esc(name)}</b>
        <a class="rt-rosint" href="https://rosint.dev/?u=${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer" title="${T('История юзера в архиве rosint — откроется в новой вкладке')}">rosint ↗</a>
        <span class="rt-x" title="${T('Закрыть')}">×</span>
      </div>
      <div class="rt-cur"></div>
      <input class="rt-in" placeholder="${T('Поиск или своя метка + Enter')}" maxlength="40">
      <div class="rt-presets"></div>
      <div class="rt-colors">${PALETTE.map((c) => `<span class="rt-sw" data-c="${c}" style="background:${c}"></span>`).join('')}</div>
      <textarea class="rt-note" placeholder="${T('Заметка (за что, ссылка на коммент…)')}" rows="2">${esc(u?.note || '')}</textarea>
      <div class="rt-stats">${esc(u ? statsLine(u) : T('Новый юзер'))}${sharedLine(k) ? '<br>' + esc(sharedLine(k)) : ''}</div>
      <div class="rt-comp">
        <div class="rt-meterbar"><span style="width:${score.pct}%;background:${meterColor(score.pct)}"></span></div>
        <div class="rt-stats rt-meterline">${esc(score.pct ? meterLine(score) : T('Нахрюкометр: жалоб нет'))}</div>
        <div class="rt-stats rt-checkline">${checkHtml(k)}</div>
        ${autoHere(sub) ? `<a class="rt-recheck" href="#" onclick="return false">${T('🔄 проверить заново')}</a>` : ''}
        <div class="rt-review">${reviewHtml(k)}</div>
        <button class="rt-btn rt-complain ${already ? 'rt-undo' : ''}">${already ? T('↩ Отозвать жалобу') : thing ? T('⚠ Пожаловаться на этот коммент') : T('⚠ Пожаловаться')}</button>
      </div>
      <div class="rt-actions">
        ${u ? `<button class="rt-btn rt-del">${T('Удалить')}</button>` : '<span></span>'}
        <button class="rt-btn rt-save">${T('Сохранить')}</button>
      </div>`;

    const cur = pop.querySelector('.rt-cur');
    const presets = pop.querySelector('.rt-presets');
    const input = pop.querySelector('.rt-in');

    const draw = () => {
      cur.innerHTML = tags.length
        ? tags.map((t, i) => `<span class="rt-badge" style="background:${color};color:${textColor(color)}">${esc(t)} <i data-i="${i}">×</i></span>`).join('')
        : `<span class="rt-empty">${T('меток нет')}</span>`;
      const f = input.value.trim().toLowerCase();
      presets.innerHTML = settings.presets
        .filter((p) => !tags.includes(p) && (!f || p.toLowerCase().includes(f)))
        .map((p) => `<span class="rt-chip" data-p="${esc(p)}">+ ${esc(p)}</span>`)
        .join('');
      pop.querySelectorAll('.rt-sw').forEach((s) => s.classList.toggle('on', s.dataset.c === color));
    };

    const addTag = (t) => {
      t = t.trim();
      if (t && !tags.includes(t)) tags.push(t);
      input.value = '';
      draw();
    };
    input.addEventListener('input', draw);

    const doSave = async () => {
      if (input.value.trim()) addTag(input.value);
      const note = pop.querySelector('.rt-note').value.trim();
      if (!tags.length && !note && !(u?.complaints || []).length) {
        if (u) await saveUser(k, name, null);
      } else {
        await saveUser(k, name, { tags, color, note }, sub);
      }
      closePop();
    };

    pop.addEventListener('click', async (e) => {
      e.stopPropagation();
      const t = e.target;
      if (t.matches('.rt-x')) closePop();
      else if (t.matches('.rt-rv')) { // ручная оценка вердикта; повторный клик по той же — снять
        const m = t.dataset.m;
        if (reviews[k] && reviews[k].mark === m) delete reviews[k];
        else reviews[k] = { mark: m, t: Date.now(), name, tags: autoHits(k).map((x) => (x.verdict === 'debater' ? 'спорщик ' : '') + x.tag + (x.verdict === 'unclear' || x.kons === 'weak' ? '?' : '')) };
        chrome.storage.local.set({ [K_REVIEW]: reviews });
        pop.querySelector('.rt-review').innerHTML = reviewHtml(k);
      }
      else if (t.matches('.rt-recheck')) { // перепроверить сейчас, не глядя на кэш
        // заново спрашиваем сервер (только этот ник) и проверяем сами. Серверный вердикт при этом не прячем и не подменяем
        // (1.3.88): своя проверка покажется отдельной строкой «Ваша перевірка».
        shared.delete(k);
        needLookup(k);
        forced.add(k);
        bumpHist(k, name, sub, true);
        const el = pop.querySelector('.rt-checkline');
        if (el) el.innerHTML = checkHtml(k);
      }
      else if (t.matches('.rt-cur i')) { tags.splice(+t.dataset.i, 1); draw(); }
      else if (t.matches('.rt-chip')) addTag(t.dataset.p);
      else if (t.matches('.rt-sw')) { color = t.dataset.c; draw(); }
      else if (t.matches('.rt-save')) doSave();
      else if (t.matches('.rt-complain')) {
        t.disabled = true;
        const reason = input.value.trim() || tags[0] || '';
        await complain(k, name, {
          thing: thing || 'manual-' + Math.random().toString(36).slice(2, 12), // без времени — не выдаёт, когда жаловались
          sub,
          link: wrap.dataset.link || null,
          reason,
        }, already);
        closePop();
      }
      else if (t.matches('.rt-del')) {
        if (confirm(T('Удалить u/{n} из списка?', { n: name }))) { await saveUser(k, name, null); closePop(); }
      }
    });
    // Не даём reddit перехватывать клавиши, пока печатаем.
    pop.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') closePop();
      if (e.key === 'Enter' && e.target === input) { e.preventDefault(); addTag(input.value); input.value = ''; }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSave();
    });
    ['keyup', 'keypress', 'mousedown', 'pointerdown'].forEach((ev) => pop.addEventListener(ev, (e) => e.stopPropagation()));

    draw();
    document.body.append(pop);

    const r = wrap.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let top = r.bottom + 6;
    if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.top = top + 'px';
    pop.style.left = Math.min(Math.max(8, r.left), innerWidth - pw - 8) + 'px';
    // На телефоне (сенсорный экран) не ставим фокус в поле: иначе сразу выскакивает клавиатура и закрывает окно.
    if (!TOUCH) input.focus();
  }

  document.addEventListener('mousedown', (e) => {
    if (pop && !pop.contains(e.target)) closePop();
  }, true);
  addEventListener('scroll', () => { if (pop && !pop.contains(document.activeElement)) closePop(); }, { passive: true });

  // ---------- запуск ----------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[K_HIST]) {
      const nv = changes[K_HIST].newValue;
      if (!nv) hist = {}; // кэш очищен в настройках
      else for (const [k, v] of Object.entries(nv)) if (!hist[k] || hist[k].t < v.t) hist[k] = v;
      if (Object.keys(changes).length === 1) { if (!nv) renderAll(); return; }
    }
    if (changes[K_USERS]) users = changes[K_USERS].newValue || {};
    if (changes[K_REVIEW]) reviews = changes[K_REVIEW].newValue || {};
    if (changes[K_SET]) {
      settings = { ...DEFAULT_SET, ...(changes[K_SET].newValue || {}) };
      setLang(settings.lang); settings.autoRules = migrateRules(settings.autoRules); migratePresets(settings); applySize();
    }
    if (changes[K_GROUP]) {
      group = changes[K_GROUP].newValue || {};
      shared.clear();
      document.querySelectorAll('[data-rt-seen-g]').forEach((a) => delete a.dataset.rtSeenG);
    }
    renderAll();
    scan();
  });

  loadAll().then(() => {
    ready = true;
    scan();
    new MutationObserver((muts) => {
      // Игнорируем собственные вставки, чтобы не крутиться в цикле.
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && !n.closest?.('.rt-wrap, .rt-pop')) {
            scheduleScan();
            return;
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
})();
