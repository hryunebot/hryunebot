// Хрюнебот: массовая проверка ников из dist/crawl/authors.json — ТОЛЬКО через архив ArcticShift (reddit не трогаем).
// Тот же код, что в расширении (score.js + запросы архива из background.js), поэтому вердикты те же, что в окне ника.
// Результаты: dist/crawl/verdicts.json; с ключом админа — ещё и на сервер (общий слой, 30 дней).
//
// Запуск:  node tools/check-tj.mjs [--limit 200] [--pause 30] [--dry]
//   --dry   — только посчитать, на сервер не отправлять
//   --resend — сначала отправить на сервер уже посчитанное раньше (например, после пробного --dry)
//   --shard 0/2 — проверять только свою часть списка (для двух окон: 0/2 и 1/2), результаты — в свой файл
// Ключ админа: переменная окружения HRYU_ADMIN_KEY или файл admin-key.txt рядом с проектом (не в git).
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { publishDecision, newestBackup } from './publish-guard.mjs';

const ROOT = new URL('../', import.meta.url);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const LIMIT = +arg('limit', 200);
const PAUSE = +arg('pause', 2) * 1000; // архив сам скажет «slow down» — тогда background.js подождёт до сброса
const DRY = process.argv.includes('--dry');
const RESEND = process.argv.includes('--resend');
const SERVER = 'https://reddit-tagger.reddit-tagger-server.workers.dev';
const HOME = ['tjournal_refugees'];
const DAY = 86400000;

// Код расширения в песочнице: score.js (вердикты) + background.js (запросы к архиву)
const noop = { addListener() {} };
const ctx = { URL, fetch, setTimeout, console, AbortSignal, chrome: { action: { onClicked: noop }, runtime: { onMessage: noop, getManifest: () => ({ version: 'script' }) }, storage: { local: { get: async () => ({}) } } } };
// ---------- общий ограничитель запросов к архиву для всех окон ----------
// --parallel N — сколько запросов к архиву одновременно по ВСЕМ окнам вместе (по умолчанию 2, как у двух окон).
// Слоты — файлы-замки в dist/crawl/gate; после «slow down»/429 пишется gate/pause.json и новые разрешения
// не выдаются никому до этого времени.
const PAR = Math.max(1, +arg('parallel', 2));
const GATE = new URL('../dist/crawl/gate/', import.meta.url);
mkdirSync(GATE, { recursive: true });
const PAUSE_F = new URL('pause.json', GATE);
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
// Файловые замки: создаём файл эксклюзивно ('wx'); «зависший» (окно упало) старше 60 с — снимаем.
const tryLock = (f) => {
  try { closeSync(openSync(f, 'wx')); return true; } catch {
    try { if (Date.now() - statSync(f).mtimeMs > 60000) unlinkSync(f); } catch { /* занят другим окном */ }
    return false;
  }
};
const unlock = (f) => { try { unlinkSync(f); } catch { /* уже снят */ } };
const readJ = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const INTERVAL = Math.max(0, +arg('interval', 1000)); // мс между запусками запросов по всем окнам вместе
const SOFT_F = new URL('soft.json', GATE), LAST_F = new URL('last.json', GATE), TICK = new URL('tick.lock', GATE), PROBE = new URL('probe.lock', GATE);
ctx.archGate = {
  held: null, probe: false,
  async acquire() {
    for (;;) {
      const st = readJ(PAUSE_F, { until: 0, strikes: 0 });
      // 1) общая пауза после «slow down»/429 — ждут все окна
      if (st.until > Date.now()) { await nap(Math.min(st.until - Date.now() + 100, 60000)); continue; }
      // 2) после паузы с ошибками пропускаем ОДИН пробный запрос; остальные ждут его результата
      let probe = false;
      if (st.strikes > 0) { if (!tryLock(PROBE)) { await nap(500); continue; } probe = true; }
      // 3) не больше PAR запросов одновременно
      let slot = null;
      for (let i = 0; i < PAR && !slot; i++) { const f = new URL('slot' + i + '.lock', GATE); if (tryLock(f)) slot = f; }
      if (!slot) { if (probe) unlock(PROBE); await nap(150 + Math.random() * 150); continue; }
      // 4) частота: не чаще одного запуска в INTERVAL мс по всем окнам
      if (!tryLock(TICK)) { unlock(slot); if (probe) unlock(PROBE); await nap(50 + Math.random() * 100); continue; }
      const last = readJ(LAST_F, { t: 0 }).t;
      const gap = last + INTERVAL - Date.now();
      if (gap > 0) { unlock(TICK); unlock(slot); if (probe) unlock(PROBE); await nap(gap + Math.random() * 50); continue; }
      try { writeFileSync(LAST_F, JSON.stringify({ t: Date.now() })); } finally { unlock(TICK); }
      this.held = slot; this.probe = probe;
      return;
    }
  },
  release() {
    if (this.held) { unlock(this.held); this.held = null; }
    if (this.probe) { unlock(PROBE); this.probe = false; }
  },
  // «Timeout» на одном запросе — не повод останавливать всех. Два таймаута за 30 с (в любых окнах) — уже похоже
  // на перегрузку архива: общая пауза с пробным запросом.
  soft() {
    const st = readJ(SOFT_F, { n: 0, t: 0 });
    const n = Date.now() - st.t < 30000 ? st.n + 1 : 1;
    try { writeFileSync(SOFT_F, JSON.stringify({ n: n >= 2 ? 0 : n, t: Date.now() })); } catch { /* другое окно пишет */ }
    if (n >= 2) this.block(0);
  },
  // Архив ответил нормально — сбрасываем серию ошибок (если была), очередь идёт дальше.
  ok() { if (readJ(PAUSE_F, { strikes: 0 }).strikes > 0) { try { unlinkSync(PAUSE_F); } catch { /* уже снято */ } } },
  // «slow down» / 429: at — когда сбросится лимит по словам архива (0 — неизвестно).
  // Неизвестно — пауза растёт с каждой ошибкой подряд: 5, 10, 20, 40… с, не больше 2 минут.
  block(at) {
    const st = readJ(PAUSE_F, { until: 0, strikes: 0 });
    const strikes = (st.strikes || 0) + 1;
    const until = at > Date.now() ? at + 500 : Date.now() + Math.min(5000 * 2 ** (strikes - 1), 120000);
    try { writeFileSync(PAUSE_F, JSON.stringify({ until: Math.max(until, st.until || 0), strikes })); } catch { /* другое окно пишет */ }
    console.log(`  ⏸ архив просит подождать — все окна ждут ${Math.round((Math.max(until, st.until || 0) - Date.now()) / 1000)} с`);
  },
};
process.on('exit', () => ctx.archGate.release());
process.on('SIGINT', () => { ctx.archGate.release(); process.exit(130); });
vm.createContext(ctx);
for (const f of ['i18n.js', 'score.js', 'background.js']) vm.runInContext(readFileSync(new URL('reddit-tagger/' + f, ROOT), 'utf8'), ctx);

const AUTH = new URL('dist/crawl/authors.json', ROOT);
// Два окна: каждое берёт свою часть списка и пишет в свой файл (чтобы не затирать друг друга).
// --plan N   — подготовить раздачу на N окон (убрать дубли и уже сохранённых на сервере) и выйти
// --worker i — окно номер i берёт свою часть из dist/crawl/plan.json
const PLAN = +arg('plan', 0);
const FORCE = process.argv.includes('--force'); // с --plan: перепроверить всех, даже уже проверенных (правила поменялись)
const WORKER = arg('worker', '');
const SHARD = String(arg('shard', '')).match(/^(\d+)\/(\d+)$/);
const [SI, SN] = SHARD ? [+SHARD[1], +SHARD[2]] : [0, 1];
const DIRC = new URL('dist/crawl/', ROOT);
const OUT = new URL(WORKER !== '' ? `verdicts.w${+WORKER}.json` : SHARD ? `verdicts.s${SI}.json` : 'verdicts.json', DIRC);
if (!existsSync(AUTH)) { console.log('Нет dist/crawl/authors.json — сначала node tools/crawl-tj.mjs'); process.exit(1); }
// Ключ админа нужен заранее: режим очереди берёт ники с сервера.
let key = process.env.HRYU_ADMIN_KEY || '';
const keyFile = new URL('admin-key.txt', ROOT);
if (!key && existsSync(keyFile)) key = readFileSync(keyFile, 'utf8').trim();
// --queue — взять ники из очереди на сервере (их прислали расширения пользователей: проверили сами, на сервере вердикта нет).
//   --queue-errors — те, на которых архив в прошлый раз не ответил; --queue-stats — только показать статистику очереди.
//   Предварительные метки пользователей НЕ публикуются: публикуем только свою проверку через архив.
const QUEUE = process.argv.includes('--queue') || process.argv.includes('--queue-errors');
let queueNames = [];
if (QUEUE || process.argv.includes('--queue-stats')) {
  if (!key) { console.log('Для очереди нужен ключ админа (admin-key.txt или HRYU_ADMIN_KEY).'); process.exit(1); }
  const st = await (await fetch(SERVER + '/admin/queue/stats', { headers: { 'x-admin-key': key } })).json();
  console.log(`Очередь: всего ников ${st.total}, ждут проверки ${st.new}, проверено ${st.checked}, ошибок архива ${st.error}; ` +
    `присылок ${st.reports} от ${st.reporters} участников, дублей ${st.dup}; уже получили вердикт, пока ждали: ${st.newButKnown}`);
  if (!QUEUE) process.exit(0);
  const status = process.argv.includes('--queue-errors') ? 'error' : 'new';
  const q = await (await fetch(SERVER + `/admin/queue?status=${status}&limit=${Math.min(LIMIT, 1000)}`, { headers: { 'x-admin-key': key } })).json();
  queueNames = (q.queue || []).map((x) => x.name);
  console.log(`Беру из очереди (${status}): ${queueNames.length}` + (q.queue || []).slice(0, 10).map((x) => ` · ${x.name} [${x.pre.join('+')}] ×${x.reports}`).join(''));
}
// --users a,b,c — проверить только эти ники (например, присланные владельцем), даже если их нет в списке сборщика
const ONLY = QUEUE ? queueNames : String(arg('users', '')).split(',').map((x) => x.trim().replace(/^\/?u\//i, '')).filter(Boolean);
if (QUEUE && !ONLY.length) { console.log('Очередь пуста.'); process.exit(0); }
const authors = ONLY.length ? ONLY.map((name) => ({ name, minus: 0, comments: 0 })) : JSON.parse(readFileSync(AUTH, 'utf8')).authors;
// Уже проверенные — из всех файлов (общего и всех частей), пишем — только в свой.
const done = {};
for (const f of readdirSync(DIRC).filter((x) => /^verdicts(\.[sw]\d+)?\.json$/.test(x))) {
  // Берём САМЫЙ СВЕЖИЙ вердикт по каждому нику (по времени проверки), а не по порядку файлов: иначе старые
  // файлы прошлых прогонов перебивают новые (так на сервер уехали вердикты с багом «молчания»).
  try {
    for (const [k, x] of Object.entries(JSON.parse(readFileSync(new URL(f, DIRC), 'utf8')))) if (!done[k] || (x.t || 0) > (done[k].t || 0)) done[k] = x;
  } catch { /* битый файл — пропускаем */ }
}
const mine = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

if (!DRY && !key) console.log('Ключа админа нет — считаю без отправки на сервер (как --dry).');
// Очередь: на сервер — только с --publish и свежим бэкапом базы (tools/publish-guard.mjs); обычный режим — как раньше.
const PUBLISH = process.argv.includes('--publish');
const decision = publishDecision({ queue: QUEUE, publish: PUBLISH, dry: DRY, hasKey: !!key, backup: newestBackup(fileURLToPath(new URL('dist/backup/', ROOT))) });
if (QUEUE) console.log((decision.upload ? 'ОТПРАВКА НА СЕРВЕР: ' : 'Без отправки: ') + decision.reason);
const upload = decision.upload;

// Цифры «свій» для вердикта: оценки в tj, отдельно по комментам, и упёрлась ли история комментов в лимит (score.js homeStats)
const sumv = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
function homeEv(subs, votes, subsP, votesP) {
  const st = ctx.homeStats(votes, HOME, votesP, sumv(subs) - sumv(subsP));
  return { cUp: st.cUp, cDown: st.cDown, trunc: st.trunc };
}
// Вердикт по данным архива — общий с сервером (score.js archVerdict, 1.3.91)
function verdict(a) { return ctx.archVerdict(a, HOME, Date.now()); }

// Метки правил по сабам («👹 орк», «🤡 клоун»): код для сервера + цифры. Используется и при проверке,
// и при пересчёте по сохранённым сабам (--recompute).
const RULE_TAGS = ['ork', 'ork?', 'clown', 'clown?', 'watch', 'watch?', 'debater', 'deb_ork', 'deb_clown', 'deb_watch'];
// Расчёт — общий, в score.js (ruleVerdicts): так скрипт, расширение и тесты считают одинаково.
function ruleTags(raw) { return ctx.ruleVerdicts(raw.subs, raw.votes, HOME, raw.subsP, raw.votesP); }

async function send(items) {
  const r = await fetch(SERVER + '/admin/verdicts', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': key }, body: JSON.stringify({ items }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j.saved;
}

if (PLAN > 0) {
  // Кто уже на сервере (свежий вердикт) — не проверяем. Посчитанное локально, но не отправленное — досылаем.
  let onServer = new Set();
  if (key && !FORCE) {
    try {
      const r = await fetch(SERVER + '/admin/verdicts', { headers: { 'x-admin-key': key } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      onServer = new Set(j.verdicts.map((v) => String(v.name).toLowerCase()));
    } catch (e) { console.log('! не удалось получить список с сервера:', e.message); }
  }
  const local = FORCE ? [] : Object.values(done).filter((x) => Date.now() - x.t < 30 * DAY && !onServer.has(x.name.toLowerCase()));
  if (upload && local.length) {
    console.log(`Досылаю посчитанное, но не отправленное: ${local.length}…`);
    for (let i = 0; i < local.length; i += 20) {
      try { await send(local.slice(i, i + 20).map((x) => ({ user: x.name, tags: x.tags, evidence: x.ev, checked: x.t }))); local.slice(i, i + 20).forEach((x) => onServer.add(x.name.toLowerCase())); } catch (e) { console.log('  ! сервер:', e.message); }
    }
  }
  const seen = new Set();
  const rest = authors.filter((x) => {
    const k = x.name.toLowerCase();
    if (seen.has(k)) return false; // дубли
    seen.add(k);
    return FORCE || (!onServer.has(k) && !(done[k] && Date.now() - done[k].t < 30 * DAY));
  });
  const shards = Array.from({ length: PLAN }, (_, i) => rest.filter((_, j) => j % PLAN === i).map((x) => x.name));
  writeFileSync(new URL('plan.json', DIRC), JSON.stringify({ t: Date.now(), force: FORCE, shards }));
  try { unlinkSync(PAUSE_F); } catch { /* паузы нет */ }
  console.log(`На сервере уже: ${onServer.size}. Осталось проверить: ${rest.length} → по окнам: ${shards.map((x) => x.length).join(' / ')}`);
  process.exit(0);
}

// --delete Ник — снять вердикт с сервера (например, сервисного бота)
if (arg('delete', '')) {
  const r = await fetch(SERVER + '/admin/verdicts/delete', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': key }, body: JSON.stringify({ user: arg('delete', '') }) });
  console.log('снять вердикт:', r.status, await r.text());
  process.exit(0);
}

if (process.argv.includes('--recompute')) {
  // Пересчитываем «орка» у всех, у кого сохранены сабы, правим файлы на месте и отправляем изменившихся.
  // --all — отправить всех (например, чтобы вернуть на сервер настоящие даты сканирования, 1.3.89).
  // --dry — только посчитать: файлы не трогаем, на сервер не шлём.
  const ALL = process.argv.includes('--all'), DRY_RC = process.argv.includes('--dry');
  const changed = [], newest = {};
  for (const f of readdirSync(DIRC).filter((x) => /^verdicts(\.[sw]\d+)?\.json$/.test(x))) {
    const file = new URL(f, DIRC);
    let j; try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    for (const x of Object.values(j)) {
      if (!x.raw) continue;
      const before = x.tags.join('+');
      const rt = ruleTags(x.raw);
      x.tags = x.tags.filter((t) => !RULE_TAGS.includes(t) && t !== 'clean').concat(rt.tags);
      x.ev.ork = rt.ev.ork || x.ev.ork;
      x.ev.clown = rt.ev.clown || null;
      x.ev.watch = rt.ev.watch || null;
      // «мінусують» тоже пересчитываем по сохранённым оценкам (порог мог поменяться)
      const hv = ctx.homeVotes(x.raw.votes, HOME);
      x.tags = x.tags.filter((t) => t !== 'homedown');
      if (hv.hit) x.tags.push('homedown');
      x.ev.home = { up: hv.up, down: hv.down, eUp: hv.eUp, eDown: hv.eDown, ...homeEv(x.raw.subs, x.raw.votes, x.raw.subsP, x.raw.votesP) };
      if (x.tags.length > 1) x.tags = x.tags.filter((t) => t !== 'clean');
      if (!x.tags.length) x.tags.push('clean');
      if (!x.tags.length) x.tags.push('clean');
      x.ev.by = 'auto'; // файлы crawl — только скриптовые вердикты: «manual» отсюда не уходит никогда
      // один ник лежит в нескольких файлах (общий + шарды): на сервер — только САМАЯ СВЕЖАЯ запись ника
      const k = x.name.toLowerCase();
      if (!newest[k] || (x.t || 0) > (newest[k].x.t || 0)) newest[k] = { x, chg: x.tags.join('+') !== before };
    }
    if (!DRY_RC) writeFileSync(file, JSON.stringify(j));
  }
  for (const { x, chg } of Object.values(newest)) if ((chg || ALL) && !ctx.isServiceBot(x.name)) changed.push(x); // сервис-ботов не шлём
  console.log(`Пересчитано, изменилось: ${changed.length}`);
  changed.forEach((x) => console.log(`  ${x.name}: ${x.tags.join(', ')}`));
  if (upload) for (let i = 0; i < changed.length; i += 20) {
    try { console.log(`  → сервер: сохранено ${await send(changed.slice(i, i + 20).map((x) => ({ user: x.name, tags: x.tags, evidence: x.ev, checked: x.t })))}`); } catch (e) { console.log('  ! сервер:', e.message); }
  }
  process.exit(0);
}

if (RESEND && upload && SI === 0 && WORKER === '') { // повторную отправку делает только первое окно
  // Пересчитываем консерву по сохранённым цифрам — вдруг правило поменялось после пробного прогона.
  for (const x of Object.values(done)) {
    const e = x.ev || {};
    const pseudo = { old: e.old || {}, recent: { ...(e.rec || {}) } };
    const fk = ctx.farmKarma(e.lk, e.ck, x.raw && x.raw.votes, x.raw && x.raw.votesP);
    const farm = ctx.konsFarm(e.farm, fk.lk, fk.ck);
    const hd = ctx.homeVotes({ a: { up: (e.home || {}).up || 0, down: (e.home || {}).down || 0 }, b: { up: (e.home || {}).eUp || 0, down: (e.home || {}).eDown || 0 } }, ['a']);
    const kv = ctx.konservaVerdict(e.age || 0, e.rec || {}, pseudo, e.sleep || 0, farm, hd.hit);
    x.tags = x.tags.filter((t) => t !== 'kons' && t !== 'kons?' && t !== 'clean');
    if (kv === 'full') x.tags.unshift('kons'); else if (kv === 'weak') x.tags.unshift('kons?');
    if (!x.tags.length) x.tags.push('clean');
  }
  Object.assign(mine, done);
  writeFileSync(OUT, JSON.stringify(mine));
  const old = Object.values(done).filter((x) => Date.now() - x.t < 30 * DAY).map((x) => ({ user: x.name, tags: x.tags, evidence: x.ev, checked: x.t }));
  console.log(`Отправляю уже посчитанное: ${old.length}…`);
  for (let i = 0; i < old.length; i += 20) {
    try { console.log(`  → сервер: сохранено ${await send(old.slice(i, i + 20))}`); } catch (e) { console.log('  ! сервер:', e.message); }
  }
}

const planJ = WORKER !== '' ? JSON.parse(readFileSync(new URL('plan.json', DIRC), 'utf8')) : null;
const planList = planJ ? new Set((planJ.shards[+WORKER] || []).map((x) => x.toLowerCase())) : null;
const planForce = !!(planJ && planJ.force);
// сервисных ботов (AskGrok…) не проверяем
const todo0 = (planList ? authors.filter((x) => planList.has(x.name.toLowerCase())) : authors).filter((x) => ONLY.length || planForce || !(done[x.name.toLowerCase()] && Date.now() - done[x.name.toLowerCase()].t < 30 * DAY)).filter((_, i) => planList || i % SN === SI).slice(0, LIMIT);
const todo = todo0.filter((x) => !ctx.isServiceBot(x.name));
console.log(`Проверяю ${todo.length} ников (пауза ${PAUSE / 1000} с)${upload ? ', отправляю на сервер' : ', без отправки'}…`);
let batch = [], n = 0, stat = {};
const qDone = []; // для очереди: { user, status: 'checked' | 'error', err }
const flush = async () => {
  if (!batch.length) return;
  if (upload) { try { console.log(`  → сервер: сохранено ${await send(batch)}`); } catch (e) { console.log('  ! сервер:', e.message); } }
  batch = [];
};
for (const x of todo) {
  n++;
  const split = Math.floor(Date.now() / 1000) - 90 * 86400;
  let a;
  try { a = await ctx.archFull(x.name, split); } catch (e) { console.log(`${n}/${todo.length} ${x.name}: архив не ответил (${e.message})`); qDone.push({ user: x.name, status: 'error', err: String(e.message || e).slice(0, 150) }); await new Promise((r) => setTimeout(r, PAUSE)); continue; }
  const v = verdict(a);
  done[x.name.toLowerCase()] = mine[x.name.toLowerCase()] = { t: Date.now(), name: x.name, ...v };
  writeFileSync(OUT, JSON.stringify(mine));
  v.tags.forEach((t) => (stat[t] = (stat[t] || 0) + 1));
  console.log(`${n}/${todo.length} ${x.name} (−${x.minus}): ${v.tags.join(', ')}`);
  batch.push({ user: x.name, tags: v.tags, evidence: v.ev, checked: done[x.name.toLowerCase()].t });
  qDone.push({ user: x.name, status: 'checked' });
  if (batch.length >= 20) await flush();
  await new Promise((r) => setTimeout(r, PAUSE));
}
await flush();
console.log('Итого:', JSON.stringify(stat));
// очередь: отмечаем на сервере (только если вердикты реально отправлены — в --dry не отмечаем)
if (QUEUE && upload && qDone.length) {
  for (let i = 0; i < qDone.length; i += 200) {
    try {
      const r = await fetch(SERVER + '/admin/queue/done', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': key }, body: JSON.stringify({ items: qDone.slice(i, i + 200) }) });
      console.log('  → очередь: отмечено', (await r.json()).marked);
    } catch (e) { console.log('  ! очередь:', e.message); }
  }
  console.log(`Очередь: проверено ${qDone.filter((x) => x.status === 'checked').length}, архив не ответил ${qDone.filter((x) => x.status === 'error').length} (остались в очереди как ошибки — повтор: --queue-errors)`);
}
