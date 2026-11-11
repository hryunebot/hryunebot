// Хрюнебот: сбор списка ников для массовой проверки — ТОЛЬКО из открытого архива ArcticShift (reddit не трогаем).
// Кого берём: комментаторов в постах владельца в r/tjournal_refugees и в темах про Украину там же.
// Очередь: сначала те, у кого больше заминусованных комментов в этих тредах (это лишь порядок проверки, не вердикт).
//
// Запуск:  node tools/crawl-tj.mjs [--days 90] --owner <ник автора постов>
// Результат: dist/crawl/authors.json (+ прогресс в dist/crawl/state.json — после остановки продолжит с того же места).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const ARCH = 'https://arctic-shift.photon-reddit.com/api';
const SUB = 'tjournal_refugees';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DAYS = +arg('days', 90);
const OWNER = String(arg('owner', '')).toLowerCase();
if (!OWNER) { console.log('Укажите автора постов: --owner <ник>'); process.exit(1); }
// Темы про Украину: ищем по словам в заголовке (рус. и укр.)
const TOPICS = ['Україн', 'Украин', 'Зеленськ', 'Зеленск', 'ЗСУ', 'ВСУ', 'Київ', 'Киев', 'хохл', 'укроп', 'Бандер', 'мобілізац', 'мобилизац'];
const SKIP = new Set(['automoderator', '[deleted]', 'askgrok', 'grok', 'remindmebot', OWNER]); // + сервисные боты

const DIR = new URL('../dist/crawl/', import.meta.url);
mkdirSync(DIR, { recursive: true });
const STATE = new URL('state.json', DIR);
const OUT = new URL('authors.json', DIR);
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { posts: {}, done: {}, authors: {} };
const save = () => writeFileSync(STATE, JSON.stringify(state));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAUSE = 2500; // между запросами — архив бесплатный, не частим
const WAIT = [5000, 15000, 30000, 60000]; // при «slow down» ждём всё дольше

async function get(path) {
  for (let i = 0; i <= WAIT.length; i++) {
    let j = {};
    try {
      const r = await fetch(ARCH + path, { headers: { 'user-agent': 'Hryunebot-crawl/1.0 (open-source reddit tagger)' }, signal: AbortSignal.timeout(40000) });
      j = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(j.data)) { await sleep(PAUSE); return j.data; }
    } catch (e) { j = { error: e.name }; }
    if (i < WAIT.length) { process.stdout.write(`  · архив: ${j.error || 'ошибка'} — жду ${WAIT[i] / 1000} с\n`); await sleep(WAIT[i]); }
  }
  return null;
}

const since = Math.floor(Date.now() / 1000) - DAYS * 86400;
const addPost = (p, why) => {
  if (!p || !p.id || state.posts[p.id]) return;
  state.posts[p.id] = { title: String(p.title || '').slice(0, 80), n: p.num_comments || 0, why };
};

// 1) Посты владельца в сабе
console.log(`Посты u/${OWNER} в r/${SUB} за ${DAYS} дн.…`);
{
  let before = Math.floor(Date.now() / 1000);
  for (;;) {
    const d = await get(`/posts/search?author=${OWNER}&subreddit=${SUB}&limit=100&sort=desc&before=${before}&after=${since}&fields=id,title,created_utc,num_comments`);
    if (!d || !d.length) break;
    d.forEach((p) => addPost(p, 'owner'));
    before = Math.min(...d.map((p) => p.created_utc));
    if (d.length < 100) break;
  }
}
// 2) Темы про Украину
for (const t of TOPICS) {
  console.log(`Темы «${t}»…`);
  const d = await get(`/posts/search?subreddit=${SUB}&title=${encodeURIComponent(t)}&limit=100&sort=desc&after=${since}&fields=id,title,created_utc,num_comments`);
  if (!d) { console.log(`  ! поиск «${t}» не ответил — пропускаю (повторите запуск позже)`); continue; }
  d.forEach((p) => addPost(p, 'topic'));
}
save();
const ids = Object.keys(state.posts);
console.log(`Тредов: ${ids.length} (ваших: ${ids.filter((i) => state.posts[i].why === 'owner').length}). Собираю комментаторов…`);

// 3) Комментаторы каждого треда
let k = 0;
for (const id of ids) {
  k++;
  if (state.done[id]) continue;
  let after = 0, ok = true;
  for (;;) {
    const d = await get(`/comments/search?link_id=${id}&limit=100&sort=asc${after ? '&after=' + after : ''}&fields=author,score,created_utc`);
    if (!d) { ok = false; break; }
    for (const c of d) {
      const a = String(c.author || '').toLowerCase();
      if (!a || SKIP.has(a)) continue;
      const x = (state.authors[a] ??= { name: c.author, comments: 0, minus: 0, threads: {} });
      x.comments++;
      if (typeof c.score === 'number' && c.score < 0) x.minus++;
      x.threads[id] = 1;
    }
    if (d.length < 100) break;
    after = d[d.length - 1].created_utc;
  }
  if (ok) state.done[id] = 1;
  if (k % 10 === 0 || k === ids.length) { save(); console.log(`  ${k}/${ids.length} тредов, ников: ${Object.keys(state.authors).length}`); }
}
save();

// 4) Очередь: больше минусов → раньше; потом — больше комментов
const list = Object.values(state.authors)
  .map((x) => ({ name: x.name, minus: x.minus, comments: x.comments, threads: Object.keys(x.threads).length }))
  .sort((a, b) => b.minus - a.minus || b.comments - a.comments);
writeFileSync(OUT, JSON.stringify({ t: Date.now(), days: DAYS, owner: OWNER, authors: list }, null, 1));
console.log(`Готово: ${list.length} ников → dist/crawl/authors.json`);
console.log('Первые по минусам:', list.slice(0, 5).map((x) => `${x.name} (−${x.minus}/${x.comments})`).join(', '));
if (Object.keys(state.done).length < ids.length) console.log('Часть тредов архив не отдал — запустите ещё раз, продолжит с места остановки.');
