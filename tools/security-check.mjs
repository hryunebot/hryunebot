// Проверка защитных функций из score.js: ссылки на комменты и цвета меток.
// Запуск: node tools/security-check.mjs   (код выхода 1, если что-то пропускает лишнее)
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { URL };
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
console.log(bad ? `ПРОБЛЕМ: ${bad}` : 'всё чисто');
process.exit(bad ? 1 : 0);
