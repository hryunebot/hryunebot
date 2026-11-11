// Хрюнебот: тесты согласия на отправку в очередь (score.js queueConsent/queueAction) и защиты публикации
// (tools/publish-guard.mjs). Запуск: node tools/consent-check.mjs
import { readFileSync, mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { publishDecision, newestBackup } from './publish-guard.mjs';

const ctx = {};
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../reddit-tagger/score.js', import.meta.url), 'utf8'), ctx);
let bad = 0;
const ok = (d, got, want) => { const c = got === want; if (!c) bad++; console.log((c ? 'ok ' : 'FAIL') + '  ' + d + ' -> ' + got); };

// --- согласие ---
ok('не спрашивали (null) → спросить', ctx.queueConsent(null), 'ask');
ok('не спрашивали (нет поля) → спросить', ctx.queueConsent(undefined), 'ask');
ok('  до ответа ник только придерживается в памяти, в сеть не уходит', ctx.queueAction(null), 'hold');
ok('«Так» → отправлять', ctx.queueAction(true), 'send');
ok('«Ні» → ничего не делать', ctx.queueAction(false), 'drop');
ok('мусор в настройке («true» строкой) — не согласие', ctx.queueAction('true'), 'hold');
ok('1 — не согласие (только true)', ctx.queueAction(1), 'hold');

// Модель поведения content.js: ник проверен → действие; ответ сохраняется в настройках и переживает перезапуск.
function session(stored, answer) {
  const sent = [], held = [];
  let settings = { helpQueue: stored }, asked = 0;
  const check = (nick) => {
    const act = ctx.queueAction(settings.helpQueue);
    if (act === 'drop') return;
    if (act === 'hold') { held.push(nick); if (ctx.queueConsent(settings.helpQueue) === 'ask') asked++; return; }
    sent.push(nick);
  };
  check('a'); check('b');
  if (answer !== undefined && ctx.queueConsent(settings.helpQueue) === 'ask') {
    settings.helpQueue = answer;
    if (answer === true) { sent.push(...held); held.length = 0; } else held.length = 0;
  }
  check('c');
  return { sent: sent.join(','), held: held.length, asked: asked > 0, saved: settings.helpQueue };
}
let s = session(null, undefined);
ok('первый запуск без ответа: ничего не отправлено', s.sent, '');
ok('  вопрос показан', s.asked, true);
s = session(null, true);
ok('ответ «Так»: придержанные и новые ушли', s.sent, 'a,b,c');
s = session(null, false);
ok('ответ «Ні»: ничего не ушло', s.sent, '');
ok('  придержанные выброшены', s.held, 0);
s = session(false, undefined);
ok('повторный запуск после «Ні»: не спрашиваем снова', s.asked, false);
ok('  и не отправляем', s.sent, '');
s = session(true, undefined);
ok('повторный запуск после «Так»: не спрашиваем', s.asked, false);
ok('  и отправляем', s.sent, 'a,b,c');

// --- публикация только по явной команде ---
const fresh = { file: 'd1.sql', ageMin: 5 }, old = { file: 'd1.sql', ageMin: 300 };
ok('очередь без --publish → не отправлять', publishDecision({ queue: true, publish: false, dry: false, hasKey: true, backup: fresh }).upload, false);
ok('очередь + --publish + свежий бэкап → отправлять', publishDecision({ queue: true, publish: true, dry: false, hasKey: true, backup: fresh }).upload, true);
ok('очередь + --publish, бэкапа нет → не отправлять', publishDecision({ queue: true, publish: true, dry: false, hasKey: true, backup: null }).upload, false);
ok('очередь + --publish, бэкап старый → не отправлять', publishDecision({ queue: true, publish: true, dry: false, hasKey: true, backup: old }).upload, false);
ok('--publish + --dry → не отправлять', publishDecision({ queue: true, publish: true, dry: true, hasKey: true, backup: fresh }).upload, false);
ok('--publish без ключа → не отправлять', publishDecision({ queue: true, publish: true, dry: false, hasKey: false, backup: fresh }).upload, false);
ok('обычная массовая проверка — как раньше', publishDecision({ queue: false, publish: false, dry: false, hasKey: true, backup: null }).upload, true);

// --- поиск свежего бэкапа ---
const dir = mkdtempSync(join(tmpdir(), 'hryu-bk-'));
try {
  ok('нет файлов → бэкапа нет', newestBackup(dir), null);
  writeFileSync(join(dir, 'empty.sql'), '');
  ok('пустой файл — не бэкап', newestBackup(dir), null);
  writeFileSync(join(dir, 'a.sql'), 'x'); const t = Date.now() / 1000 - 3 * 3600; utimesSync(join(dir, 'a.sql'), t, t);
  writeFileSync(join(dir, 'b.sql'), 'x');
  ok('берём самый свежий', newestBackup(dir).file, 'b.sql');
  ok('  возраст в минутах', newestBackup(dir).ageMin <= 1, true);
} finally { rmSync(dir, { recursive: true, force: true }); }

// --- фон грузится в песочнице check-tj (там у chrome.* нет onInstalled/tabs) — иначе массовая проверка не стартует ---
{
  const sb = { console, setTimeout, clearTimeout, fetch: async () => ({ ok: false, json: async () => ({}) }), URL, AbortSignal };
  sb.chrome = { runtime: { onMessage: { addListener() {} }, getManifest: () => ({ version: 'test' }) }, action: { onClicked: { addListener() {} } }, storage: { local: { get: async () => ({}), set: async () => {} } } };
  vm.createContext(sb);
  let err = null;
  try {
    vm.runInContext(readFileSync(new URL('../reddit-tagger/i18n.js', import.meta.url), 'utf8'), sb);
    vm.runInContext(readFileSync(new URL('../reddit-tagger/score.js', import.meta.url), 'utf8'), sb);
    vm.runInContext(readFileSync(new URL('../reddit-tagger/background.js', import.meta.url), 'utf8'), sb);
  } catch (e) { err = e.message; }
  ok('background.js грузится без chrome.runtime.onInstalled (как в check-tj)', err, null);
}

console.log(bad ? `\nОШИБОК: ${bad}` : '\nВсе проверки согласия и публикации пройдены.');
process.exit(bad ? 1 : 0);
