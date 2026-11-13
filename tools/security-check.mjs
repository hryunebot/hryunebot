// Проверка защитных функций из score.js: ссылки на комменты и цвета меток.
// Запуск: node tools/security-check.mjs   (код выхода 1, если что-то пропускает лишнее)
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { URL, T: (x, v) => { let r = x; for (const k in v || {}) r = r.split('{' + k + '}').join(String(v[k])); return r; }, N: (n) => String(n) };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../reddit-tagger/score.js', import.meta.url), 'utf8'), ctx);

const links = [
  ['javascript:alert(1)', null],
  ['JAVASCRIPT:alert(1)', null],
  ['data:text/html,<script>alert(1)</script>', null],
  ['https://evil.com/r/x', null],
  ['https://reddit.com.evil.com/x', null],
  ['http://www.reddit.com/r/a', null],
  ['/r/pikabu/comments/1/x/', 'https://www.reddit.com/r/pikabu/comments/1/x/'],
  ['https://old.reddit.com/r/a/', 'https://old.reddit.com/r/a/'],
];
const colors = [
  ['#e5484d', '#e5484d'],
  ['#AABBCC', '#AABBCC'],
  ['red;" onclick="alert(1)', '#e5484d'],
  ['#12345', '#e5484d'],
  ['url(javascript:x)', '#e5484d'],
];

let bad = 0;
for (const [inp, want] of links) {
  const got = ctx.safeRedditLink(inp);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok ' : 'FAIL'}  ссылка ${JSON.stringify(inp)} -> ${JSON.stringify(got)}`);
}
for (const [inp, want] of colors) {
  const got = ctx.safeColor(inp);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok ' : 'FAIL'}  цвет ${JSON.stringify(inp)} -> ${JSON.stringify(got)}`);
}
// 1.3.96: числа из вердикта сервера/памяти браузера в карточку попадают только числами (строка с разметкой — 0)
const evil = '<img src=x onerror=alert(1)>';
const hs = ctx.hitsFromVerdict({ tags: ['ork', 'homedown'], ev: { ork: { n: evil, up: evil, down: '5', posts: evil, comments: '3' }, home: { up: evil, down: evil, eUp: 0, eDown: 0 } } }, {});
const flat = JSON.stringify(hs.map((h) => [h.n, h.up, h.down, h.posts, h.comments, ctx.hitCount(h)]));
const okv = !flat.includes('<') && hs.every((h) => typeof h.n === 'number' && typeof ctx.hitCount(h) === 'number');
if (!okv) bad++;
console.log(`${okv ? 'ok ' : 'FAIL'}  числа вердикта — только числа: ${flat}`);
const why = hs.map((h) => ctx.hitWhy(h)).join(' ');
const okw = !why.includes('<img');
if (!okw) bad++;
console.log(`${okw ? 'ok ' : 'FAIL'}  объяснение без чужой разметки`);
console.log(bad ? `ПРОБЛЕМ: ${bad}` : 'всё чисто');
process.exit(bad ? 1 : 0);
