// Хрюнебот: синхронизация своих данных между устройствами по ключу (WISHLIST п.15).
// Грузится в фоне (background.js → importScripts / firefox scripts) и в тестах (tools/sync-check.mjs).
//
// Ключ синхронизации — 32 случайных байта (не пароль от человека). Из него на устройстве выводятся (HKDF):
//   auth — секрет для сервера (сервер хранит только его хеш), enc — ключ AES-GCM, fid — ключ HMAC для имён полей.
// Сервер видит только непрозрачные id полей и шифротекст. Голоса общего слоя синхронизация не трогает — они идут
// отдельно, как и раньше; при изменении меток/жалоб с другого устройства это устройство лишь выравнивает СВОЙ голос
// (голос всё равно один на аккаунт).
//
// Поля (слияние по полям: заметка с телефона и цвет с компа живут обе):
//   u/<ник>/tags, u/<ник>/note, u/<ник>/color, u/<ник>/c/<id коммента> — значение [имя ника, данные]
//   r/<ник> — своя оценка вердикта ✔/✖/?;  s/<настройка> — настройки (кроме привязанных к устройству)
(function () {
  const G = typeof globalThis !== 'undefined' ? globalThis : self;
  const SKIP_SET = new Set(['helpQueue', 'pubOn', 'size', 'compact']); // согласие и вид — у каждого устройства свои
  const DEF_COLOR = '#e5484d';
  const DEL = 'x'; // «хеш» удалённого поля
  const te = new TextEncoder(), td = new TextDecoder();

  // ---------- ключ ----------
  // 52 символа base32 (Crockford: без I, L, O, U — не спутать) = 256 бит случайности + 4 бита дополнения
  const A32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function genKey() {
    const b = crypto.getRandomValues(new Uint8Array(32));
    let bits = '', s = '';
    for (const x of b) bits += x.toString(2).padStart(8, '0');
    for (let i = 0; i < bits.length; i += 5) s += A32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
    return 'HRYU-' + s.match(/.{1,4}/g).join('-');
  }
  function parseKey(str) {
    const s = String(str || '').toUpperCase().replace(/^\s*HRYU/, '').replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (s.length !== 52 || [...s].some((c) => A32.indexOf(c) < 0)) return null;
    let bits = '';
    for (const c of s) bits += A32.indexOf(c).toString(2).padStart(5, '0');
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    return out;
  }
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const b64 = (u8) => { let s = ''; for (const x of u8) s += String.fromCharCode(x); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function derive(keyStr) {
    const raw = parseKey(keyStr);
    if (!raw) throw new Error(typeof T === 'function' ? T('Неверный ключ синхронизации') : 'Неверный ключ синхронизации');
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
    const p = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('hryunebot-sync-v1'), info: te.encode(info) });
    const auth = hex(await crypto.subtle.deriveBits(p('auth'), base, 256));
    const enc = await crypto.subtle.deriveKey(p('enc'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const fidK = await crypto.subtle.deriveKey(p('fid'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    const fidCache = new Map();
    return {
      auth,
      async fid(name) {
        if (!fidCache.has(name)) fidCache.set(name, hex(await crypto.subtle.sign('HMAC', fidK, te.encode(name))).slice(0, 32));
        return fidCache.get(name);
      },
      // шифротекст привязан к id поля (AAD): сервер не может подменить одно поле другим
      async seal(f, obj) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(f) }, enc, te.encode(JSON.stringify(obj))));
        const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
        return b64(out);
      },
      async open(f, d) {
        const u = unb64(d);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12), additionalData: te.encode(f) }, enc, u.slice(12));
        return JSON.parse(td.decode(pt));
      },
    };
  }

  // короткий хеш значения (обнаружить свою несинхронизированную правку)
  function h(v) {
    const s = JSON.stringify(v === undefined ? null : v);
    let a = 0xdeadbeef, b = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
    b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
    return (b >>> 0).toString(36) + (a >>> 0).toString(36);
  }

  // ---------- состояние ↔ поля ----------
  // state: { users, settings, reviews } (как в chrome.storage.local: rt_users, rt_settings, rt_review)
  function fieldsOf(state) {
    const out = new Map();
    for (const [k, u] of Object.entries(state.users || {})) {
      if (!u || !u.name) continue;
      if (u.tags && u.tags.length) out.set(`u/${k}/tags`, [u.name, u.tags.slice()]);
      if (u.note) out.set(`u/${k}/note`, [u.name, String(u.note)]);
      if (u.color && u.color !== DEF_COLOR && (u.tags && u.tags.length || u.note)) out.set(`u/${k}/color`, [u.name, u.color]);
      for (const c of u.complaints || []) if (c && c.thing) out.set(`u/${k}/c/${c.thing}`, [u.name, { sub: c.sub || null, link: c.link || null, reason: c.reason || null, t: c.t || 0 }]);
    }
    for (const [k, r] of Object.entries(state.reviews || {})) if (r && r.mark) out.set(`r/${k}`, r);
    for (const [k, v] of Object.entries(state.settings || {})) if (!SKIP_SET.has(k) && v !== undefined) out.set(`s/${k}`, v);
    return out;
  }
  const blankUser = (name) => ({ name, tags: [], color: DEF_COLOR, note: '', subs: {}, seen: [], created: Date.now(), taggedIn: null });
  // применить одно поле (v === undefined — удалено). Возвращает, что поменялось для голосов: { nick, name, tags?, undo? }
  function applyField(state, name, v) {
    const m = name.match(/^u\/([^/]+)\/(tags|note|color|c)(?:\/(.+))?$/);
    if (m) {
      const [, k, kind, thing] = m;
      state.users ||= {};
      let u = state.users[k];
      if (v === undefined && !u) return null;
      const nick = v ? v[0] : u.name;
      u = state.users[k] ||= blankUser(nick);
      const fx = { nick: k, name: u.name };
      if (kind === 'tags') { const was = JSON.stringify(u.tags || []); u.tags = v ? (Array.isArray(v[1]) ? v[1].map(String).slice(0, 50) : []) : []; if (was !== JSON.stringify(u.tags)) fx.tags = u.tags.slice(); }
      else if (kind === 'note') u.note = v ? String(v[1]).slice(0, 2000) : '';
      else if (kind === 'color') u.color = v ? (typeof safeColor === 'function' ? safeColor(v[1]) : String(v[1])) : DEF_COLOR;
      else {
        u.complaints = (u.complaints || []).filter((c) => c.thing !== thing);
        if (v) {
          const c = v[1] || {};
          u.complaints.push({ thing, sub: c.sub || null, link: typeof safeRedditLink === 'function' ? safeRedditLink(c.link) : c.link || null, reason: c.reason || null, t: +c.t || 0 });
        } else fx.undo = thing;
      }
      u.updated = Date.now();
      if (!(u.tags && u.tags.length) && !u.note && !(u.complaints && u.complaints.length)) delete state.users[k];
      return fx.tags || fx.undo ? fx : null;
    }
    let r = name.match(/^r\/(.+)$/);
    if (r) { state.reviews ||= {}; if (v === undefined) delete state.reviews[r[1]]; else state.reviews[r[1]] = v; return null; }
    r = name.match(/^s\/(.+)$/);
    if (r && !SKIP_SET.has(r[1])) { state.settings ||= {}; if (v === undefined) delete state.settings[r[1]]; else state.settings[r[1]] = v; }
    return null;
  }

  // ---------- один проход: забрать → применить → отправить своё ----------
  // io: { st, keys, load(), save(state), api(path, body) → json (ошибка: e.status) }
  // st: { key, keyNo, since, f: { fid: { n: имя, v: версия, h: хеш | 'x' } } }
  async function syncOnce(io) {
    const { st, keys } = io;
    st.f ||= {};
    const effects = [], lost = [];
    let state = await io.load(), changed = false, pulled = 0, pushed = 0, conflicts = 0;
    // текст заметки, проигравший другой правке, НЕ пропадает молча: сохраняем локальный вариант (показ + «копировать»)
    const keepLocal = (n, cur, win, known) => {
      const m = /^u\/([^/]+)\/note$/.exec(n);
      if (!m || !cur || !cur[1]) return;
      const dirty = !known || known.h === DEL || h(cur) !== known.h; // локальная правка не была синхронизирована
      if (dirty) lost.push({ nick: m[1], name: cur[0], local: String(cur[1]), server: win ? String(win[1]) : '', t: Date.now() });
    };
    const take = async (f, ver, d) => { // значение сервера побеждает (оно пришло на сервер первым)
      const known = st.f[f];
      if (known && known.v >= ver) return; // эту версию уже знаем (в т.ч. свою же правку) — своя несинхронизированная правка остаётся
      if (d == null) {
        if (known && known.h !== DEL) {
          keepLocal(known.n, fieldsOf(state).get(known.n), undefined, known);
          const fx = applyField(state, known.n, undefined); if (fx) effects.push(fx); changed = true;
        }
        st.f[f] = { n: known ? known.n : '', v: ver, h: DEL };
        return;
      }
      let o;
      try { o = await keys.open(f, d); } catch { return; } // не расшифровалось — чужое/битое, пропускаем
      if (!o || typeof o.n !== 'string') return;
      const hv = h(o.v);
      const cur = fieldsOf(state).get(o.n);
      if (h(cur) !== hv) {
        keepLocal(o.n, cur, o.v, known);
        const fx = applyField(state, o.n, o.v); if (fx) effects.push(fx); changed = true;
      }
      st.f[f] = { n: o.n, v: ver, h: hv };
      pulled++;
    };
    for (let round = 0; round < 3; round++) {
      // 1) забрать изменения
      const r = await io.api('/sync/pull', { since: st.since || 0 });
      if (r.snapshot) { // давно не синхронизировались: сервер — источник правды; удалённое там удаляем и здесь
        const live = new Set(r.fields.map((x) => x.f));
        for (const [f, k] of Object.entries(st.f)) {
          if (live.has(f)) continue;
          if (k.h !== DEL && k.n) { const fx = applyField(state, k.n, undefined); if (fx) effects.push(fx); changed = true; }
          delete st.f[f];
        }
      }
      for (const x of r.fields) await take(x.f, x.v, x.d);
      st.since = Math.max(r.snapshot ? 0 : st.since || 0, r.ver || 0);
      // 2) отправить свои правки (поля, чей хеш отличается от последнего синхронизированного)
      const cur = fieldsOf(state), items = [], names = new Map();
      for (const [n, v] of cur) {
        const f = await keys.fid(n), k = st.f[f], hv = h(v);
        if (k && k.h === hv) continue;
        names.set(f, [n, hv]);
        items.push({ f, base: k ? k.v : 0, d: await keys.seal(f, { n, v }) });
      }
      for (const [f, k] of Object.entries(st.f)) {
        if (k.h === DEL || !k.n || cur.has(k.n)) continue;
        names.set(f, [k.n, DEL]);
        items.push({ f, base: k.v, d: null });
      }
      if (!items.length) break;
      let again = false;
      for (let i = 0; i < items.length; i += 400) {
        let p;
        try { p = await io.api('/sync/push', { since: st.since, items: items.slice(i, i + 400) }); }
        catch (e) { if (e.status === 409) { st.since = 1; again = true; break; } throw e; } // нужен полный снимок
        for (const a of p.applied) { const [n, hv] = names.get(a.f); st.f[a.f] = { n, v: a.v, h: hv }; pushed++; }
        for (const c of p.conflicts) { conflicts++; again = true; if (c.v) await take(c.f, c.v, c.d); else if (st.f[c.f]) st.f[c.f].v = 0; }
      }
      if (!again) break;
    }
    if (changed) await io.save(state, effects);
    if (lost.length && io.lost) await io.lost(lost);
    return { pulled, pushed, conflicts, changed, effects, lost };
  }

  // смена ключа: начать → перешифровать всё под новым ключом → переключить одной пачкой. st.rot хранит op и новый ключ
  // ДО начала: сбой посередине → повтор с тем же op доводит до конца (старый ключ действует до commit).
  async function rotate(io, newKeys) {
    const { st } = io;
    const op = st.rot.op;
    const b = await io.api('/sync/rotate/begin', { op, auth: newKeys.auth });
    if (!b.done) {
      const state = await io.load(), cur = fieldsOf(state), items = [];
      for (const [n, v] of cur) { const f = await newKeys.fid(n); items.push({ f, d: await newKeys.seal(f, { n, v }) }); }
      for (const k of Object.values(st.f || {})) if (k.h === DEL && k.n && !cur.has(k.n)) items.push({ f: await newKeys.fid(k.n), d: null }); // удалённое остаётся удалённым
      for (let i = 0; i < items.length; i += 400) await io.api('/sync/rotate/put', { op, items: items.slice(i, i + 400) });
    }
    const c = await io.api('/sync/rotate/commit', { op });
    return c.keyNo;
  }

  // ---------- работа в фоне расширения: background.js вызывает HryuSync.start({ pubApi, api }) ----------
  function start({ syncApi, api }) {
    const K = 'rt_sync';
    let busy = null, timer = null, ignoreUntil = 0;
    const getSt = async () => (await chrome.storage.local.get(K))[K] || null;
    const putSt = (st) => chrome.storage.local.set({ [K]: st });
    const call = (path, body) => syncApi({ path, body });
    const io = (st, keys) => ({
      st, keys, api: call,
      async load() {
        const d = await chrome.storage.local.get(['rt_users', 'rt_settings', 'rt_review']);
        return { users: d.rt_users || {}, settings: d.rt_settings || {}, reviews: d.rt_review || {} };
      },
      async lost(items) { // проигравшие заметки — храним до 50, пока человек не скопирует/не уберёт
        const { rt_sync_lost: l = [] } = await chrome.storage.local.get('rt_sync_lost');
        await chrome.storage.local.set({ rt_sync_lost: [...items, ...l].slice(0, 50) });
      },
      async save(state, effects) {
        ignoreUntil = Date.now() + 3000; // свою запись не принимаем за правку пользователя
        await chrome.storage.local.set({ rt_users: state.users, rt_settings: state.settings, rt_review: state.reviews });
        // общий слой выравнивать не нужно: сервер считает голос ЛИЧНОСТИ (правка с телефона сразу заменила голоса всех
        // её устройств). Своя группа — отдельный токен, его выравниваем сами.
        const { rt_group: g = {} } = await chrome.storage.local.get('rt_group');
        if (g.token && g.server && g.share !== false) for (const fx of effects) {
          try {
            if (fx.tags) await api({ path: '/vote', body: { items: [{ user: fx.name, tags: fx.tags, sub: null }] } });
            if (fx.undo) await api({ path: '/complain', body: { user: fx.name, thing: fx.undo, undo: true } });
          } catch { /* сеть — выровняется при следующей правке */ }
        }
      },
    });
    async function run() {
      const st = await getSt();
      if (!st || !st.key) return { on: false };
      try {
        if (st.rot) { // недоделанная смена ключа — доводим
          const nk = await derive(st.rot.key);
          const keyNo = await rotate(io(st, await derive(st.key)), nk);
          Object.assign(st, { key: st.rot.key, keyNo, since: 0, f: {} }); delete st.rot;
          await putSt(st);
        }
        const r = await syncOnce(io(st, await derive(st.key)));
        st.last = Date.now(); st.err = null; st.broken = false;
        await putSt(st);
        return { on: true, ...r };
      } catch (e) {
        st.err = e.message || String(e); st.errAt = Date.now();
        if (e.status === 403 || e.status === 404) st.broken = true; // ключ сменили на другом устройстве / устройство отключено
        await putSt(st);
        throw e;
      }
    }
    const syncNow = () => (busy ??= run().finally(() => { busy = null; }));
    const later = (ms = 5000) => { clearTimeout(timer); timer = setTimeout(() => syncNow().catch(() => {}), ms); };

    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || Date.now() < ignoreUntil) return;
      if (ch.rt_users || ch.rt_settings || ch.rt_review) later();
    });
    if (chrome.alarms) {
      chrome.alarms.create('hryu-sync', { periodInMinutes: 10 });
      chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'hryu-sync') syncNow().catch(() => {}); });
    }
    later(3000);

    chrome.runtime.onMessage.addListener((msg, _s, send) => {
      if (msg?.type !== 'sync') return;
      (async () => {
        const st = await getSt();
        switch (msg.op) {
          case 'status': {
            const { rt_sync_lost: lost = [] } = await chrome.storage.local.get('rt_sync_lost');
            if (!st) return { on: false, lost };
            // сколько своих правок ещё не ушло на сервер (то же сравнение, что и при отправке)
            let dirty = 0;
            try {
              const keys = await derive(st.key), cur = fieldsOf(await io(st, keys).load());
              for (const [n, v] of cur) { const k = (st.f || {})[await keys.fid(n)]; if (!k || k.h !== h(v)) dirty++; }
              for (const k of Object.values(st.f || {})) if (k.h !== 'x' && k.n && !cur.has(k.n)) dirty++;
            } catch { /* ключ битый — покажем ошибку из st.err */ }
            return { on: true, keyNo: st.keyNo, last: st.last || 0, err: st.err || null, broken: !!st.broken, rotating: !!st.rot, lost, dirty };
          }
          case 'lostRestore': { // вернуть свой вариант проигравшей заметки — это новая правка, уйдёт на другие устройства
            const { rt_sync_lost: lost = [], rt_users: us = {} } = await chrome.storage.local.get(['rt_sync_lost', 'rt_users']);
            const x = lost[+msg.i];
            if (!x) return { ok: true };
            const u = us[x.nick] || { name: x.name, tags: [], color: DEF_COLOR, note: '', subs: {}, seen: [], created: Date.now(), taggedIn: null };
            u.note = x.local; u.updated = Date.now(); us[x.nick] = u;
            lost.splice(+msg.i, 1);
            await chrome.storage.local.set({ rt_users: us, rt_sync_lost: lost });
            later(1000);
            return { ok: true };
          }
          case 'lostDrop': {
            const { rt_sync_lost: lost = [] } = await chrome.storage.local.get('rt_sync_lost');
            lost.splice(+msg.i, 1);
            await chrome.storage.local.set({ rt_sync_lost: lost });
            return { ok: true };
          }
          case 'create': {
            const key = genKey(), keys = await derive(key);
            const r = await call('/sync/create', { auth: keys.auth });
            await putSt({ key, keyNo: r.keyNo, since: 0, f: {} });
            await syncNow().catch(() => {});
            return { key }; // показываем ОДИН раз
          }
          case 'attach': {
            const key = String(msg.key || '').trim(), keys = await derive(key);
            const r = await call('/sync/attach', { auth: keys.auth });
            await putSt({ key, keyNo: r.keyNo, since: 0, f: {} });
            return syncNow();
          }
          case 'now': return syncNow();
          case 'devices': return call('/sync/devices', {});
          case 'rotate': {
            if (!st) throw new Error(T('Синхронизация не настроена'));
            const key = genKey();
            st.rot = { op: crypto.randomUUID().replace(/-/g, ''), key };
            await putSt(st); // сначала запомнить: сбой посередине — довершим при следующем запуске
            await syncNow();
            return { key };
          }
          case 'leave': {
            try { await call('/sync/leave', {}); } catch { /* устройство уже отключено */ }
            await chrome.storage.local.remove(K);
            return { ok: true };
          }
          default: throw new Error('?');
        }
      })().then((data) => send({ ok: true, data }), (e) => send({ ok: false, error: e.message || String(e) }));
      return true;
    });
  }

  G.HryuSync = { genKey, parseKey, derive, fieldsOf, applyField, syncOnce, rotate, h, SKIP_SET, start };

})();
