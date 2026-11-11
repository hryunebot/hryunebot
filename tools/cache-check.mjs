// Хрюнебот: тесты кэша серверных вердиктов rt_srv (score.js: srvVerdictsFrom, srvCacheMerge, srvPick).
// Запуск: node tools/cache-check.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = {};
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../reddit-tagger/score.js', import.meta.url), 'utf8'), ctx);
const { srvVerdictsFrom, srvCacheMerge, srvPick } = ctx;

let bad = 0;
const ok = (d, cond) => { if (!cond) bad++; console.log((cond ? 'ok ' : 'FAIL') + '  ' + d); };
const V = (tags) => ({ tags, ev: {}, checked: 0 });
const DAY = 86400000, TTL = 3 * DAY, NOW = 100 * DAY;
const mk = () => ({
  orc: { v: V(['ork']), t: NOW - DAY },
  clown: { v: V(['clown']), t: NOW - DAY },
  other: { v: V(['kons']), t: NOW - DAY },
});

// --- 1. сервер дал новый вердикт → заменить ---
{
  const c = mk();
  const ch = srvCacheMerge(c, ['orc'], { orc: V(['ork?']) }, NOW);
  ok('новый вердикт заменяет старый', ch && c.orc.v.tags.join() === 'ork?' && c.orc.t === NOW);
  ok('  остальные записи не тронуты', c.clown.v.tags.join() === 'clown' && c.other.t === NOW - DAY);
}
// --- 2. сервер явно ответил «вердикта нет» → удалить только этот ник ---
{
  const c = mk();
  const ch = srvCacheMerge(c, ['orc'], {}, NOW);
  ok('нет вердикта → запись удалена', ch && !('orc' in c));
  ok('  чужие записи не удалены', 'clown' in c && 'other' in c);
  const c2 = mk();
  srvCacheMerge(c2, ['orc', 'clown'], { clown: V(['clown']) }, NOW);
  ok('в одном ответе: у одного сняли, у другого есть', !('orc' in c2) && c2.clown.t === NOW && 'other' in c2);
}
// --- 3. сервер недоступен / ошибка / битый ответ → кэш не трогать ---
{
  const c = mk();
  ok('ответа нет (null) → кэш не меняется', srvCacheMerge(c, ['orc', 'clown'], null, NOW) === false && 'orc' in c && 'clown' in c);
  ok('битый вердикт (без tags) → запись не трогаем', srvCacheMerge(c, ['orc'], { orc: { foo: 1 } }, NOW) === false && c.orc.v.tags.join() === 'ork');
}
// --- откуда брать ответ: только основной сервер ---
{
  ok('открытый /verdicts ответил', JSON.stringify(srvVerdictsFrom({ verdicts: { a: V(['ork']) } }, null)) === JSON.stringify({ a: V(['ork']) }));
  ok('открытый упал, общий слой ответил', !!srvVerdictsFrom(null, { verdicts: { a: V(['ork']) } }).a);
  ok('оба упали → null (ошибка, а не «нет вердикта»)', srvVerdictsFrom(null, null) === null);
  ok('ответ без поля verdicts → null', srvVerdictsFrom({ users: {} }, { complaints: {} }) === null);
  ok('verdicts — массив (битый) → null', srvVerdictsFrom({ verdicts: [] }, null) === null);
  ok('пустой объект = «ни у кого нет» (не ошибка)', JSON.stringify(srvVerdictsFrom({ verdicts: {} }, null)) === '{}');
}
// --- что показывать ---
{
  const cached = { v: V(['ork']), t: NOW - DAY };
  ok('свежий ответ сервера главнее памяти', srvPick(V(['ork?']), cached, NOW, TTL, false, false).tags.join() === 'ork?');
  ok('сервер ответил «нет» → не показываем память', srvPick(null, cached, NOW, TTL, false, false) === null);
  ok('ещё не спрашивали → память, без пометки', srvPick(undefined, cached, NOW, TTL, false, false).stale !== true);
  const st = srvPick(undefined, cached, NOW, TTL, true, false);
  ok('сервер не ответил → память с пометкой stale', st && st.stale === true && st.tags.join() === 'ork');
  ok('  пометка не портит сам кэш', cached.v.stale === undefined);
  ok('память старше 3 дней не показываем', srvPick(undefined, { v: V(['ork']), t: NOW - 4 * DAY }, NOW, TTL, true, false) === null);
  ok('«перевірити заново» → память не показываем', srvPick(undefined, cached, NOW, TTL, false, true) === null);
  ok('«перевірити заново», а сервер уже ответил → свежий ответ', srvPick(V(['clown']), cached, NOW, TTL, false, true).tags.join() === 'clown');
  ok('битая запись в памяти не показывается', srvPick(undefined, { v: { x: 1 }, t: NOW }, NOW, TTL, false, false) === null);
}
// --- откуда метки: серверный вердикт главнее своей проверки (1.3.88). Так же, как content.js: srvPick → hitsSource ---
{
  const { hitsSource } = ctx;
  const SRV = V(['ork', 'watch']); // пример: вердикт на сервере
  const src = (fresh, cached, failed, local) => {
    const v = srvPick(fresh, cached, NOW, TTL, failed, false);
    return { source: hitsSource(!!v, local), stale: !!(v && v.stale), tags: v ? v.tags.join('+') : '' };
  };
  // 1. Сервер против своей «свій» (пример): своя проверка есть, сервер дал «орк + стежу» → показываем сервер
  let r = src(SRV, null, false, true);
  ok('пример: своя «свій», сервер «орк+стежу» → сервер', r.source === 'server' && r.tags === 'ork+watch');
  // 2. «Перевірити заново»: ответ сервера сброшен и ещё не пришёл, своя проверка уже готова → по-прежнему сервер (из памяти)
  r = src(undefined, { v: SRV, t: NOW - 60000 }, false, true);
  ok('перепроверка: сервер ещё не ответил, своя готова → сервер из памяти, не своя', r.source === 'server' && r.tags === 'ork+watch' && !r.stale);
  // 3. Сбой сервера (reddit работает, своя проверка есть):
  r = src(undefined, { v: SRV, t: NOW - DAY }, true, true);
  ok('сбой сервера + вердикт в памяти → сервер с пометкой «не свежее»', r.source === 'server' && r.stale);
  r = src(undefined, null, true, true);
  ok('сбой сервера, в памяти пусто → своя проверка (с пометкой в окне)', r.source === 'local');
  r = src(undefined, { v: SRV, t: NOW - 4 * DAY }, true, true);
  ok('сбой сервера, память старше 3 дней → своя проверка', r.source === 'local');
  // 4. Сервер подтвердил, что вердикта нет → своя проверка
  r = src(null, { v: SRV, t: NOW - DAY }, false, true);
  ok('сервер ответил «вердикта нет» → своя проверка, память не показываем', r.source === 'local');
  // ни сервера, ни своей
  ok('ни сервера, ни своей → ничего', src(null, null, false, false).source === 'none');
}
// --- rt_review живёт отдельно: функции кэша трогают только переданный объект ---
{
  const review = { orc: { mark: 'ok', t: 1 } };
  const c = mk();
  srvCacheMerge(c, ['orc'], {}, NOW);
  ok('rt_review не затронут', review.orc.mark === 'ok');
}

console.log(bad ? `\nОШИБОК: ${bad}` : '\nВсе проверки кэша пройдены.');
process.exit(bad ? 1 : 0);
