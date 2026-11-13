// Хрюнебот: собирает server/src/check.gen.js — логику проверки ника через архив для сервера (автоочередь, 1.3.91).
// Берёт ТОТ ЖЕ код, что расширение и check-tj: reddit-tagger/score.js (баллы, метки, archVerdict) и
// reddit-tagger/background.js (archFull — запросы к ArcticShift). Руками check.gen.js не править — запускать этот скрипт
// (его вызывает build-installer.ps1; тест tools/server-check.mjs сверяет, что файл свежий).
// Запуск: node tools/gen-server-check.mjs [--check]   (--check: только проверить, что файл совпадает, код 1 — устарел)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const score = readFileSync(new URL('reddit-tagger/score.js', ROOT), 'utf8');
const bg = readFileSync(new URL('reddit-tagger/background.js', ROOT), 'utf8');

const out = `// АВТОСБОРКА tools/gen-server-check.mjs из reddit-tagger/score.js + reddit-tagger/background.js. НЕ ПРАВИТЬ РУКАМИ.
// Сервер вызывает archFull (запросы к архиву) и archVerdict (метки) — так же, как расширение и tools/check-tj.mjs.
/* eslint-disable */
// Заглушки браузерных API: фоновый скрипт расширения при загрузке вешает обработчики — на сервере они ничего не делают.
const noop = { addListener() {} };
const chrome = { runtime: { onMessage: noop, getManifest: () => ({ version: 'server' }) }, action: { onClicked: noop },
  storage: { local: { get: async () => ({}), set: async () => {} } }, tabs: { create() {} } };
const importScripts = undefined;
const setLang = () => {};
const T = (s) => s;
const N = (n, f) => (+n || 0) + ' ' + String(f).split('|')[2];
// archGate — общий «шлагбаум» к архиву (как в check-tj): сервер подставляет свой счётчик запросов (лимит Cloudflare).
let archGate = null;
export function setArchGate(g) { archGate = g; }
// archFetchImpl — запрос к архиву через кэш сервера (D1): успешные ответы переиспользуются при повторе.
let archFetchImpl = null;
export function setArchFetch(f) { archFetchImpl = f; }

// ===== reddit-tagger/score.js =====
${score}

// ===== reddit-tagger/background.js =====
${bg}

export { archFull, archVerdict, isServiceBot, archOk, trustOf };
`;

const target = new URL('server/src/check.gen.js', ROOT);
if (process.argv.includes('--check')) {
  const cur = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (cur !== out) { console.log('server/src/check.gen.js УСТАРЕЛ — запустите: node tools/gen-server-check.mjs'); process.exit(1); }
  console.log('server/src/check.gen.js свежий');
} else {
  writeFileSync(target, out);
  console.log('собран server/src/check.gen.js (' + out.length + ' символов)');
}
