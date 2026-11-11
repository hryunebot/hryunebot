// Проверка переводов: находит все T('...') и data-t/data-tp в расширении и сверяет со словарём в i18n.js.
// Запуск: node tools/i18n-check.mjs   (код выхода 1, если чего-то не хватает)
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const dir = new URL('../reddit-tagger/', import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), 'utf8');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(read('i18n.js') + '\nthis.UK = I18N_UK;', ctx);
const dict = ctx.UK;

const keys = new Set();
for (const f of ['content.js', 'dashboard.js', 'background.js']) {
  const src = read(f);
  for (const m of src.matchAll(/\bT\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
}
for (const m of read('dashboard.html').matchAll(/data-tp?="([^"]*)"/g)) keys.add(m[1]);
// Сообщения сервера приходят по-русски и переводятся в background.js — они тоже должны быть в словаре.
const server = readFileSync(new URL('../server/src/index.js', import.meta.url), 'utf8');
for (const m of server.matchAll(/fail\(\d+, '([^']*)'\)|json\(\{ error: '([^']*)' \}/g)) keys.add(m[1] || m[2]);

const missing = [...keys].filter((k) => !(k in dict));
const unused = Object.keys(dict).filter((k) => !keys.has(k));
const badVars = [...keys].filter((k) => k in dict && (k.match(/\{\w+\}/g) || []).sort().join() !== (dict[k].match(/\{\w+\}/g) || []).sort().join());

console.log(`надписей в коде: ${keys.size}, в словаре: ${Object.keys(dict).length}`);
if (missing.length) console.log('НЕТ ПЕРЕВОДА:\n  ' + missing.join('\n  '));
if (badVars.length) console.log('НЕ СОВПАДАЮТ {подстановки}:\n  ' + badVars.join('\n  '));
if (unused.length) console.log('лишние в словаре (не используются):\n  ' + unused.join('\n  '));
process.exit(missing.length || badVars.length ? 1 : 0);
