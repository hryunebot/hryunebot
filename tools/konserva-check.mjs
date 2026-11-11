// Проверка детектора «🥫 консерва» (score.js): язык текста, кандидаты и вердикт.
// Запуск: node tools/konserva-check.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { URL };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../reddit-tagger/score.js', import.meta.url), 'utf8'), ctx);

let bad = 0;
const check = (d, got, want) => { if (got !== want) bad++; console.log(`${got === want ? 'ok ' : 'FAIL'}  ${d} -> ${got}`); };
const DAY = 86400, NOW = 1.8e9;

check('английский текст', ctx.textLang('What is the title of this game?'), 'lat');
check('русский текст', ctx.textLang('Опять зрада, всё пропало'), 'cyr');
check('украинский текст', ctx.textLang('Що там у вас відбувається?'), 'cyr');
check('ник латиницей в кириллическом посте', ctx.textLang('Що таке u/Example_User1 ??'), 'cyr');
check('только ссылка', ctx.textLang('https://preview.redd.it/abcdefgh.png'), null);

// arch: старая история (до 3 мес.) и свежая (последние 3 мес.) из архива
const A = (old, recent) => ({ old: Object.assign({ newest: NOW - 200 * DAY }, old), recent: Object.assign({ oldest: NOW - 20 * DAY }, recent) });
const engNsfw = { n: 80, cyr: 2, lat: 60, nsfw: 50 };
const engClean = { n: 80, cyr: 2, lat: 60, nsfw: 3 };
const cyrRecent = { n: 10, cyr: 8, lat: 1, cyrPosts: 2 };
const noRec = { n: 0, cyr: 0, lat: 0, cyrPosts: 0 };

check('5 лет, NSFW по-английски → кириллица', ctx.konservaVerdict(5 * 365, noRec, A(engNsfw, cyrRecent)), 'full');
check('5 лет, раньше английский без NSFW → «консерва?»', ctx.konservaVerdict(5 * 365, noRec, A(engClean, cyrRecent)), 'weak');
check('1 год, но пропадал 180 дней → «консерва?»', ctx.konservaVerdict(365, noRec, A(engClean, cyrRecent)), 'weak');
const noGap = { old: Object.assign({ newest: NOW - 95 * DAY }, engClean), recent: Object.assign({ oldest: NOW - 80 * DAY }, cyrRecent) };
check('1 год, без перерыва, раньше английский → «консерва?»', ctx.konservaVerdict(365, noRec, noGap), 'weak');
check('1 год, без перерыва, NSFW → только «консерва?» (для полной нужен возраст/перерыв)', ctx.konservaVerdict(365, noRec, { old: Object.assign({ newest: NOW - 95 * DAY }, engNsfw), recent: Object.assign({ oldest: NOW - 80 * DAY }, cyrRecent) }), 'weak');
check('4 месяца → нет', ctx.konservaVerdict(120, noRec, A(engClean, cyrRecent)), false);
check('  почему: моложе полугода', ctx.konservaWhyNot(120, noRec, null, null), 'young');
check('свежих постов кириллицей нет ни на reddit, ни в архиве', ctx.konservaVerdict(5 * 365, noRec, A(engClean, { n: 20, cyr: 1, lat: 18, cyrPosts: 0 })), false);
check('пост кириллицей виден только на reddit', ctx.konservaVerdict(5 * 365, { n: 5, cyr: 1, lat: 4, cyrPosts: 1 }, A(engClean, noRec)), 'weak');
check('раньше смесь англ./кирилл. → нет', ctx.konservaVerdict(5 * 365, noRec, A({ n: 80, cyr: 15, lat: 60, nsfw: 3 }, cyrRecent)), false);
check('архив почти пуст', ctx.konservaVerdict(5 * 365, noRec, A({ n: 3, cyr: 0, lat: 3, nsfw: 3 }, cyrRecent)), false);
check('архив не ответил', ctx.konservaVerdict(5 * 365, noRec, { err: 1 }), false);
check('идём в архив: старый, раньше по-английски', ctx.konsNeedArch(400, { cyr: 1, lat: 40 }), true);
check('не идём: раньше писал кириллицей', ctx.konsNeedArch(400, { cyr: 30, lat: 10 }), false);
check('не идём: моложе полугода', ctx.konsNeedArch(100, { cyr: 0, lat: 40 }), false);
check('  почему: раньше кириллица', ctx.konservaWhyNot(400, noRec, null, { cyr: 30, lat: 10 }), 'wascyr');
// «Спящий» акк: молчание 180+ дней, закончившееся за последний год
const T0 = NOW;
check('молчал 200 дн. и снова пишет', Math.round(ctx.konsSleep([T0 - 10 * DAY, T0 - 5 * DAY, T0 - 215 * DAY, T0 - 230 * DAY], 0, false, T0)), 205);
check('  одно молчание → «консерва?»', ctx.konservaVerdict(400, noRec, null, 205), 'weak');
check('  молчание + раньше английский → консерва', ctx.konservaVerdict(400, noRec, A(engClean, cyrRecent), 205), 'full');
check('  молчание + минусуют тут → консерва', ctx.konservaVerdict(400, noRec, null, 205, null, true), 'full');
check('зарегался 8 мес. назад, первый пост вчера (история полная)', Math.round(ctx.konsSleep([T0 - DAY], T0 - 241 * DAY, true, T0)), 240);
check('история неполная (100 постов) — регистрацию не считаем', ctx.konsSleep([T0 - DAY, T0 - 2 * DAY], T0 - 5 * 365 * DAY, false, T0), 1);
check('старый перерыв (закончился 2 года назад) не считается', ctx.konsSleep([T0 - 10 * DAY, T0 - 700 * DAY, T0 - 1000 * DAY], 0, false, T0) < 180, false);
check('перерыв 100 дн. — мало', ctx.konservaVerdict(400, noRec, null, 100), false);
// «Ферма кармы»
check('картинка i.redd.it без текста', ctx.postIsImg('https://i.redd.it/abc.jpg', ''), true);
check('галерея', ctx.postIsImg('https://www.reddit.com/gallery/1abc', ''), true);
check('текстовый пост', ctx.postIsImg('https://www.reddit.com/r/x/comments/1/abc/', 'текст'), false);
const day = T0 - 345 * DAY;
const farmPosts = [['boating', 'Fisherman boats. Greece'], ['chihuahua', 'Hold me'], ['birds', 'Rome'], ['birding', 'Eternal City'], ['chihuahua', 'Cheese']]
  .map(([s, title], i) => ({ t: day + i * 3600, s, img: true, words: ctx.titleWords(title) }));
const fs1 = ctx.farmStats(farmPosts);
check('пачка: 4 разных саба за сутки', fs1.burst, 4);
check('картинок с короткими заголовками', fs1.imgShort, 5);
check('ферма: пачка + картинки', ctx.konsFarm(fs1, 0, 0).hit, true);
const normal = [0, 40, 90, 150, 200].map((d, i) => ({ t: T0 - d * DAY, s: 'arcraiders', img: false, words: 6 }));
check('обычные текстовые посты раз в месяц — не ферма', ctx.konsFarm(ctx.farmStats(normal), 50, 2000).hit, false);
check('только перекос кармы — мало (нужно 2 признака)', ctx.konsFarm(ctx.farmStats(normal), 5000, 100).hit, false);
check('мало постов — не судим', ctx.konsFarm(ctx.farmStats(farmPosts.slice(0, 3)), 5000, 0).hit, false);
// Неизвестная карма (1.3.78): архив отдал карму постов, а комментов — 0, хотя есть заплюсованные комменты
const fsImg = ctx.farmStats(farmPosts.map((p) => ({ ...p, s: 'same' }))); // картинки, но без пачки по сабам
const kz = ctx.farmKarma(973, 0, { tj: { up: 73, down: 28 } }, {});
check('карма комментов 0 при заплюсованных комментах → неизвестна', kz.ck, null);
check('  с неизвестной кармой признак «карма постов ≫ комментов» не срабатывает', ctx.konsFarm(fsImg, kz.lk, kz.ck).ratio, false);
check('  а при известной — срабатывает как раньше', ctx.konsFarm(fsImg, 973, 10).ratio, true);
check('карма комментов 0 и заплюсованных комментов нет — 0 остаётся', ctx.farmKarma(973, 0, { x: { up: 2 } }, { x: { up: 2 } }).ck, 0);
check('кармы нет совсем (null) → признак не считаем', ctx.konsFarm(fsImg, null, null).ratio, false);
const farmHit = ctx.konsFarm(fs1, 0, 0);
check('ферма + кириллица сейчас → консерва', ctx.konservaVerdict(400, noRec, A(engClean, cyrRecent), 0, farmHit), 'full');
check('ферма без кириллицы → «консерва?»', ctx.konservaVerdict(400, noRec, A(engClean, { n: 10, cyr: 0, lat: 9, cyrPosts: 0 }), 0, farmHit), 'weak');
check('ферма, архив не ответил, пост кириллицей на reddit → консерва', ctx.konservaVerdict(400, { n: 3, cyr: 1, lat: 2, cyrPosts: 1 }, { err: 'x' }, 0, farmHit), 'full');
check('молчание + раньше англ., но и сейчас латиница (эмигрант) → «консерва?»', ctx.konservaVerdict(3000, { n: 100, cyr: 4, lat: 95, cyrPosts: 0 }, { old: { n: 109, cyr: 7, lat: 101, nsfw: 0 }, recent: { n: 100, cyr: 4, lat: 95, cyrPosts: 0 } }, 404), 'weak');
process.exit(bad ? 1 : 0);
