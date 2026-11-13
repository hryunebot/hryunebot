// Хрюнебот: тесты довірених (WISHLIST п.14) на сервере — SQLite вместо D1, архив подменён. Запуск: node tools/trust-check.mjs
// Каждый сценарий — со СВОЕЙ чистой базой, очередью заявок и подменой архива (fresh): заявки одного сценария
// не могут занять запуск в другом.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, copyFileSync, rmSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRV = fileURLToPath(new URL('../server/', import.meta.url));
const TMPD = join(tmpdir(), 'hryu-trust-' + process.pid);
mkdirSync(TMPD, { recursive: true });
for (const f of readdirSync(join(SRV, 'src'))) copyFileSync(join(SRV, 'src', f), join(TMPD, f));
writeFileSync(join(TMPD, 'package.json'), '{"type":"module"}');
const srv = (await import(pathToFileURL(join(TMPD, 'index.js')).href)).default;
const aq = await import(pathToFileURL(join(TMPD, 'autoqueue.js')).href);
const { trustComplaintMin, trustTagMin } = await import(pathToFileURL(join(TMPD, 'trust.js')).href);
process.on('exit', () => { try { rmSync(TMPD, { recursive: true, force: true }); } catch { /* ignore */ } });

const SCHEMA = readFileSync(join(SRV, 'schema.sql'), 'utf8');
const ADMIN = 'test-key-0123456789';
const H = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('admin:' + ADMIN))).toString('hex');
class St { constructor(db, q) { this.db = db; this.q = q; this.a = []; } bind(...a) { this.a = a; return this; }
  _p() { return this.db.prepare(this.q); }
  async first() { return this._p().get(...this.a) ?? null; } async all() { return { results: this._p().all(...this.a) }; }
  async run() { const r = this._p().run(...this.a); return { meta: { changes: r.changes } }; } }

// состояние сценария — пересоздаётся в fresh()
let sq, DB, ENV, comments, verdict, archDown, downFor, clock;
const fresh = () => {
  sq = new DatabaseSync(':memory:');
  sq.exec(SCHEMA);
  sq.exec("INSERT OR IGNORE INTO groups (id, name, code, min_votes, created) VALUES ('public', 'Загальний', 'public', 2, 0)");
  sq.prepare('INSERT INTO admin (id,key_hash) VALUES (1,?)').run(H);
  const db = sq;
  DB = { prepare: (q) => new St(db, q), batch: async (ss) => Promise.all(ss.map((s) => (/^\s*SELECT/i.test(s.q) ? s.all() : s.run()))) };
  ENV = { DB, TRUST_SECRET: 'test-trust-secret-0123456789', TRUST_TAG_MIN: '2', TRUST_COMPLAINT_MIN: '2', AUTOQUEUE: 'test' };
  comments = {}; // ник(lower) → [{ body, subreddit, created_utc }]
  verdict = {}; // ник(lower) → { tags, ev } — что «вернёт» проверка ника
  archDown = false; downFor = new Set(); // весь архив / архив по отдельным авторам не отвечает
  clock = Date.now();
};
let ip = 0;
const call = async (m, p, b, hd = {}, env = ENV) => { const r = await srv.fetch(new Request('http://x' + p, { method: m, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.' + (++ip >> 8 & 255) + '.' + (ip & 255) + '.1', ...hd }, body: b ? JSON.stringify(b) : undefined }), env); return [r.status, await r.json()]; };
let bad = 0; const ok = (d, c, extra = '') => { if (!c) bad++; console.log((c ? 'ok ' : 'FAIL') + '  ' + d + (extra ? ' — ' + extra : '')); };
const scenario = async (name, fn) => { fresh(); console.log('\n# ' + name); await fn(); };
const A = (t) => ({ authorization: 'Bearer ' + t }), K = { 'x-admin-key': ADMIN };
const join_ = async () => (await call('POST', '/join', { code: 'public' }))[1].token;
const fetchMock = async (u) => {
  u = String(u);
  const a = decodeURIComponent((u.match(/author=([^&]+)/) || [])[1] || '').toLowerCase();
  if (archDown || downFor.has(a)) return new Response('{"error":"Timeout. Maybe slow down a bit"}', { status: 500 });
  const data = (comments[a] || []).slice().sort((x, y) => y.created_utc - x.created_utc);
  return new Response(JSON.stringify({ data }), { status: 200 });
};
const svij = { tags: ['clean'], ev: { home: { up: 150, down: 5 } } };
const notSvij = { tags: ['clean'], ev: { home: { up: 3, down: 0 } } };
const trustCheck = async (nick) => { const v = verdict[nick.toLowerCase()]; if (!v) throw new Error('нет данных'); return v; };
const tick = (min = 3) => (clock += min * 60e3); // запуски идут не чаще recheck (2 мин)
const run = (now = tick()) => aq.runAutoQueue(DB, ENV, { now, fetch: fetchMock, trustCheck });
const postCode = (nick, code, sub = 'tjournal_refugees') => { (comments[nick.toLowerCase()] ??= []).push({ body: 'привіт ' + code + ' :)', subreddit: sub, created_utc: Math.floor(Date.now() / 1000) + 5 }); };
const status = async (t) => (await call('GET', '/trust/status', null, A(t)))[1];
const start = async (t, nick) => (await call('POST', '/trust/start', { nick }, A(t)))[1];
const vote = (t, user, tags) => call('POST', '/vote', { user, tags }, A(t));
const lookup = async (t, users) => (await call('POST', '/lookup', { users }, A(t)))[1];
// заявка + коммент с кодом + ОДИН запуск: в чистой очереди этого достаточно
const trustNick = async (t, nick, v = svij) => {
  const r = await start(t, nick); const n = nick.replace(/^u\//i, '').toLowerCase();
  verdict[n] ??= v; postCode(n, r.code); await run(); return status(t);
};
const trustedIds = () => sq.prepare('SELECT DISTINCT acct FROM members WHERE acct IS NOT NULL').all();

await scenario('без секрета довіра выключена', async () => {
  const [s, r] = await call('POST', '/trust/start', { nick: 'Good_Guy' }, A(await join_()), { DB });
  ok('без секрета сервера — 503, довіра не включена', s === 503, JSON.stringify(r));
});

await scenario('заявка → автоматическое подтверждение', async () => {
  const tA = await join_();
  const [s, r] = await call('POST', '/trust/start', { nick: 'u/Good_Guy' }, A(tA));
  ok('заявка: код выдан, «в ожидании», срок 3 суток', s === 200 && /^hryu-[a-z2-9]{10}$/.test(r.code) && r.status === 'pending' && r.expires - Date.now() > 71 * 3600e3, JSON.stringify(r));
  ok('  статус — pending с тем же кодом', (await status(tA)).code === r.code);
  verdict.good_guy = svij;
  let rr = await run();
  ok('коммента ещё нет — остаётся в ожидании', rr.trust && rr.trust.pending && (await status(tA)).status === 'pending', JSON.stringify(rr.trust));
  postCode('Good_Guy', r.code, 'AskReddit');
  rr = await run();
  ok('коммент с кодом не в tj — не засчитан', (await status(tA)).status === 'pending', JSON.stringify(rr.trust));
  postCode('Good_Guy', r.code);
  rr = await run();
  const st = await status(tA);
  ok('коммент с кодом в tj + «свій» без плохих меток → довірений (auto)', st.status === 'trusted' && st.by === 'auto', JSON.stringify(rr.trust));
  ok('  ник не хранится: заявка удалена, в статусе ника нет', sq.prepare('SELECT COUNT(*) n FROM trust_pending').get().n === 0
    && !JSON.stringify(sq.prepare('SELECT * FROM trust_status').all()).toLowerCase().includes('good_guy'));
  const ids = trustedIds();
  ok('  установка привязана к id аккаунта (HMAC, 64 hex, не ник)', ids.length === 1 && /^[0-9a-f]{64}$/.test(ids[0].acct) && !ids[0].acct.includes('good'));
});

await scenario('две установки одного аккаунта', async () => {
  const tA = await join_(), tB = await join_(), tC = await join_();
  await trustNick(tA, 'u/Good_Guy');
  const st = await trustNick(tB, 'GOOD_GUY');
  ok('2-я установка (регистр, u/) — тот же id, одна запись довіри', st.status === 'trusted' && trustedIds().length === 1 && sq.prepare('SELECT COUNT(*) n FROM trusted').get().n === 1, JSON.stringify(st));
  await trustNick(tC, 'Second_Guy');
  await vote(tA, 'Target_X', ['орк']); await vote(tB, 'Target_X', ['орк']);
  const L = await lookup(tA, ['target_x']);
  ok('2 установки одного аккаунта = 1 голос (порог 2 не пройден)', !(L.users.target_x && L.users.target_x['орк']), JSON.stringify(L.users));
});

await scenario('общие метки: только довірені, снятие голоса', async () => {
  const tA = await join_(), tC = await join_(), tD = await join_();
  await trustNick(tA, 'Good_Guy'); await trustNick(tC, 'Second_Guy');
  await vote(tA, 'Target_X', ['орк']); await vote(tD, 'Target_X', ['орк']); // tD — не довірений
  let L = await lookup(tD, ['target_x']);
  ok('недовірений голос не считается (2 голоса, из них довірений 1)', !(L.users.target_x && L.users.target_x['орк']));
  await vote(tC, 'Target_X', ['орк']);
  L = await lookup(tD, ['target_x']);
  ok('2 разных довірених аккаунта → общая метка видна (порог 2)', L.users.target_x && L.users.target_x['орк'] === 2, JSON.stringify(L.users));
  ok('  порог отдаётся клиенту', L.minVotes === 2 && L.trusted === true);
  await vote(tC, 'Target_X', []);
  L = await lookup(tD, ['target_x']);
  ok('пользователь снял свой голос — общая метка пересчитана (пропала)', !(L.users.target_x && L.users.target_x['орк']));
});

await scenario('жалобы: только довірені, по аккаунтам', async () => {
  const tA = await join_(), tB = await join_(), tC = await join_(), tD = await join_();
  await trustNick(tA, 'Good_Guy'); await trustNick(tB, 'Good_Guy'); await trustNick(tC, 'Second_Guy');
  const cmp = (t, thing) => call('POST', '/complain', { user: 'Target_Y', thing, sub: 'tjournal_refugees' }, A(t));
  const sts = [(await cmp(tA, 't1_a'))[0], (await cmp(tB, 't1_b'))[0], (await cmp(tD, 't1_d'))[0]];
  ok('жалоба принимается (200) — регрессия «env is not defined»', sts.every((x) => x === 200), JSON.stringify(sts));
  let L = await lookup(tD, ['target_y']);
  ok('1 аккаунт (2 установки) + недовірений — не видны', !L.complaints.target_y);
  await cmp(tC, 't1_c');
  L = await lookup(tD, ['target_y']);
  ok('2 довірених аккаунта — видны', L.complaints.target_y && L.complaints.target_y.p === 2, JSON.stringify(L.complaints));
});

await scenario('отзыв доверия владельцем и возврат', async () => {
  const tA = await join_(), tC = await join_(), tD = await join_();
  await trustNick(tA, 'Good_Guy'); await trustNick(tC, 'Second_Guy');
  await vote(tA, 'Target_X', ['орк']); await vote(tC, 'Target_X', ['орк']);
  for (const [t, th] of [[tA, 't1_a'], [tC, 't1_c']]) await call('POST', '/complain', { user: 'Target_Y', thing: th, sub: 'tjournal_refugees' }, A(t));
  let [s, r] = await call('POST', '/admin/trust/revoke', { user: 'Second_Guy' });
  ok('отзыв без ключа — 403', s === 403);
  [s, r] = await call('POST', '/admin/trust/revoke', { user: 'second_guy' }, K);
  let L = await lookup(tD, ['target_x', 'target_y']);
  ok('отозвал → голоса и жалобы перестали считаться', s === 200 && r.revoked === 1 && !(L.users.target_x && L.users.target_x['орк']) && !L.complaints.target_y, JSON.stringify(L));
  ok('  статус у пользователя — revoked', (await status(tC)).status === 'revoked');
  await call('POST', '/admin/trust/grant', { user: 'Second_Guy' }, K);
  L = await lookup(tD, ['target_x']);
  ok('вернул доверие — голос снова считается', L.users.target_x && L.users.target_x['орк'] === 2);
});

await scenario('отказ: не «свій»', async () => {
  const st = await trustNick(await join_(), 'Not_Svij', notSvij);
  ok('не «свій» → отказ с причиной, без привязки к аккаунту', st.status === 'denied' && /свой/.test(st.reason || '') && trustedIds().length === 0, JSON.stringify(st));
});

await scenario('отказ: плохая автометка', async () => {
  const st = await trustNick(await join_(), 'Ork_Svij', { tags: ['ork'], ev: { home: { up: 150, down: 5 } } });
  ok('«свій», но есть плохая метка (орк) → отказ', st.status === 'denied' && /ork/.test(st.reason || ''), JSON.stringify(st));
});

await scenario('ручной допуск по нику', async () => {
  await call('POST', '/admin/trust/grant', { user: 'Not_Svij' }, K);
  const st = await trustNick(await join_(), 'Not_Svij', notSvij);
  ok('ручной допуск владельца — довірений, даже не «свій» (by manual)', st.status === 'trusted' && st.by === 'manual', JSON.stringify(st));
});

await scenario('чужие ручные метки допуск не блокируют', async () => {
  const tM = await join_(), tX = await join_();
  await vote(tX, 'Manual_Hated', ['орк', 'зрадойоб']);
  ok('чужие ручные метки (орк, зрадойоб) не блокируют — решает только автопроверка', (await trustNick(tM, 'Manual_Hated')).status === 'trusted');
});

await scenario('пороги', async () => {
  ok('по умолчанию: метка 3, жалобы 3 (оба — настройки, без автороста)', trustTagMin({}) === 3 && trustComplaintMin({}) === 3 && trustComplaintMin({ TRUST_COMPLAINT_MIN: '7' }) === 7 && trustTagMin({ TRUST_TAG_MIN: '12' }) === 12);
});

await scenario('старый код после новой заявки', async () => {
  const tH = await join_();
  const old = (await start(tH, 'Code_Reuse')).code;
  verdict.code_reuse = svij; postCode('Code_Reuse', old);
  const r = await start(tH, 'Code_Reuse');
  await run();
  ok('старый код не засчитывается', r.code !== old && (await status(tH)).status === 'pending');
});

await scenario('код, написанный чужим аккаунтом', async () => {
  const tI = await join_();
  const r = await start(tI, 'Someone_Else'); verdict.someone_else = svij;
  postCode('Code_Reuse', r.code);
  await run();
  ok('код от ДРУГОГО аккаунта не подтверждает заявку', (await status(tI)).status === 'pending');
});

await scenario('архив не отвечает, срок кода', async () => {
  const tH = await join_();
  await start(tH, 'Lag_Guy'); verdict.lag_guy = svij;
  archDown = true;
  const rr = await run();
  ok('архив не ответил — заявка остаётся в ожидании (не отказ)', (await status(tH)).status === 'pending' && rr.trust && rr.trust.error === 'archive', JSON.stringify(rr.trust));
  archDown = false;
  await run(Date.now() + 73 * 3600e3);
  ok('срок кода (3 суток) истёк — заявка удалена вместе с ником', !sq.prepare("SELECT 1 FROM trust_pending WHERE nick = 'lag_guy'").get());
});

await scenario('ожидающая архив заявка не блокирует остальные', async () => {
  const tS = await join_(), tO = await join_(), tT = await join_();
  sq.prepare("INSERT INTO queue (user, name, first, last, reports, status) VALUES ('queued_nick', 'Queued_Nick', ?, ?, 1, 'new')").run(Date.now(), Date.now());
  await start(tS, 'Stuck_Lag'); verdict.stuck_lag = svij; downFor.add('stuck_lag'); // по этому автору архив всё время падает
  const rO = await start(tO, 'Other_Ok'); verdict.other_ok = svij; postCode('Other_Ok', rO.code);
  const r1 = await run(), r2 = await run();
  ok('1-й запуск взял старую заявку (архив упал), 2-й — следующую: она подтверждена', r1.trust.error === 'archive' && (await status(tO)).status === 'trusted', JSON.stringify([r1.trust, r2.trust]));
  const rT = await start(tT, 'Third_Ok'); verdict.third_ok = svij; postCode('Third_Ok', rT.code);
  await run();
  ok('новая заявка проверяется раньше повторов застрявшей (за один запуск)', (await status(tT)).status === 'trusted');
  for (let i = 0; i < 3; i++) await run();
  const sp = sq.prepare("SELECT tries FROM trust_pending WHERE nick = 'stuck_lag'").get();
  ok('  застрявшая не потеряна: ждёт, попытки считаются', (await status(tS)).status === 'pending' && sp && sp.tries >= 2, JSON.stringify(sp));
  ok('очередь ников обрабатывается в тех же запусках (заявки ей не мешают)', !!sq.prepare("SELECT 1 FROM autoqueue_test WHERE user = 'queued_nick'").get());
});

await scenario('п.4: отзыв не обходится новой установкой', async () => {
  await trustNick(await join_(), 'Good_Guy');
  await call('POST', '/admin/trust/revoke', { user: 'Good_Guy' }, K);
  const tN = await join_();
  const st = await trustNick(tN, 'Good_Guy');
  ok('новая установка отозванного аккаунта → «відкликано», а не довірений', st.status === 'revoked', JSON.stringify(st));
  await vote(tN, 'Target_Z', ['орк']);
  const cnt = sq.prepare(`SELECT COUNT(DISTINCT m.acct) n FROM votes v JOIN members m ON m.token_hash = v.member JOIN trusted t ON t.acct = m.acct AND t.revoked IS NULL WHERE v.user = 'target_z'`).get().n;
  ok('  её голос не считается', cnt === 0);
  await call('POST', '/admin/trust/grant', { user: 'Good_Guy' }, K);
  ok('  снять запрет может только владелец (вернул — довірений)', (await status(tN)).status === 'trusted');
});

await scenario('п.3: ручное подтверждение по коду', async () => {
  const tP = await join_(), tQ = await join_();
  const cP = (await start(tP, 'Friend_Lag')).code;
  await start(tQ, 'u/friend_lag'); // кто-то ещё заявил тот же ник
  const [, d] = await call('GET', '/admin/trust', null, K);
  ok('админка: заявки видны с ником и КОДОМ каждой', d.requests.filter((x) => x.nick === 'friend_lag').length === 2 && d.requests.every((x) => /^hryu-/.test(x.code)), JSON.stringify(d.requests));
  const [s2, a2] = await call('POST', '/admin/trust/approve', { code: cP }, K);
  ok('довірена ТОЛЬКО установка с этим кодом', s2 === 200 && a2.linked === 1 && (await status(tP)).status === 'trusted' && (await status(tQ)).status === 'pending', JSON.stringify(a2));
  ok('  её заявка (с ником) удалена', !sq.prepare('SELECT 1 FROM trust_pending WHERE code = ?').get(cP));
  const [s4] = await call('POST', '/admin/trust/approve', { code: 'hryu-nonexisting' }, K);
  ok('  неизвестный код — 404', s4 === 404);
  const [s3] = await call('POST', '/admin/trust/approve', { code: cP });
  ok('  без ключа — 403', s3 === 403);
});

await scenario('п.5: один аккаунт — один голос (жалобы и метки)', async () => {
  const tP2 = await join_(), tQ2 = await join_();
  await trustNick(tP2, 'Two_Dev');
  ok('второе устройство того же аккаунта подтверждено за один запуск', (await trustNick(tQ2, 'Two_Dev')).status === 'trusted');
  const c2 = (t) => call('POST', '/complain', { user: 'Target_W', thing: 't1_same', sub: 'tjournal_refugees' }, A(t));
  await c2(tP2); await c2(tQ2); await c2(tQ2); // второе устройство + повтор после «сетевой ошибки»
  await call('POST', '/complain', { user: 'Target_W', thing: 't1_other', sub: 'tjournal_refugees', reason: 'зрадойоб' }, A(tP2));
  const [, lw] = await call('POST', '/lookup', { users: ['target_w'] }, A(tP2), { ...ENV, TRUST_COMPLAINT_MIN: '1' });
  ok('2 устройства, повтор, 2 разных коммента/причины = ОДИН голос (n = p = 1)', lw.complaints.target_w && lw.complaints.target_w.n === 1 && lw.complaints.target_w.p === 1, JSON.stringify(lw.complaints));
  ok('  причины и комменты сохранены', sq.prepare("SELECT COUNT(*) n FROM complaints WHERE user = 'target_w'").get().n === 3);
  await vote(tP2, 'Target_V', ['орк']); await vote(tQ2, 'Target_V', ['орк', 'зрадойоб']); await vote(tQ2, 'Target_V', ['орк', 'зрадойоб']);
  const vv = sq.prepare(`SELECT v.tag, COUNT(DISTINCT m.acct) c FROM votes v JOIN members m ON m.token_hash = v.member WHERE v.user = 'target_v' GROUP BY v.tag ORDER BY v.tag`).all();
  ok('разные метки с двух устройств: объединение, каждая — 1 голос; повтор не удваивает', JSON.stringify(vv) === JSON.stringify([{ tag: 'зрадойоб', c: 1 }, { tag: 'орк', c: 1 }]), JSON.stringify(vv));
});

await scenario('п.7: лимит заявок с одной установки', async () => {
  const tL = await join_();
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await call('POST', '/trust/start', { nick: 'Spam_Req' + i }, A(tL)))[0];
  ok('6-я заявка за сутки — 429', last === 429);
});

await scenario('админка', async () => {
  await trustNick(await join_(), 'Good_Guy'); await trustNick(await join_(), 'Good_Guy'); await trustNick(await join_(), 'Second_Guy');
  let [s, r] = await call('GET', '/admin/trust');
  ok('список довірених без ключа — 403', s === 403);
  [s, r] = await call('GET', '/admin/trust', null, K);
  ok('только короткие id, без ников; число устройств', s === 200 && r.trusted.length === 2 && r.trusted.every((x) => /^[0-9a-f]{8}$/.test(x.id)) && !JSON.stringify(r).toLowerCase().includes('good_guy') && r.trusted.some((x) => x.devices === 2), JSON.stringify(r.trusted));
});

console.log(bad ? `\nОШИБОК: ${bad}` : '\nВсе проверки довірених пройдены.');
process.exit(bad ? 1 : 0);
