// Хрюнебот: тесты синхронизации по ключу (WISHLIST п.15) — сервер (SQLite вместо D1) + настоящий клиент reddit-tagger/sync.js.
// Каждый сценарий — со своей чистой базой. Запуск: node tools/sync-check.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, copyFileSync, rmSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRV = join(ROOT, 'server');
const TMPD = join(tmpdir(), 'hryu-sync-' + process.pid);
mkdirSync(TMPD, { recursive: true });
for (const f of readdirSync(join(SRV, 'src'))) copyFileSync(join(SRV, 'src', f), join(TMPD, f));
writeFileSync(join(TMPD, 'package.json'), '{"type":"module"}');
const srv = (await import(pathToFileURL(join(TMPD, 'index.js')).href)).default;
process.on('exit', () => { try { rmSync(TMPD, { recursive: true, force: true }); } catch { /* ignore */ } });
vm.runInThisContext(readFileSync(join(ROOT, 'reddit-tagger/sync.js'), 'utf8'));
const S = globalThis.HryuSync;

const SCHEMA = readFileSync(join(SRV, 'schema.sql'), 'utf8');
class St { constructor(db, q) { this.db = db; this.q = q; this.a = []; } bind(...a) { this.a = a; return this; }
  _p() { return this.db.prepare(this.q); }
  async first() { return this._p().get(...this.a) ?? null; } async all() { return { results: this._p().all(...this.a) }; }
  async run() { const r = this._p().run(...this.a); return { meta: { changes: r.changes } }; } }
let sq, ENV;
const fresh = () => {
  sq = new DatabaseSync(':memory:');
  sq.exec(SCHEMA);
  sq.exec("INSERT OR IGNORE INTO groups (id, name, code, min_votes, created) VALUES ('public', 'Загальний', 'public', 2, 0)");
  const db = sq;
  // D1 batch — одна транзакция: при ошибке ничего не применяется
  const DB = { prepare: (q) => new St(db, q), batch: async (ss) => { db.exec('BEGIN'); try { const r = []; for (const s of ss) r.push(await (/^\s*SELECT/i.test(s.q) ? s.all() : s.run())); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  ENV = { DB, TRUST_SECRET: 'test-trust-secret-0123456789', TRUST_TAG_MIN: '2', TRUST_COMPLAINT_MIN: '2' };
};
let ip = 0;
const call = async (m, p, b, token) => {
  const r = await srv.fetch(new Request('http://x' + p, { method: m, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.' + (++ip >> 8 & 255) + '.' + (ip & 255) + '.2', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: b ? JSON.stringify(b) : undefined }), ENV);
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error || 'HTTP ' + r.status); e.status = r.status; e.body = j; throw e; }
  return j;
};
let bad = 0; const ok = (d, c, extra = '') => { if (!c) bad++; console.log((c ? 'ok ' : 'FAIL') + '  ' + d + (extra ? ' — ' + extra : '')); };
const scenario = async (name, fn) => { fresh(); console.log('\n# ' + name); await fn(); };
const fails = async (fn) => { try { await fn(); return 0; } catch (e) { return e.status ?? -1; } };

// «устройство»: своя установка (токен общего слоя), свои данные, своё состояние синхронизации
async function device(name) {
  const token = (await call('POST', '/join', { code: 'public' })).token;
  const d = { name, token, state: { users: {}, settings: {}, reviews: {} }, st: null, key: null, crashOn: null };
  d.api = async (path, body) => {
    if (d.crashOn && path === d.crashOn) { d.crashOn = null; const e = new Error('сбой сети (тест)'); e.status = 0; throw e; }
    return call('POST', path, body, token);
  };
  d.io = (keys) => ({ st: d.st, keys, api: d.api, load: async () => structuredClone(d.state), save: async (s) => { d.state = s; } });
  d.create = async () => { d.key = S.genKey(); const k = await S.derive(d.key); const r = await d.api('/sync/create', { auth: k.auth }); d.st = { key: d.key, keyNo: r.keyNo, since: 0, f: {} }; };
  d.attach = async (key) => { const k = await S.derive(key); const r = await d.api('/sync/attach', { auth: k.auth }); d.key = key; d.st = { key, keyNo: r.keyNo, since: 0, f: {} }; };
  d.sync = async () => S.syncOnce(d.io(await S.derive(d.st.key)));
  d.rotate = async () => { // как в фоне расширения: сначала запомнить op и новый ключ, потом довести
    d.st.rot ||= { op: 'op' + Math.random().toString(36).slice(2, 12), key: S.genKey() };
    const keyNo = await S.rotate(d.io(await S.derive(d.st.key)), await S.derive(d.st.rot.key));
    d.key = d.st.rot.key; d.st = { key: d.key, keyNo, since: 0, f: {} };
    return d.sync();
  };
  d.tag = (nick, tags, extra = {}) => { const k = nick.toLowerCase(); d.state.users[k] = { name: nick, tags, color: '#e5484d', note: '', subs: {}, seen: [], ...(d.state.users[k] || {}), ...extra, tags }; };
  d.u = (nick) => d.state.users[nick.toLowerCase()];
  return d;
}

await scenario('ключ', async () => {
  const k = S.genKey(), k2 = S.genKey();
  ok('ключ: случайный, 52 символа base32 + HRYU-, разбор туда-обратно', /^HRYU-([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/.test(k) && k !== k2 && S.parseKey(k) && S.parseKey(k.toLowerCase().replace(/-/g, ' ')), k);
  ok('  мусор и обрезанный ключ — не принимаются', !S.parseKey('HRYU-1234') && !S.parseKey('hello world'));
  const a = await S.derive(k), b = await S.derive(k);
  ok('  из ключа выводятся одни и те же auth и id полей; разные ключи — разные', a.auth === b.auth && (await a.fid('u/x/tags')) === (await b.fid('u/x/tags')) && a.auth !== (await S.derive(k2)).auth);
});

await scenario('две установки: разные данные сливаются', async () => {
  const A = await device('комп'), B = await device('телефон');
  A.tag('Orc_One', ['орк']); A.state.settings.lang = 'ru'; A.state.settings.size = 'big';
  B.tag('Zrada_Two', ['зрадойоб'], { note: 'пише про зраду' }); B.state.settings.size = 'small'; B.state.reviews.zrada_two = { mark: 'ok', t: 1 };
  await A.create(); await A.sync();
  await B.attach(A.key); await B.sync(); await A.sync();
  ok('разные ники с двух устройств — оба на обоих', A.u('Orc_One') && A.u('Zrada_Two') && B.u('Orc_One') && B.u('Zrada_Two') && A.u('Zrada_Two').note === 'пише про зраду');
  ok('  оценки ✔/✖ и настройки синхронизированы', A.state.reviews.zrada_two?.mark === 'ok' && B.state.settings.lang === 'ru');
  ok('  размер значков — у каждого устройства свой', A.state.settings.size === 'big' && B.state.settings.size === 'small');
  const raw = JSON.stringify(sq.prepare('SELECT * FROM sync_fields').all());
  ok('сервер хранит только шифротекст: нет ников, меток, заметок, имён полей', !/orc_one|zrada|орк|зрадойоб|пише|tags|note/i.test(raw), raw.slice(0, 120));
  const dv = await B.api('/sync/devices', {});
  ok('  список устройств: 2, «это устройство» отмечено, без токенов', dv.devices.length === 2 && dv.devices.filter((x) => x.me).length === 1 && dv.devices.every((x) => x.id.length === 6));
});

await scenario('слияние по полям одного ника', async () => {
  const A = await device('A'), B = await device('B');
  A.tag('Same_Nick', ['орк']); await A.create(); await A.sync(); await B.attach(A.key); await B.sync();
  A.u('Same_Nick').note = 'заметка с компа';
  B.u('Same_Nick').color = '#0090ff';
  await A.sync(); await B.sync(); await A.sync();
  ok('заметка с одного устройства и цвет с другого — обе правки живут', A.u('Same_Nick').note === 'заметка с компа' && A.u('Same_Nick').color === '#0090ff' && B.u('Same_Nick').note === 'заметка с компа' && B.u('Same_Nick').color === '#0090ff');
  A.u('Same_Nick').complaints = [{ thing: 't1_a', sub: 'tjournal_refugees', t: 1 }];
  B.u('Same_Nick').complaints = [{ thing: 't1_b', sub: 'tjournal_refugees', t: 2 }];
  await A.sync(); await B.sync(); await A.sync();
  ok('  жалобы на разные комменты с двух устройств — обе в личном списке', ['t1_a', 't1_b'].every((t) => A.u('Same_Nick').complaints.some((c) => c.thing === t) && B.u('Same_Nick').complaints.some((c) => c.thing === t)));
});

await scenario('одно поле с двух устройств: первая на сервере побеждает', async () => {
  const A = await device('A'), B = await device('B');
  A.tag('Clash', ['орк'], { note: 'было' }); await A.create(); await A.sync(); await B.attach(A.key); await B.sync();
  A.u('Clash').note = 'правка A'; B.u('Clash').note = 'правка B'; // обе на одну версию
  await A.sync(); const rb = await B.sync(); await A.sync();
  ok('B взял значение сервера (пришло первым), A не перезаписан', A.u('Clash').note === 'правка A' && B.u('Clash').note === 'правка A', JSON.stringify(rb));
  ok('  проигравший текст B не пропал молча: сохранён локальный вариант для показа и копирования', rb.lost.length === 1 && rb.lost[0].local === 'правка B' && rb.lost[0].server === 'правка A' && rb.lost[0].name === 'Clash', JSON.stringify(rb.lost));
  const ra2 = await A.sync();
  ok('  у победившего устройства конфликта нет', ra2.lost.length === 0);
  // гонка: две правки на одну версию приходят на сервер напрямую — вторая получает конфликт с текущим значением
  const f = await (await S.derive(A.key)).fid('u/clash/note'), base = sq.prepare('SELECT ver FROM sync_fields WHERE f = ?').get(f).ver;
  const p1 = await A.api('/sync/push', { since: A.st.since, items: [{ f, base, d: 'AAAA' }] });
  const p2 = await B.api('/sync/push', { since: B.st.since, items: [{ f, base, d: 'BBBB' }] });
  ok('  гонка на сервере: первая принята, вторая — конфликт с текущим значением', p1.applied.length === 1 && p2.applied.length === 0 && p2.conflicts[0]?.d === 'AAAA', JSON.stringify(p2));
  await A.api('/sync/push', { since: A.st.since, items: [{ f, base: p1.applied[0].v, d: await (await S.derive(A.key)).seal(f, { n: 'u/clash/note', v: [ 'Clash', 'правка A' ] }) }] });
  B.u('Clash').note = 'правка B2'; const rc = await B.sync(); await A.sync();
  ok('  устройство со старой базой: конфликт → слияние (значение сервера)', B.u('Clash').note === 'правка A' && A.u('Clash').note === 'правка A', JSON.stringify(rc));
  B.u('Clash').note = 'B после слияния'; await B.sync(); await A.sync();
  ok('  после слияния следующая правка B проходит', A.u('Clash').note === 'B после слияния');
});

await scenario('удаление + устройство неделю офлайн', async () => {
  const A = await device('A'), B = await device('B');
  A.tag('Gone', ['орк'], { note: 'x' }); A.tag('Stay', ['новорег']);
  await A.create(); await A.sync(); await B.attach(A.key); await B.sync();
  delete A.state.users.gone; await A.sync(); // удалил на компе, телефон неделю не синхронизировался
  await B.sync(); await A.sync();
  ok('удалённая метка не возвращается с устройства, бывшего офлайн', !A.u('Gone') && !B.u('Gone') && A.u('Stay') && B.u('Stay'));
  B.tag('Gone', ['зрадойоб']); await B.sync(); await A.sync();
  ok('  но заново поставленная после удаления — синхронизируется', A.u('Gone')?.tags[0] === 'зрадойоб');
});

await scenario('надгробия старше 180 дней: старое устройство — только через полный снимок', async () => {
  const A = await device('A'), B = await device('B');
  A.tag('Old_Del', ['орк']); A.tag('Live', ['консерва']);
  await A.create(); await A.sync(); await B.attach(A.key); await B.sync();
  delete A.state.users.old_del; await A.sync();
  sq.exec('UPDATE sync_fields SET del = del - 181 * 86400000 WHERE d IS NULL'); // прошло 181 день
  A.tag('New_One', ['орк']); await A.sync(); // надгробие вычищено, floor вырос
  const floor = sq.prepare('SELECT floor FROM sync_ident').get().floor;
  const st = await fails(() => B.api('/sync/push', { since: B.st.since, items: [] }));
  ok('сервер не принимает правки устройства старше floor (409, нужен снимок)', floor > 0 && st === 409, 'floor ' + floor + ', ответ ' + st);
  await B.sync();
  ok('  устройство скачало снимок: удалённое удалено и у него, новое пришло, ничего не воскресло', !B.u('Old_Del') && B.u('Live') && B.u('New_One'));
  await A.sync();
  ok('  и на сервере/у A удалённое не воскресло', !A.u('Old_Del'));
});

await scenario('смена ключа (потерянное устройство)', async () => {
  const A = await device('A'), B = await device('B'), Lost = await device('потерянный');
  A.tag('Keep_Me', ['орк'], { note: 'важное' }); A.state.reviews.keep_me = { mark: 'bad', t: 1 };
  await A.create(); await A.sync(); await B.attach(A.key); await B.sync(); await Lost.attach(A.key); await Lost.sync();
  const oldKey = A.key;
  await A.rotate();
  ok('данные целы после смены ключа', A.u('Keep_Me')?.note === 'важное' && A.state.reviews.keep_me?.mark === 'bad' && A.key !== oldKey);
  const s1 = await fails(() => Lost.sync()), s2 = await fails(() => B.sync());
  ok('все старые устройства отключены (их токены больше не работают с синхронизацией)', s1 === 404 && s2 === 404, s1 + ' ' + s2);
  const s3 = await fails(() => Lost.attach(oldKey));
  ok('повторная регистрация по старому ключу — отказ', s3 === 403);
  await B.attach(A.key); await B.sync();
  ok('своё устройство с новым ключом — снова получает данные', B.u('Keep_Me')?.note === 'важное');
  const raw = JSON.stringify(sq.prepare('SELECT key_no FROM sync_fields').all());
  ok('  на сервере остались только поля нового ключа', !/"key_no":1/.test(raw));
});

await scenario('сбой посередине смены ключа', async () => {
  const A = await device('A'), B = await device('B');
  A.tag('Precious', ['орк'], { note: 'не потерять' }); await A.create(); await A.sync(); await B.attach(A.key); await B.sync();
  const oldKey = A.key;
  A.crashOn = '/sync/rotate/commit';
  const s = await fails(() => A.rotate());
  ok('сбой между загрузкой новых данных и переключением', s === 0);
  await B.sync();
  ok('  до переключения действует старый ключ (B синхронизируется)', B.u('Precious')?.note === 'не потерять');
  A.st = { ...A.st }; // фон расширения хранит st.rot — повтор с тем же op
  await A.rotate();
  ok('повтор доводит до конца: данные целы, новый ключ работает', A.u('Precious')?.note === 'не потерять' && A.key !== oldKey && sq.prepare('SELECT key_no FROM sync_ident').get().key_no === 2);
  ok('  старый ключ не действует', (await fails(() => B.attach(oldKey))) === 403);
  const C = await device('C'); await C.attach(A.key); await C.sync();
  ok('  новое устройство по новому ключу получает данные', C.u('Precious')?.note === 'не потерять');
  const r1 = await A.api('/sync/rotate/commit', { op: 'unknown-op-123' }).catch((e) => e.status);
  ok('  чужой/старый op не переключает ничего', r1 === 409);
});

await scenario('довіра идёт за личностью, голос один', async () => {
  const A = await device('A'), B = await device('B'), C = await device('C'), X = await device('чужой');
  const acct = 'a'.repeat(64);
  sq.prepare("UPDATE members SET acct = ? WHERE token_hash = (SELECT token_hash FROM members ORDER BY rowid LIMIT 1)").run(acct); // A подтвердился через reddit
  sq.prepare("INSERT INTO trusted (acct, by, granted, revoked) VALUES (?, 'auto', 0, NULL)").run(acct);
  await A.create(); await A.sync(); await B.attach(A.key); await B.sync();
  const st = await call('GET', '/trust/status', null, B.token);
  ok('новое устройство по ключу сразу довірене, второй код в reddit не нужен', st.status === 'trusted', JSON.stringify(st));
  for (const d of [A, B]) await call('POST', '/vote', { user: 'Target', tags: ['орк'] }, d.token);
  const n = sq.prepare("SELECT COUNT(DISTINCT m.acct) n FROM votes v JOIN members m ON m.token_hash = v.member WHERE v.user = 'target'").get().n;
  ok('  голоса с двух устройств = один аккаунт', n === 1);
  sq.prepare("UPDATE members SET acct = ? WHERE token_hash = (SELECT token_hash FROM members ORDER BY rowid DESC LIMIT 1)").run('b'.repeat(64)); // X — другой аккаунт
  ok('устройство, подтверждённое ДРУГИМ аккаунтом, к чужой личности не цепляется', (await fails(() => X.attach(A.key))) === 409);
  await C.attach(A.key);
  await A.rotate();
  const sb = await call('GET', '/trust/status', null, B.token);
  ok('после смены ключа отключённые устройства теряют доступ (статус «відключено»)', sb.status === 'blocked', JSON.stringify(sb));
  ok('  у устройства, сменившего ключ, довіра остаётся', (await call('GET', '/trust/status', null, A.token)).status === 'trusted');
  await B.attach(A.key); await B.sync();
  ok('  довіра личности сохранилась: своё устройство с новым ключом снова довірене', (await call('GET', '/trust/status', null, B.token)).status === 'trusted');
});

await scenario('отозванное доверие синхронизация не возвращает', async () => {
  const A = await device('A'), B = await device('B'), C = await device('C');
  const acct = 'c'.repeat(64);
  sq.prepare("UPDATE members SET acct = ? WHERE token_hash = (SELECT token_hash FROM members ORDER BY rowid LIMIT 1)").run(acct);
  sq.prepare("INSERT INTO trusted (acct, by, granted, revoked) VALUES (?, 'auto', 0, NULL)").run(acct);
  await A.create(); await A.sync(); await B.attach(A.key); await B.sync();
  sq.prepare('UPDATE trusted SET revoked = 1 WHERE acct = ?').run(acct); // владелец отозвал
  await C.attach(A.key); await C.sync();
  const sc = await call('GET', '/trust/status', null, C.token), sb = await call('GET', '/trust/status', null, B.token);
  ok('новое устройство наследует статус личности: отозвано → «відкликано», не довірене', sc.status === 'revoked' && sb.status === 'revoked', JSON.stringify([sc, sb]));
  await A.rotate(); await B.attach(A.key); await B.sync();
  ok('  смена ключа доверие не возвращает', (await call('GET', '/trust/status', null, B.token)).status === 'revoked');
  await call('POST', '/vote', { user: 'Target_R', tags: ['орк'] }, C.token).catch(() => {});
  const n = sq.prepare(`SELECT COUNT(DISTINCT m.acct) n FROM votes v JOIN members m ON m.token_hash = v.member JOIN trusted t ON t.acct = m.acct AND t.revoked IS NULL WHERE v.user = 'target_r'`).get().n;
  ok('  голос не считается', n === 0);
});

await scenario('потеряны ВСЕ устройства: восстановление по сохранённому ключу', async () => {
  const A = await device('A'), B = await device('B');
  A.tag('Remember', ['орк'], { note: 'моя нотатка' }); A.state.settings.lang = 'ru'; A.state.reviews.remember = { mark: 'ok', t: 1 };
  await A.create(); await A.sync(); await B.attach(A.key); await B.sync();
  const saved = A.key; // человек сохранил ключ при создании
  // оба устройства потеряны: их токены и данные недоступны, новая установка — с нуля
  const N = await device('новий телефон');
  await N.attach(saved); await N.sync();
  ok('новая установка по сохранённому ключу получает всё: метки, заметки, оценки, настройки', N.u('Remember')?.note === 'моя нотатка' && N.u('Remember').tags[0] === 'орк' && N.state.reviews.remember?.mark === 'ok' && N.state.settings.lang === 'ru');
  await N.rotate();
  ok('  и может сменить ключ — потерянные устройства отключены', (await fails(() => A.sync())) === 404 && (await fails(() => B.sync())) === 404 && N.u('Remember')?.note === 'моя нотатка');
});

await scenario('голос личности: отзыв с одного устройства без второго', async () => {
  const A = await device('комп'), B = await device('телефон'), Other = await device('чужой');
  await A.create(); await B.attach(A.key);
  for (const d of [A, B, Other]) await call('POST', '/vote', { user: 'Target_Q', tags: ['орк', 'зрадойоб'] }, d.token);
  await call('POST', '/complain', { user: 'Target_Q', thing: 't1_q', sub: 'tjournal_refugees' }, A.token);
  await call('POST', '/complain', { user: 'Target_Q', thing: 't1_q', sub: 'tjournal_refugees' }, B.token);
  await call('POST', '/complain', { user: 'Target_Q', thing: 't1_q', sub: 'tjournal_refugees' }, Other.token);
  // комп выключен; на телефоне сняли «орк» и жалобу
  await call('POST', '/vote', { user: 'Target_Q', tags: ['зрадойоб'] }, B.token);
  await call('POST', '/complain', { user: 'Target_Q', thing: 't1_q', undo: true }, B.token);
  const mine = (t) => sq.prepare(`SELECT tag FROM votes WHERE user = 'target_q' AND member IN (SELECT token_hash FROM sync_devices) ORDER BY tag`).all().map((r) => r.tag);
  ok('снятая на телефоне метка сразу снята и у компа (голос личности)', JSON.stringify(mine()) === JSON.stringify(['зрадойоб']), JSON.stringify(mine()));
  const cq = sq.prepare(`SELECT COUNT(*) n FROM complaints WHERE user = 'target_q' AND member IN (SELECT token_hash FROM sync_devices)`).get().n;
  ok('отозванная на телефоне жалоба сразу снята и с компа', cq === 0);
  ok('  чужие голоса и жалобы не тронуты', sq.prepare(`SELECT COUNT(*) n FROM votes WHERE user = 'target_q' AND member NOT IN (SELECT token_hash FROM sync_devices)`).get().n === 2
    && sq.prepare(`SELECT COUNT(*) n FROM complaints WHERE user = 'target_q' AND member NOT IN (SELECT token_hash FROM sync_devices)`).get().n === 1);
  const L = await call('POST', '/vote', { user: 'Solo', tags: ['орк'] }, Other.token);
  ok('  без синхронизации голос работает как раньше', L.ok && sq.prepare("SELECT COUNT(*) n FROM votes WHERE user = 'solo'").get().n === 1);
});

await scenario('смена ключа и число устройств не меняют общий счёт', async () => {
  const A = await device('A'), B = await device('B'), P2 = await device('другой довірений');
  const acct = 'd'.repeat(64), acct2 = 'e'.repeat(64);
  const ENV2 = ENV; ENV2.TRUST_TAG_MIN = '2'; ENV2.TRUST_COMPLAINT_MIN = '2';
  const toks = sq.prepare('SELECT token_hash FROM members ORDER BY rowid').all().map((r) => r.token_hash);
  sq.prepare('UPDATE members SET acct = ? WHERE token_hash = ?').run(acct, toks[0]);
  sq.prepare('UPDATE members SET acct = ? WHERE token_hash = ?').run(acct2, toks[2]);
  for (const x of [acct, acct2]) sq.prepare("INSERT INTO trusted (acct, by, granted, revoked) VALUES (?, 'auto', 0, NULL)").run(x);
  await A.create(); await B.attach(A.key);
  const look = async () => { const r = await call('POST', '/lookup', { users: ['target_k'] }, P2.token); return [r.users.target_k?.['орк'] || 0, r.complaints.target_k?.p || 0]; };
  // B (телефон) голосует и жалуется; потом его теряют
  await call('POST', '/vote', { user: 'Target_K', tags: ['орк'] }, B.token);
  await call('POST', '/complain', { user: 'Target_K', thing: 't1_k', sub: 'tjournal_refugees' }, B.token);
  await call('POST', '/vote', { user: 'Target_K', tags: ['орк'] }, P2.token);
  await call('POST', '/complain', { user: 'Target_K', thing: 't1_k2', sub: 'tjournal_refugees' }, P2.token);
  const before = await look();
  ok('до смены ключа: 2 аккаунта = метка 2, жалобы 2', JSON.stringify(before) === '[2,2]', JSON.stringify(before));
  await A.rotate();
  ok('после смены ключа счёт не изменился (принятые голоса отключённого телефона остаются)', JSON.stringify(await look()) === '[2,2]', JSON.stringify(await look()));
  const s1 = await fails(() => call('POST', '/vote', { user: 'Other_T', tags: ['орк'] }, B.token));
  const s2 = await fails(() => call('POST', '/complain', { user: 'Other_T', thing: 't1_o', sub: 'x' }, B.token));
  ok('  отключённый телефон новых голосов и жалоб не шлёт (403)', s1 === 403 && s2 === 403, s1 + ' ' + s2);
  const C = await device('C'); await C.attach(A.key); const D = await device('D'); await D.attach(A.key);
  await call('POST', '/vote', { user: 'Target_K', tags: ['орк'] }, C.token);
  ok('больше устройств у личности — счёт тот же', JSON.stringify(await look()) === '[2,2]', JSON.stringify(await look()));
  await call('POST', '/vote', { user: 'Target_K', tags: [] }, A.token); // владелец снял метку с компа
  await call('POST', '/complain', { user: 'Target_K', thing: 't1_k', undo: true }, A.token);
  const left = (t) => sq.prepare(`SELECT m.acct a, COUNT(*) n FROM ${t} x JOIN members m ON m.token_hash = x.member WHERE x.user = 'target_k' GROUP BY m.acct ORDER BY m.acct`).all().map((r) => r.a[0] + r.n).join(',');
  ok('личность снимает голос — снят и голос отключённого телефона; чужой остался (порог 2 → метка скрыта)', left('votes') === 'e1' && left('complaints') === 'e1' && JSON.stringify(await look()) === '[0,0]', left('votes') + ' / ' + left('complaints'));
  await B.attach(A.key);
  ok('  телефон ввёл новый ключ — снова может голосовать', (await call('POST', '/vote', { user: 'Other_T', tags: ['орк'] }, B.token)).ok === true);
});

await scenario('лимиты: новые ключи и объём', async () => {
  const A = await device('A');
  for (let i = 0; i < 3; i++) await A.create();
  ok('4-й новый ключ за сутки с одной установки — 429', (await fails(() => A.create())) === 429);
  ok('  у прежних личностей (устройство было одно) данные удалены, ключ не действует', sq.prepare("SELECT COUNT(*) n FROM sync_ident WHERE auth_hash NOT LIKE 'dead:%'").get().n === 1);
  const big = 'A'.repeat(15000);
  const f = (i) => (i.toString(16).padStart(32, '0'));
  let st = 0;
  for (let b = 0; b < 2 && !st; b++) st = await fails(() => A.api('/sync/push', { since: 0, items: Array.from({ length: 400 }, (_, i) => ({ f: f(b * 400 + i), base: 0, d: big })) }));
  ok('больше 5 МБ шифротекста на личность — 413', st === 413, String(st));
});

await scenario('проверка входа', async () => {
  const A = await device('A');
  ok('без настройки — pull отклонён (404)', (await fails(() => A.api('/sync/pull', { since: 0 }))) === 404);
  ok('неверный auth — 400', (await fails(() => A.api('/sync/attach', { auth: 'zz' }))) === 400);
  ok('случайный ключ — 403', (await fails(async () => A.attach(S.genKey()))) === 403);
  await A.create();
  ok('чужие поля: неверный id поля — 400', (await fails(() => A.api('/sync/push', { since: 0, items: [{ f: '../x', base: 0, d: 'AAAA' }] }))) === 400);
  ok('без токена — 401', (await fails(() => call('POST', '/sync/pull', { since: 0 }))) === 401);
});

console.log(bad ? `\nОШИБОК: ${bad}` : '\nВсе проверки синхронизации пройдены.');
process.exit(bad ? 1 : 0);
