// Хрюнебот: автоочередь (1.3.91, владелец + ГПТ 11.11). Сервер сам берёт ники из очереди, проверяет через архив
// ArcticShift ТЕМ ЖЕ кодом, что расширение и check-tj (check.gen.js), и:
//   режим 'test'    — пишет результат в autoqueue_test (наружу НЕ публикуется; для сравнения с check-tj).
//                     Очередь (status/tries/err) в тесте НЕ меняет — только временная бронь (lease): ручной check-tj
//                     видит очередь как раньше. Ошибки и попытки теста — в самой autoqueue_test (err, tries);
//   режим 'publish' — публикует вердикт в verdicts (только НОВЫМ никам; старые вердикты не трогает).
//   режим 'off'     — ничего не делает (по умолчанию).
// Режим — переменная AUTOQUEUE в wrangler.toml; включать 'publish' — только по решению владельца после тестов.
// Метки ставит только наша проверка через архив; присланное расширениями (pre_tags) не используется.
// Неполный ответ архива (любой запрос не ответил) — НЕ вердикт: ошибка, ник вернётся в очередь позже.
// Скорость (13.11): узкое место — архив (5–14 запросов и 15–120 с на ник), а не запись в D1 (миллисекунды).
// Поэтому: кэш успешных ответов архива (archive_cache, 6 ч) — при частичной ошибке повторяется только упавший запрос;
// новые ники раньше отложенных; повторы с растущей задержкой (1, 2, 4, 8 ч) и пределом попыток; замеры каждого запуска
// (autoqueue_runs): сетевое время, ожидание лимита архива, повторы, попадания в кэш, «прочее» (паузы кода + расчёт).
// Лимит 50 внешних запросов за запуск — ограничение Cloudflare Free (среда); budget 45 — наш запас под ним.
import { archFull, archVerdict, isServiceBot, setArchGate, setArchFetch, archOk, trustOf } from './check.gen.js';
import { checkOnePending } from './trust.js';

const DAY = 86400000;
export const AUTO = {
  lease: 10 * 60 * 1000, // бронь ника на время проверки: два запуска не возьмут один ник; упал — бронь истечёт
  maxTries: 5, // столько раз пробуем ник при ошибках архива, потом он ждёт владельца (--queue-errors)
  retryAfter: 60 * 60 * 1000, // повтор после ошибки: через 1 ч, потом 2, 4, 8 ч (удваивается с каждой попыткой)
  gapMs: 1000, // общий темп: не чаще 1 запроса к архиву в секунду на ВСЕ запуски (AUTOQUEUE_GAP_MS)
  cacheTtl: 6 * 60 * 60 * 1000, // успешный ответ архива переиспользуем 6 часов (повтор ника берёт из кэша то, что уже пришло)
  budget: 45, // запросов к архиву за запуск (лимит Cloudflare Free — 50 на запуск)
  ttl: 30 * DAY,
};
const HOME = ['tjournal_refugees'];
const USER_RE = /^[A-Za-z0-9_-]{1,32}$/;

// В кэш (и повторно в дело) — только ПРОВЕРЕННЫЙ на полноту ответ: HTTP 200 (проверяет вызывающий), JSON, список data,
// без поля error, каждая запись — объект с датой или автором. Облегчённый ответ (limit=50 — код просит меньше, когда
// архив тормозит) в текущую проверку идёт, но НЕ кэшируется: при повторе ник снова попробует полный (ГПТ, 13.11).
export function cacheable(url, text) {
  if (/[?&]limit=50(&|$)/.test(String(url))) return false;
  let j;
  try { j = JSON.parse(text); } catch { return false; }
  return archOk(String(url), true, j); // та же проверка полноты по типу запроса, что и для вердикта
}

export function autoMode(env) {
  const m = String((env && env.AUTOQUEUE) || 'off');
  return m === 'test' || m === 'publish' ? m : 'off';
}

// Следующий ник: новый (или с ошибкой, но не чаще раза в час и не больше maxTries), не забронированный,
// без живого вердикта; в тестовом режиме — ещё не проверенный в тесте. Сначала те, кого прислало больше людей.
async function pick(db, mode, now) {
  if (mode === 'test') {
    // тест: статус очереди не трогаем — берём new/error как есть; свои ошибки и попытки — в autoqueue_test
    return db.prepare(`SELECT q.user, q.name FROM queue q
        WHERE q.status IN ('new', 'error') AND COALESCE(q.lease, 0) < ?
          AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.user = q.user AND v.expires > ?)
          AND NOT EXISTS (SELECT 1 FROM autoqueue_test t WHERE t.user = q.user
                AND (t.err IS NULL OR COALESCE(t.tries, 0) >= ? OR t.t + ? * (1 << (MAX(COALESCE(t.tries, 1), 1) - 1)) > ?))
        ORDER BY CASE WHEN EXISTS (SELECT 1 FROM autoqueue_test t2 WHERE t2.user = q.user) THEN 1 ELSE 0 END, q.reports DESC, q.first
        LIMIT 1`).bind(now, now, AUTO.maxTries, AUTO.retryAfter, now).first();
  }
  return db.prepare(`SELECT q.user, q.name FROM queue q
      WHERE (q.status = 'new' OR (q.status = 'error' AND COALESCE(q.tries, 0) < ?
              AND COALESCE(q.checked, 0) + ? * (1 << (MAX(COALESCE(q.tries, 1), 1) - 1)) < ?))
        AND COALESCE(q.lease, 0) < ?
        AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.user = q.user AND v.expires > ?)
      ORDER BY CASE WHEN q.status = 'error' THEN 1 ELSE 0 END, q.reports DESC, q.first
      LIMIT 1`).bind(AUTO.maxTries, AUTO.retryAfter, now, now, now).first();
}
// Тест: записать итог (или ошибку) в autoqueue_test и снять бронь — очередь не трогаем
async function testRecord(db, user, name, now, v, err) {
  const prev = err ? await db.prepare('SELECT tries FROM autoqueue_test WHERE user = ?').bind(user).first() : null;
  await db.batch([
    db.prepare('INSERT OR REPLACE INTO autoqueue_test (user, name, tags, evidence, raw, t, err, tries) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(user, name, JSON.stringify(v ? v.tags : []), v ? JSON.stringify(v.ev) : null, v ? JSON.stringify(v.raw || {}) : null, now,
        err || null, err ? ((prev && prev.tries) || 0) + 1 : 0),
    db.prepare('UPDATE queue SET lease = 0 WHERE user = ?').bind(user),
  ]);
}

// Тест + AUTOQUEUE_RECHECK=1 (владелец, 11.11): когда очередь пуста — перепроверка СТАРЫХ вердиктов (от самых давних) в
// autoqueue_test, без публикации: большое сравнение «сервер сейчас ↔ что лежит на сервере» и задел для продления (п.8).
// Один проход по каждому нику. Бронь — заготовка строки в autoqueue_test (INSERT OR IGNORE): второй запуск её не возьмёт.
async function pickRecheck(db, now) {
  return db.prepare(`SELECT v.user, v.name FROM verdicts v
      WHERE v.expires > ? AND NOT EXISTS (SELECT 1 FROM autoqueue_test t WHERE t.user = v.user)
      ORDER BY v.checked, v.user LIMIT 1`).bind(now).first();
}
async function claimRecheck(db, row, now) {
  const r = await db.prepare("INSERT OR IGNORE INTO autoqueue_test (user, name, tags, evidence, raw, t, err, tries) VALUES (?, ?, '[]', NULL, NULL, ?, 'проверяется', 0)")
    .bind(row.user, row.name, now).run();
  return !!(r && r.meta && r.meta.changes);
}

// Бронь одной операцией: если другой запуск успел раньше — changes = 0, ник не берём.
async function claim(db, user, now) {
  const r = await db.prepare('UPDATE queue SET lease = ? WHERE user = ? AND COALESCE(lease, 0) < ?').bind(now + AUTO.lease, user, now).run();
  return !!(r && r.meta && r.meta.changes);
}

// Один запуск: perRun ников. check — для тестов можно подменить (по умолчанию archFull + archVerdict).
export async function runAutoQueue(db, env, opts = {}) {
  const mode = autoMode(env);
  const now = opts.now || Date.now();
  const out = { mode, done: [] };
  if (mode === 'off') return out;
  const perRun = Math.min(Math.max(parseInt(env.AUTOQUEUE_PER_RUN, 10) || 1, 1), 3);
  const t0 = Date.now();
  // замеры запуска: сетевое время к архиву, ожидание его лимита, повторы, кэш
  const m = { requests: 0, cacheHits: 0, fetchMs: 0, limitWaitMs: 0, paceWaitMs: 0, sleepMs: 0, sleeps: 0, dbMs: 0, retries: 0, failed: 0 };
  // учёт пауз кода проверки (повторы archGet/archOne/профиля): на время запуска оборачиваем setTimeout
  const realSetTimeout = globalThis.setTimeout;
  let inGate = false;
  globalThis.setTimeout = (fn, ms, ...rest) => { if (!inGate && ms >= 100) { m.sleepMs += ms; m.sleeps++; } return realSetTimeout(fn, ms, ...rest); };
  const timed = async (p) => { const d0 = Date.now(); try { return await p; } finally { m.dbMs += Date.now() - d0; } };
  // «Шлагбаум» (общий ограничитель): после 429 архива ждём, сколько он скажет (не больше минуты). Срок хранится в D1
  // (archive_gate) — его видят ВСЕ запуски, в том числе пересекающиеся по времени, а не только этот.
  let blockedUntil = 0;
  // Общий ТЕМП (ГПТ, 13.11): каждый сетевой запрос к архиву бронирует «окно» next_at в D1 одной операцией — между любыми
  // двумя запросами ВСЕХ запусков (в т.ч. пересекающихся) не меньше gapMs. Так частота и параллельность заданы на все
  // запуски сразу, а не на каждый отдельно. Окно сдвигается и после 429 (blocked_until).
  const gapMs = Math.min(Math.max(parseInt(env.AUTOQUEUE_GAP_MS, 10) || AUTO.gapMs, 200), 10000);
  const reserve = async () => {
    try {
      await db.prepare('INSERT OR IGNORE INTO archive_gate (id, blocked_until, next_at) VALUES (1, 0, 0)').run();
      const g = await db.prepare(`UPDATE archive_gate SET next_at = MAX(COALESCE(next_at, 0), blocked_until, ?) + ?
          WHERE id = 1 RETURNING next_at`).bind(Date.now(), gapMs).first();
      return g ? g.next_at - gapMs : 0;
    } catch { return 0; } // база недоступна — не стоим, но и не спешим: локальный темп ниже
  };
  let localNext = 0;
  const sleepGate = async (ms, key) => {
    if (ms <= 0) return;
    m[key] += ms; inGate = true;
    try { await new Promise((ok) => setTimeout(ok, ms)); } finally { inGate = false; }
  };
  const gate = {
    // pace — бронь окна (темп всех запусков); limit — ожидание после 429 сверх темпа
    acquire: async () => {
      const slot = Math.max(await timed(reserve()), localNext);
      localNext = Math.max(slot, Date.now()) + gapMs;
      const wait = Math.min(slot - Date.now(), 60000);
      await sleepGate(wait, slot > Date.now() && blockedUntil >= slot ? 'limitWaitMs' : 'paceWaitMs');
    },
    release() {}, ok() {},
    soft() { m.retries++; },
    block(at) {
      m.retries++;
      blockedUntil = Math.max(blockedUntil, at > Date.now() ? at + 500 : Date.now() + 15000);
      return db.prepare('INSERT INTO archive_gate (id, blocked_until, next_at) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET blocked_until = MAX(blocked_until, excluded.blocked_until)')
        .bind(blockedUntil).run().catch(() => {});
    },
  };
  setArchGate(gate);
  // Запрос к архиву через кэш: успешный ответ (data — список) берём из D1, если ему < 6 ч; иначе — сеть. Бюджет считаем
  // только по сети (лимит Cloudflare — на внешние запросы). Неуспешные ответы не кэшируем.
  const realFetch = opts.fetch || ((u, o) => fetch(u, o));
  const cacheOn = String(env.AUTOQUEUE_CACHE) !== '0';
  setArchFetch(async (url, init) => {
    if (cacheOn) {
      const c = await timed(db.prepare('SELECT body FROM archive_cache WHERE url = ? AND t > ?').bind(url, Date.now() - AUTO.cacheTtl).first());
      if (c) { m.cacheHits++; return new Response(c.body, { status: 200, headers: { 'content-type': 'application/json' } }); }
    }
    if (++m.requests > AUTO.budget) throw new Error('budget');
    const f0 = Date.now();
    let r;
    try { r = await realFetch(url, init); } finally { m.fetchMs += Date.now() - f0; }
    const text = await r.text();
    if (!r.ok) m.failed++;
    if (cacheOn && r.ok && cacheable(url, text)) {
      await timed(db.prepare('INSERT OR REPLACE INTO archive_cache (url, body, t) VALUES (?, ?, ?)').bind(url, text, Date.now()).run());
    }
    return new Response(text, { status: r.status, headers: r.headers });
  });
  // граница «3 месяца назад» — с точностью до суток: адреса запросов совпадают между повторами (кэш попадает)
  const split = Math.floor(now / 1000 / 86400) * 86400 - 90 * 86400;
  const check = opts.check || (async (name) => archVerdict(await archFull(name, split), HOME, now));
  // Довірені (п.14): одна заявка на подтверждение за запуск — до ников очереди. Поиск коммента с кодом — БЕЗ кэша (нужен
  // свежий ответ), но через общий темп/шлагбаум и бюджет; неполный ответ архива (archOk) — заявка ждёт следующего раза.
  if (!opts.users && env.TRUST_SECRET && String(env.TRUST_ON) !== '0') {
    const fetchArchJson = async (url) => {
      await gate.acquire();
      if (++m.requests > AUTO.budget) return { ok: false };
      const f0 = Date.now();
      try {
        const r = await realFetch(url, { signal: AbortSignal.timeout(20000) });
        const j = await r.json().catch(() => null);
        if (r.status === 429) gate.block(+r.headers.get('x-ratelimit-reset-at') || 0);
        return archOk(url, r.ok, j) ? { ok: true, data: j.data } : { ok: false };
      } catch { return { ok: false }; } finally { m.fetchMs += Date.now() - f0; }
    };
    try { out.trust = await checkOnePending(db, env, { fetchArchJson, check: opts.trustCheck || check, trustOf, now }); }
    catch (e) { out.trust = { error: String((e && e.message) || e).slice(0, 80) }; }
  }
  // Ручной прогон заданных ников (владелец, для замеров): ВСЕГДА как тест — в autoqueue_test, без публикации
  if (Array.isArray(opts.users) && opts.users.length) {
    for (const raw of opts.users.slice(0, 3)) {
      const name = String(raw || '').replace(/^\/?u\//i, '');
      if (!USER_RE.test(name)) continue;
      const n0 = { req: m.requests, hits: m.cacheHits, t: Date.now(), fetch: m.fetchMs, wait: m.limitWaitMs, pace: m.paceWaitMs, sl: m.sleepMs, sn: m.sleeps, db: m.dbMs };
      try {
        const v = await check(name);
        if (!v || !Array.isArray(v.tags) || !v.tags.length || !v.ev) throw new Error('пустой результат');
        await testRecord(db, name.toLowerCase(), name, now, v, null);
        out.done.push({ user: name, tags: v.tags, manual: true });
      } catch (e) {
        await testRecord(db, name.toLowerCase(), name, now, null, String((e && e.message) || e).slice(0, 200));
        out.done.push({ user: name, error: String((e && e.message) || e).slice(0, 80), manual: true });
      }
      out.done[out.done.length - 1].metrics = { requests: m.requests - n0.req, cacheHits: m.cacheHits - n0.hits,
        wallMs: Date.now() - n0.t, fetchMs: m.fetchMs - n0.fetch, limitWaitMs: m.limitWaitMs - n0.wait,
        paceWaitMs: m.paceWaitMs - n0.pace, sleepMs: m.sleepMs - n0.sl, sleeps: m.sleeps - n0.sn, dbMs: m.dbMs - n0.db };
    }
  }
  let races = 0; // бронь перехватил другой запуск — пробуем следующий ник, но не бесконечно
  for (let i = 0; i < (opts.users ? 0 : perRun); i++) {
    let row = await pick(db, mode, now), recheck = false;
    if (!row && mode === 'test' && String(env.AUTOQUEUE_RECHECK) === '1') { row = await pickRecheck(db, now); recheck = !!row; }
    if (!row) break;
    if (!(await (recheck ? claimRecheck(db, row, now) : claim(db, row.user, now)))) { if (++races < 5) i--; continue; }
    const name = USER_RE.test(row.name) ? row.name : row.user;
    if (isServiceBot(name)) {
      if (mode === 'test') await testRecord(db, row.user, name, now, { tags: ['skip'], ev: {} }, null);
      else await db.prepare("UPDATE queue SET status = 'checked', checked = ?, err = ?, lease = 0 WHERE user = ?").bind(now, 'service bot', row.user).run();
      out.done.push({ user: name, skipped: 'service bot' });
      continue;
    }
    let v;
    try {
      v = await check(name);
      if (!v || !Array.isArray(v.tags) || !v.tags.length || !v.ev) throw new Error('пустой результат');
    } catch (e) {
      // архив не ответил / ответил не полностью — НЕ вердикт: ошибка, повтор позже
      if (mode === 'test') { await testRecord(db, row.user, name, now, null, String((e && e.message) || e).slice(0, 200)); out.done.push({ user: name, error: String((e && e.message) || e).slice(0, 80) }); continue; }
      await db.prepare("UPDATE queue SET status = 'error', tries = COALESCE(tries, 0) + 1, checked = ?, err = ?, lease = 0 WHERE user = ?")
        .bind(now, String((e && e.message) || e).slice(0, 200), row.user).run();
      out.done.push({ user: name, error: String((e && e.message) || e).slice(0, 80) });
      continue;
    }
    const ev = JSON.stringify(v.ev);
    const raw = JSON.stringify(v.raw || {});
    if (mode === 'test') {
      await testRecord(db, row.user, name, now, v, null);
    } else {
      // публикация: только если живого вердикта всё ещё нет (старые не трогаем); checked — реальная дата скана
      await db.batch([
        db.prepare(`INSERT INTO verdicts (user, name, tags, evidence, checked, updated, expires)
            SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.user = ? AND v.expires > ?)
            ON CONFLICT(user) DO UPDATE SET name = excluded.name, tags = excluded.tags, evidence = excluded.evidence,
              checked = excluded.checked, updated = excluded.updated, expires = excluded.expires`)
          .bind(row.user, name, JSON.stringify(v.tags), ev.length > 2000 ? null : ev, now, now, now + AUTO.ttl, row.user, now),
        db.prepare('INSERT OR REPLACE INTO verdict_raw (user, raw, t) VALUES (?, ?, ?)').bind(row.user, raw, now),
        db.prepare("UPDATE queue SET status = 'checked', checked = ?, err = NULL, lease = 0 WHERE user = ?").bind(now, row.user),
      ]);
    }
    out.done.push(recheck ? { user: name, tags: v.tags, recheck: true } : { user: name, tags: v.tags });
  }
  out.requests = m.requests;
  globalThis.setTimeout = realSetTimeout;
  out.metrics = { ...m, wallMs: Date.now() - t0, otherMs: Math.max(0, Date.now() - t0 - m.fetchMs - m.limitWaitMs - m.paceWaitMs - m.sleepMs - m.dbMs) };
  setArchFetch(null);
  try {
    const okN = out.done.filter((x) => x.tags).length, errs = out.done.filter((x) => x.error).length;
    await db.batch([
      db.prepare(`INSERT INTO autoqueue_runs (t, mode, nicks, ok, errors, requests, cache_hits, wall_ms, fetch_ms, wait_ms, other_ms, retries, pace_ms, sleep_ms, db_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(now, mode, out.done.length, okN, errs, m.requests, m.cacheHits,
        out.metrics.wallMs, m.fetchMs, m.limitWaitMs, out.metrics.otherMs, m.retries, m.paceWaitMs, m.sleepMs, m.dbMs),
      db.prepare('DELETE FROM autoqueue_runs WHERE t < ?').bind(now - 14 * DAY),
      db.prepare('DELETE FROM archive_cache WHERE t < ?').bind(now - AUTO.cacheTtl),
    ]);
  } catch { /* замеры не важнее проверки */ }
  return out;
}
