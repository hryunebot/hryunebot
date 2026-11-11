// Хрюнебот: тесты очереди новых ников на сервере (server/src/index.js) на локальной SQLite вместо D1. Запуск: node tools/queue-check.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const SRV = fileURLToPath(new URL('../server/', import.meta.url));
// index.js сервера — ES-модуль без "type": "module": копируем во временный .mjs
const TMP = join(tmpdir(), 'hryu-srv-' + process.pid + '.mjs');
copyFileSync(join(SRV, 'src', 'index.js'), TMP);
const srv = (await import(pathToFileURL(TMP).href)).default;
process.on('exit', () => { try { rmSync(TMP); } catch { /* ignore */ } });
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
console.log(bad ? `ОШИБОК: ${bad}` : 'Все проверки очереди на сервере пройдены.');
process.exit(bad ? 1 : 0);
