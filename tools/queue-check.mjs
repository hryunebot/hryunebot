// Хрюнебот: тесты очереди новых ников на сервере (server/src/index.js) на локальной SQLite вместо D1. Запуск: node tools/queue-check.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, copyFileSync, rmSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const SRV = fileURLToPath(new URL('../server/', import.meta.url));
// src сервера — ES-модули без "type": "module": копируем всю папку во временную с package.json {type: module}
const TMPD = join(tmpdir(), 'hryu-srv-' + process.pid);
mkdirSync(TMPD, { recursive: true });
for (const f of readdirSync(join(SRV, 'src'))) copyFileSync(join(SRV, 'src', f), join(TMPD, f));
writeFileSync(join(TMPD, 'package.json'), '{"type":"module"}');
const srvMod = await import(pathToFileURL(join(TMPD, 'index.js')).href);
const srv = srvMod.default;
const aq = await import(pathToFileURL(join(TMPD, 'autoqueue.js')).href);
process.on('exit', () => { try { rmSync(TMPD, { recursive: true, force: true }); } catch { /* ignore */ } });
const sq = new DatabaseSync(':memory:');
sq.exec(readFileSync(join(SRV, 'schema.sql'), 'utf8'));
const ADMIN = 'test-key-0123456789';
const h = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('admin:' + ADMIN))).toString('hex');
sq.prepare('INSERT INTO admin (id,key_hash) VALUES (1,?)').run(h);
class St { constructor(q) { this.q = q; this.a = []; } bind(...a) { this.a = a; return this; }
  _p() { return sq.prepare(this.q); }
  async first() { return this._p().get(...this.a) ?? null; } async all() { return { results: this._p().all(...this.a) }; }
  async run() { const r = this._p().run(...this.a); return { meta: { changes: r.changes } }; } }
const DB = { prepare: (q) => new St(q), batch: async (ss) => Promise.all(ss.map((s) => (/^\s*SELECT/i.test(s.q) ? s.all() : s.run()))) };
let ip = 0;
const call = async (m, p, b, hd = {}) => { const r = await srv.fetch(new Request('http://x' + p, { method: m, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.' + ++ip, ...hd }, body: b ? JSON.stringify(b) : undefined }), { DB }); return [r.status, await r.json()]; };
let bad = 0; const ok = (d, c, extra = '') => { if (!c) bad++; console.log((c ? 'ok ' : 'FAIL') + '  ' + d + (extra ? ' — ' + extra : '')); };
const toks = []; for (let i = 0; i < 3; i++) toks.push((await call('POST', '/join', { code: 'public' }))[1].token);
const A = (t) => ({ authorization: 'Bearer ' + t }), K = { 'x-admin-key': ADMIN };
// вердикт уже есть у «known_one»
await call('POST', '/admin/verdicts', { items: [{ user: 'Known_One', tags: ['ork'] }] }, K);
let [s, r] = await call('POST', '/queue', { items: [{ user: 'New_Orc', tags: ['ork', 'watch'], ev: { ork: { n: 9 } } }, { user: 'Clean_Guy', tags: ['clean'] }, { user: 'known_one', tags: ['ork'] }, { user: 'new_orc' }, { user: 'bad name!' }] }, A(toks[0]));
ok('приём: 2 новых, 1 уже с вердиктом, 1 дубль в запросе, 1 битый', s === 200 && r.added === 2 && r.known === 1 && r.dup === 1 && r.skipped === 1, JSON.stringify(r));
[s, r] = await call('POST', '/queue', { items: [{ user: 'NEW_ORC', tags: ['clean'] }] }, A(toks[0]));
ok('тот же участник повторно — дубль, счёт людей не растёт', r.dup === 1 && r.added === 0);
[s, r] = await call('POST', '/queue', { items: [{ user: 'new_orc', tags: ['clean'] }] }, A(toks[1]));
ok('другой участник — дубль, счёт людей +1', r.dup === 1);
[s, r] = await call('GET', '/admin/queue', null, K);
ok('очередь: 2 ника, сначала с найденными метками', s === 200 && r.queue.length === 2 && r.queue[0].name === 'New_Orc' && r.queue[0].reports === 2, JSON.stringify(r.queue));
ok('  предварительные метки — от первого приславшего, не перезаписаны', JSON.stringify(r.queue[0].pre) === '["ork","watch"]');
[s, r] = await call('GET', '/admin/queue', null, {});
ok('очередь без ключа — нельзя', s === 403);
[s, r] = await call('POST', '/queue', { items: [{ user: 'x1' }] }, {});
ok('без токена — нельзя', s === 401);
// группа (не общий слой) — нельзя
const g = (await call('POST', '/groups', { name: 'g' }))[1].token;
[s, r] = await call('POST', '/queue', { items: [{ user: 'x2' }] }, A(g));
ok('из закрытой группы — нельзя', s === 403);
// вердикт появился → из выдачи очереди уходит
await call('POST', '/admin/verdicts', { items: [{ user: 'Clean_Guy', tags: ['clean'] }] }, K);
[s, r] = await call('GET', '/admin/queue', null, K);
ok('ник с вердиктом из выдачи пропал', r.queue.length === 1 && r.queue[0].name === 'New_Orc');
[s, r] = await call('POST', '/admin/queue/done', { items: [{ user: 'New_Orc', status: 'error', err: 'архив не ответил' }] }, K);
ok('отметка «ошибка»', r.marked === 1);
[s, r] = await call('GET', '/admin/queue?status=error', null, K);
ok('ошибка видна отдельно (её проверяем повторно, это не «чисто»)', r.queue.length === 1 && r.queue[0].err === 'архив не ответил');
[s, r] = await call('GET', '/admin/queue/stats', null, K);
ok('статистика', r.total === 2 && r.error === 1 && r.new === 1 && r.reporters === 2 && r.newButKnown === 1, JSON.stringify(r));
// лимит 200 в сутки
let added = 0; for (let i = 0; i < 8; i++) { const items = Array.from({ length: 30 }, (_, j) => ({ user: `spam_${i}_${j}` })); added += (await call('POST', '/queue', { items }, A(toks[2])))[1].added; }
ok('лимит 200 ников в сутки от одного участника', added === 200, 'добавлено ' + added);
[s, r] = await call('POST', '/queue', { items: Array.from({ length: 50 }, (_, j) => ({ user: `big_${j}` })) }, A(toks[1]));
ok('за раз — не больше 30', r.added === 30);
[s, r] = await call('POST', '/queue', { items: [{ user: 'evbig', ev: { x: 'a'.repeat(2000) } }] }, A(toks[1]));
const row = sq.prepare('SELECT pre_ev FROM queue WHERE user = ?').get('evbig');
ok('длинные цифры не сохраняются', row && row.pre_ev === null);
// Даты вердикта (1.3.89): checked — от скрипта (реальный скан), updated/expires — от записи; будущее/мусор → «сейчас»
{
  const DAY = 86400000, now = Date.now(), old = now - 5 * DAY;
  await call('POST', '/admin/verdicts', { items: [{ user: 'Dated_One', tags: ['ork?'], checked: old }, { user: 'Future_One', tags: ['clean'], checked: now + 10 * DAY }, { user: 'Junk_One', tags: ['clean'], checked: 'вчера' }] }, K);
  const g = (u) => sq.prepare('SELECT checked, updated, expires FROM verdicts WHERE user = ?').get(u);
  const d = g('dated_one');
  ok('перезаливка не омолаживает: checked = дата скана', d && d.checked === old);
  ok('  updated — сейчас', d && Math.abs(d.updated - now) < 60000);
  ok('  срок хранения — от записи, не от скана', d && Math.abs(d.expires - (now + 30 * DAY)) < 60000);
  ok('checked из будущего → сейчас', Math.abs(g('future_one').checked - now) < 60000);
  ok('checked мусор → сейчас', Math.abs(g('junk_one').checked - now) < 60000);
  const [, lk] = await call('POST', '/verdicts', { users: ['Dated_One'] });
  ok('/verdicts отдаёт дату скана, а не перезаливки', lk.verdicts && lk.verdicts.dated_one && lk.verdicts.dated_one.checked <= old + DAY);
}
// ---------- автоочередь (1.3.91): архив подменён, проверяем порядок, бронь, ошибки, тест/публикацию ----------
{
  const NOW = Date.now(), HOUR = 3600000, DAY_MS = 86400000;
  sq.exec("DELETE FROM queue; DELETE FROM queue_rep; DELETE FROM autoqueue_test; DELETE FROM verdict_raw;");
  const addQ = (u, reports, first) => sq.prepare("INSERT INTO queue (user, name, first, last, reports, status) VALUES (?, ?, ?, ?, ?, 'new')").run(u.toLowerCase(), u, first, first, reports);
  addQ('Few_Reports', 1, NOW - 5000); addQ('Many_Reports', 3, NOW - 1000); addQ('AskGrok', 9, NOW - 9000);
  const Q = (u) => sq.prepare('SELECT * FROM queue WHERE user = ?').get(u.toLowerCase());
  const V = (u) => sq.prepare('SELECT * FROM verdicts WHERE user = ?').get(u.toLowerCase());
  const TEST = (u) => sq.prepare('SELECT * FROM autoqueue_test WHERE user = ?').get(u.toLowerCase());
  const okCheck = async () => ({ tags: ['ork?'], ev: { by: 'auto', ork: { n: 7, up: 5, down: 1, bySub: { expectedrussians: 7 } } }, raw: { subs: { expectedrussians: 7 } } });
  let calls = 0; const counting = async (n) => { calls++; return okCheck(n); };

  let r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'off' }, { now: NOW, check: counting });
  ok('автоочередь off — ничего не делает', r.mode === 'off' && calls === 0);
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: NOW, check: counting });
  ok('сервис-бот пропущен, архив не дёргали; тест очередь не меняет', r.done[0] && r.done[0].skipped === 'service bot' && Q('AskGrok').status === 'new' && calls === 0, JSON.stringify(r.done));
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: NOW, check: counting });
  ok('первым — кого прислало больше людей', r.done[0] && r.done[0].user === 'Many_Reports', JSON.stringify(r.done));
  ok('тест: результат в autoqueue_test, наружу НЕ публикуется', !!TEST('Many_Reports') && !V('Many_Reports') && Q('Many_Reports').status === 'new');
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: NOW, check: counting });
  ok('тест: один ник дважды не проверяем', r.done[0] && r.done[0].user === 'Few_Reports');
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: NOW, check: counting });
  ok('тест: очередь кончилась — пусто', r.done.length === 0);
  // тест + ошибка архива: очередь (status/tries/err) не меняется — ручной check-tj видит её как раньше
  addQ('Test_Flaky', 4, NOW - 30);
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: NOW, check: async () => { throw new Error('posts: timeout'); } });
  const tq = Q('Test_Flaky'), tt = TEST('Test_Flaky');
  ok('тест + ошибка архива: очередь не тронута (status new, tries/err пусто, бронь снята)', tq.status === 'new' && !tq.tries && !tq.err && !tq.lease, JSON.stringify(tq));
  ok('  ошибка записана в тестовую таблицу', tt && tt.err === 'posts: timeout' && tt.tries === 1);
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: NOW + 60000, check: counting });
  ok('  в тесте повтор не раньше чем через час', !r.done.some((x) => x.user === 'Test_Flaky'));
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: NOW + 2 * HOUR, check: counting });
  ok('  через час — повтор, ошибка заменена результатом', r.done.some((x) => x.user === 'Test_Flaky' && x.tags) && TEST('Test_Flaky').err === null);
  sq.exec("DELETE FROM queue WHERE user = 'test_flaky';");

  // ошибка архива — не вердикт, повтор не раньше чем через час
  sq.exec("DELETE FROM autoqueue_test; DELETE FROM queue WHERE user = 'askgrok';"); addQ('Flaky_One', 5, NOW - 100);
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish' }, { now: NOW, check: async () => { throw new Error('comments: timeout'); } });
  ok('ошибка архива → status error, tries 1, без вердикта', Q('Flaky_One').status === 'error' && Q('Flaky_One').tries === 1 && !V('Flaky_One') && !Q('Flaky_One').lease, JSON.stringify(Q('Flaky_One')));
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish', AUTOQUEUE_PER_RUN: '3' }, { now: NOW + 60000, check: okCheck });
  ok('после ошибки — не раньше чем через час', !r.done.some((x) => x.user === 'Flaky_One'));
  addQ('Empty_One', 1, NOW - 60);
  await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish', AUTOQUEUE_PER_RUN: '3' }, { now: NOW + 70000, check: async (n) => (n === 'Empty_One' ? { tags: [], ev: null } : okCheck()) });
  ok('пустой результат проверки — тоже не вердикт, а ошибка', Q('Empty_One').status === 'error' && !V('Empty_One'), JSON.stringify(Q('Empty_One')));

  // публикация
  ok('publish: вердикт новым никам, checked = дата скана, by auto', V('Many_Reports') && V('Many_Reports').checked === NOW + 60000 && JSON.parse(V('Many_Reports').evidence).by === 'auto' && Q('Many_Reports').status === 'checked');
  ok('publish: сырые цифры по сабам сохранены', !!sq.prepare('SELECT * FROM verdict_raw WHERE user = ?').get('many_reports'));
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish', AUTOQUEUE_PER_RUN: '3' }, { now: NOW + 2 * HOUR, check: okCheck });
  ok('через час ник с ошибкой проверяется снова', r.done.some((x) => x.user === 'Flaky_One' && x.tags) && V('Flaky_One'));
  // старый живой вердикт не трогаем
  sq.prepare("INSERT OR REPLACE INTO verdicts (user, name, tags, evidence, checked, updated, expires) VALUES ('old_guy', 'Old_Guy', '[\"clean\"]', NULL, ?, ?, ?)").run(NOW - HOUR, NOW - HOUR, NOW + 10 * HOUR);
  addQ('Old_Guy', 9, NOW - 50);
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish' }, { now: NOW + 3 * HOUR, check: okCheck });
  ok('ник с живым вердиктом автоочередь не берёт и не перезаписывает', !r.done.some((x) => x.user === 'Old_Guy') && V('Old_Guy').tags === '["clean"]');

  // бронь: занятый ник не берём; повторная бронь не проходит
  addQ('Busy_One', 9, NOW - 10); sq.prepare('UPDATE queue SET lease = ? WHERE user = ?').run(NOW + 3 * HOUR + 60000, 'busy_one');
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish' }, { now: NOW + 3 * HOUR, check: okCheck });
  ok('забронированный другим запуском ник не берём', !r.done.some((x) => x.user === 'Busy_One'));
  r = await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish' }, { now: NOW + 3 * HOUR + 11 * 60000, check: okCheck });
  ok('бронь истекла (упавший запуск) — ник снова берём', r.done.some((x) => x.user === 'Busy_One'));

  // шлагбаум: после 429 следующий запрос к архиву ждёт, сколько сказал архив (настоящий archFull, подменённый fetch)
  {
    addQ('Gate_Test', 99, NOW - 1);
    const realFetch = globalThis.fetch; const times = []; let first429 = true;
    globalThis.fetch = async (u) => {
      times.push({ t: Date.now(), u: String(u) });
      if (first429 && /\/posts\/search/.test(String(u))) {
        first429 = false;
        return new Response('{"error":"Too many requests"}', { status: 429, headers: { 'x-ratelimit-reset-at': String(Date.now() + 1200) } });
      }
      return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try { await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: Date.now() }); } finally { globalThis.fetch = realFetch; }
    const i429 = times.findIndex((x) => /\/posts\/search/.test(x.u));
    const gap = times[i429 + 1] ? times[i429 + 1].t - times[i429].t : -1;
    const tr = TEST('Gate_Test');
    ok('после 429 архива — пауза до сброса лимита (≥1,2 с), потом повтор', gap >= 1150, 'пауза ' + gap + ' мс');
    ok('  после паузы проверка доведена до конца (не ошибка)', tr && !tr.err && JSON.parse(tr.tags).length > 0, tr && (tr.err || tr.tags));
    sq.exec("DELETE FROM queue WHERE user = 'gate_test';");
  }
  // перепроверка старых вердиктов в тесте (AUTOQUEUE_RECHECK=1): только когда очередь пуста, без публикации, один проход
  {
    sq.exec("DELETE FROM queue; DELETE FROM autoqueue_test; DELETE FROM verdicts;");
    const putV = (u, checked) => sq.prepare("INSERT INTO verdicts (user, name, tags, evidence, checked, updated, expires) VALUES (?, ?, '[\"clean\"]', NULL, ?, ?, ?)").run(u.toLowerCase(), u, checked, checked, NOW + 10 * DAY_MS);
    putV('Old_A', NOW - 3 * DAY_MS); putV('Old_B', NOW - 5 * DAY_MS);
    const before = sq.prepare('SELECT user, tags, checked, updated, expires FROM verdicts ORDER BY user').all();
    const E = { AUTOQUEUE: 'test', AUTOQUEUE_RECHECK: '1' };
    let r2 = await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: NOW, check: okCheck });
    ok('без AUTOQUEUE_RECHECK старые не перепроверяем', r2.done.length === 0);
    addQ('Queue_First', 1, NOW - 5);
    r2 = await aq.runAutoQueue(DB, E, { now: NOW, check: okCheck });
    ok('перепроверка: сначала очередь', r2.done[0] && r2.done[0].user === 'Queue_First' && !r2.done[0].recheck);
    r2 = await aq.runAutoQueue(DB, E, { now: NOW, check: okCheck });
    ok('очередь пуста → самый давний вердикт', r2.done[0] && r2.done[0].user === 'Old_B' && r2.done[0].recheck === true, JSON.stringify(r2.done));
    r2 = await aq.runAutoQueue(DB, E, { now: NOW, check: async () => { throw new Error('archive down'); } });
    ok('  ошибка архива при перепроверке — в тест, вердикт не тронут', r2.done[0] && r2.done[0].user === 'Old_A' && TEST('Old_A').err === 'archive down');
    r2 = await aq.runAutoQueue(DB, E, { now: NOW, check: okCheck });
    ok('  один проход: всех перепроверили — дальше пусто', r2.done.length === 0);
    const after = sq.prepare('SELECT user, tags, checked, updated, expires FROM verdicts ORDER BY user').all();
    ok('  опубликованные вердикты НЕ изменились (теги, даты, срок)', JSON.stringify(before) === JSON.stringify(after));
    ok('  результат перепроверки — в autoqueue_test', TEST('Old_B') && JSON.parse(TEST('Old_B').tags)[0] === 'ork?');
  }
  // ---- скорость (13.11): кэш ответов архива, повтор только упавшего, растущая задержка, порядок, замеры, сбой профиля ----
  {
    sq.exec("DELETE FROM queue; DELETE FROM autoqueue_test; DELETE FROM archive_cache; DELETE FROM autoqueue_runs; DELETE FROM verdicts;");
    const ok200 = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const mkFetch = (failRe) => { const calls = []; const f = async (u) => { u = String(u); calls.push(u);
      if (failRe && failRe.test(u)) return new Response('{"error":"Timeout. Maybe slow down a bit"}', { status: 500 });
      if (/users\/search/.test(u)) return ok200({ data: [] });
      return ok200({ data: [] }); }; f.calls = calls; return f; };
    addQ('Cache_Nick', 50, NOW - 1);
    // 1-й запуск: падают только «свежие комменты» (after=) — проверка = ошибка, но остальные ответы легли в кэш
    const f1 = mkFetch(/comments\/search.*after=/);
    const T1 = Date.now();
    let r3 = await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: T1, fetch: f1 });
    ok('частичная ошибка архива → ошибка, не вердикт', r3.done[0] && r3.done[0].error && TEST('Cache_Nick').err, JSON.stringify(r3.done));
    const cached = sq.prepare('SELECT COUNT(*) n FROM archive_cache').get().n;
    ok('  успешные ответы легли в кэш', cached >= 3, 'в кэше ' + cached);
    // 2-й запуск через 2 ч: в сеть идёт ТОЛЬКО то, чего нет в кэше (упавший запрос)
    const f2 = mkFetch(null);
    r3 = await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: T1 + 2 * HOUR, fetch: f2 });
    // успешно полученное в 1-м прогоне повторно в сеть не идёт; в сеть — упавший запрос и то, до чего 1-й прогон не дошёл
    const okFirst = new Set(f1.calls.filter((u) => !/comments\/search.*after=/.test(u)));
    const refetched = f2.calls.filter((u) => okFirst.has(u)).length;
    ok('повтор: успешно полученное — из кэша, в сеть только упавшее и недошедшее', r3.done[0] && r3.done[0].tags && refetched === 0 && f2.calls.some((u) => /comments\/search.*after=/.test(u)), 'сеть: ' + f2.calls.length + ', повторно уже полученных: ' + refetched);
    const run = sq.prepare('SELECT * FROM autoqueue_runs ORDER BY rowid DESC LIMIT 1').get();
    ok('замеры запуска записаны (запросы, кэш, время)', run && run.cache_hits >= 3 && run.requests === f2.calls.length && run.wall_ms >= 0 && run.fetch_ms >= 0, JSON.stringify(run));
    ok('  в ответе — разбивка времени (сеть / ожидание лимита / прочее)', r3.metrics && 'fetchMs' in r3.metrics && 'limitWaitMs' in r3.metrics && 'otherMs' in r3.metrics);

    // в кэш — только проверенный на полноту ответ
    const U100 = 'https://x/api/posts/search?author=a&limit=100&sort=desc&before=1', U50 = U100.replace('limit=100', 'limit=50');
    ok('кэш: полный ответ 200 с записями — да', aq.cacheable(U100, '{"data":[{"created_utc":1,"subreddit":"a"}]}') === true);
    ok('кэш: пустой список (у ника нет записей) — да', aq.cacheable(U100, '{"data":[]}') === true);
    ok('кэш: 200, но есть поле error — нет', aq.cacheable(U100, '{"data":[],"error":"Timeout. Maybe slow down a bit"}') === false);
    ok('кэш: 200 без списка data — нет', aq.cacheable(U100, '{"result":"ok"}') === false);
    ok('кэш: битый JSON — нет', aq.cacheable(U100, '{"data":[') === false);
    ok('кэш: записи-мусор (не объекты) — нет', aq.cacheable(U100, '{"data":[1,2,3]}') === false);
    ok('кэш: облегчённый ответ limit=50 — в дело, но не в кэш', aq.cacheable(U50, '{"data":[{"created_utc":1}]}') === false);
    {
      sq.exec("DELETE FROM archive_cache;"); addQ('Err200_Nick', 45, NOW - 1);
      const f3 = async (u) => /comments\/search.*after=/.test(String(u))
        ? new Response('{"data":[],"error":"partial"}', { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: T1 + 4 * HOUR, fetch: f3 });
      const bad200 = sq.prepare("SELECT COUNT(*) n FROM archive_cache WHERE url LIKE '%comments/search%after=%'").get().n;
      ok('  ответ 200 с error не попал в кэш (повторится)', bad200 === 0);
      sq.exec("DELETE FROM queue WHERE user = 'err200_nick';");
    }
    // полнота по типу запроса (archOk): ответ должен соответствовать именно этому запросу
    {
      const g = await import(pathToFileURL(join(TMPD, 'check.gen.js')).href);
      const A = 'https://arctic-shift.photon-reddit.com/api';
      const P = `${A}/posts/search?author=a&limit=3&sort=desc&before=1000&fields=subreddit,created_utc`;
      const ok1 = { data: [{ created_utc: 900, subreddit: 'x' }, { created_utc: 800, subreddit: 'y' }] };
      ok('полнота: нормальный ответ постов — да', g.archOk(P, true, ok1) === true);
      ok('полнота: записей больше limit — нет', g.archOk(P, true, { data: [1, 2, 3, 4].map((i) => ({ created_utc: 900 - i, subreddit: 'x' })) }) === false);
      ok('полнота: дата вне окна before — нет', g.archOk(P, true, { data: [{ created_utc: 1500, subreddit: 'x' }] }) === false);
      ok('полнота: порядок не как в sort=desc — нет', g.archOk(P, true, { data: [{ created_utc: 800, subreddit: 'x' }, { created_utc: 900, subreddit: 'x' }] }) === false);
      ok('полнота: нет саба при fields=subreddit — нет', g.archOk(P, true, { data: [{ created_utc: 900 }] }) === false);
      ok('полнота: дата не число — нет', g.archOk(P, true, { data: [{ created_utc: '900', subreddit: 'x' }] }) === false);
      ok('полнота: HTTP не 200 — нет', g.archOk(P, false, ok1) === false);
      const U = `${A}/users/search?author=a&limit=5`;
      ok('полнота: профиль с автором — да; без автора — нет', g.archOk(U, true, { data: [{ author: 'a', _meta: {} }] }) === true && g.archOk(U, true, { data: [{ _meta: {} }] }) === false);
    }
    // общий шлагбаум: 429 в одном запуске виден другому (пересекающемуся) через D1
    {
      sq.exec("DELETE FROM archive_gate;");
      addQ('Gate_A', 70, NOW - 1);
      let hit = 0;
      const f429 = async (u) => { if (/posts\/search/.test(String(u)) && !hit++) return new Response('{"error":"Too many requests"}', { status: 429, headers: { 'x-ratelimit-reset-at': String(Date.now() + 30000) } }); return new Response('{"data":[]}', { status: 200 }); };
      const pA = aq.runAutoQueue(DB, { AUTOQUEUE: 'test', AUTOQUEUE_GAP_MS: '200' }, { now: Date.now(), fetch: f429 });
      await new Promise((r) => setTimeout(r, 1200));
      const g1 = sq.prepare('SELECT blocked_until FROM archive_gate WHERE id = 1').get();
      ok('общий шлагбаум: срок ожидания после 429 записан в D1 (виден всем запускам)', g1 && g1.blocked_until > Date.now() + 20000, JSON.stringify(g1));
      sq.exec("UPDATE archive_gate SET blocked_until = 0;"); // не ждать 30 с в тесте
      await pA; sq.exec("DELETE FROM queue WHERE user = 'gate_a';");
    }
    // общий ТЕМП: два одновременных запуска вместе не шлют запросы к архиву чаще интервала
    {
      sq.exec("DELETE FROM queue; DELETE FROM autoqueue_test; DELETE FROM archive_cache; UPDATE archive_gate SET next_at = 0, blocked_until = 0;");
      addQ('Pace_A', 80, NOW - 2); addQ('Pace_B', 79, NOW - 1);
      const stamps = [];
      const fp = async (u) => { stamps.push(Date.now()); return new Response('{"data":[]}', { status: 200 }); };
      const E = { AUTOQUEUE: 'test', AUTOQUEUE_GAP_MS: '300', AUTOQUEUE_CACHE: '0' };
      await Promise.all([aq.runAutoQueue(DB, E, { now: Date.now(), fetch: fp }), aq.runAutoQueue(DB, E, { now: Date.now(), fetch: fp })]);
      stamps.sort((a, b) => a - b);
      let minGap = Infinity; for (let i = 1; i < stamps.length; i++) minGap = Math.min(minGap, stamps[i] - stamps[i - 1]);
      ok('общий темп: два одновременных запуска вместе — не чаще 1 запроса за интервал', stamps.length >= 10 && minGap >= 270, 'запросов ' + stamps.length + ', мин. промежуток ' + minGap + ' мс (интервал 300)');
      ok('  оба ника проверены (бронь не дала взять один дважды)', !!TEST('Pace_A') && !!TEST('Pace_B'));
      sq.exec("DELETE FROM queue;");
    }
    // ручной прогон заданных ников — всегда тест, с замерами по каждому
    {
      sq.exec("DELETE FROM verdicts WHERE user = 'manual_one';");
      const r5 = await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish' }, { now: NOW, users: ['u/Manual_One'], check: okCheck });
      ok('ручной прогон: проверен заданный ник, с замерами', r5.done[0] && r5.done[0].user === 'Manual_One' && r5.done[0].manual && r5.done[0].metrics && 'requests' in r5.done[0].metrics);
      ok('  ручной прогон НЕ публикует даже в режиме publish', !V('Manual_One') && TEST('Manual_One'));
    }
    // сбой профиля архива — ошибка, а не «чисто без кармы»
    sq.exec("DELETE FROM archive_cache;"); addQ('Profile_Fail', 40, NOW - 1);
    r3 = await aq.runAutoQueue(DB, { AUTOQUEUE: 'test' }, { now: T1 + 3 * HOUR, fetch: mkFetch(/users\/search/) });
    ok('сбой запроса профиля → ошибка (не «чисто»)', r3.done[0] && r3.done[0].user === 'Profile_Fail' && /profile/.test(r3.done[0].error || ''), JSON.stringify(r3.done));

    // растущая задержка: 2-я ошибка → повтор через 2 ч, не через 1
    sq.exec("DELETE FROM queue; DELETE FROM autoqueue_test;");
    addQ('Backoff_Nick', 5, NOW - 1);
    const boom = async () => { throw new Error('x'); };
    await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish' }, { now: NOW, check: boom });
    await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish' }, { now: NOW + HOUR + 1, check: boom });
    ok('  2-я ошибка записана (tries 2)', Q('Backoff_Nick').tries === 2);
    r3 = await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish' }, { now: NOW + 2 * HOUR + 2, check: okCheck });
    ok('растущая задержка: после 2-й ошибки через 1 ч — ещё рано', !r3.done.some((x) => x.user === 'Backoff_Nick'));
    r3 = await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish' }, { now: NOW + 3 * HOUR + 2, check: okCheck });
    ok('  через 2 ч — повтор', r3.done.some((x) => x.user === 'Backoff_Nick' && x.tags));
    // новые раньше отложенных (с ошибкой), даже если отложенного прислало больше людей
    sq.exec("DELETE FROM queue; DELETE FROM autoqueue_test; DELETE FROM verdicts;");
    addQ('Heavy_Deferred', 90, NOW - 9); sq.prepare("UPDATE queue SET status = 'error', tries = 1, checked = ? WHERE user = 'heavy_deferred'").run(NOW - 10 * HOUR);
    addQ('Fresh_New', 1, NOW - 1);
    r3 = await aq.runAutoQueue(DB, { AUTOQUEUE: 'publish' }, { now: NOW, check: okCheck });
    ok('новые раньше отложенных тяжёлых', r3.done[0] && r3.done[0].user === 'Fresh_New', JSON.stringify(r3.done));
    sq.exec("DELETE FROM queue; DELETE FROM verdicts;");
  }
  // ручной запуск — только владелец
  const [s1] = await call('POST', '/admin/autoqueue/run', {});
  ok('ручной запуск автоочереди без ключа — 403', s1 === 403);
}

console.log(bad ? `ОШИБОК: ${bad}` : 'Все проверки очереди на сервере пройдены.');
process.exit(bad ? 1 : 0);
