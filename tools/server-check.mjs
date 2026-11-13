// Хрюнебот: сервер (автоочередь) считает так же, как check-tj и расширение (1.3.91).
// 1) server/src/check.gen.js собран из ТЕКУЩИХ score.js + background.js (не устарел);
// 2) archVerdict из модуля сервера = archVerdict из score.js на всех сохранённых никах (dist/crawl, если есть) и на примерах.
// Запуск: node tools/server-check.mjs
import { readFileSync, readdirSync, existsSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
let bad = 0;
const ok = (d, c, extra = '') => { if (!c) bad++; console.log((c ? 'ok ' : 'FAIL') + '  ' + d + (extra ? ' — ' + extra : '')); };

let fresh = true;
try { execFileSync(process.execPath, [join(ROOT, 'tools', 'gen-server-check.mjs'), '--check'], { stdio: 'pipe' }); } catch { fresh = false; }
ok('server/src/check.gen.js собран из текущего кода (иначе: node tools/gen-server-check.mjs)', fresh);

// модуль сервера — во временную папку как ES-модуль
const T = mkdtempSync(join(tmpdir(), 'hryu-gen-'));
copyFileSync(join(ROOT, 'server', 'src', 'check.gen.js'), join(T, 'check.gen.js'));
writeFileSync(join(T, 'package.json'), '{"type":"module"}');
const srv = await import(pathToFileURL(join(T, 'check.gen.js')).href);
process.on('exit', () => { try { rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ } });
ok('модуль сервера грузится в строгом режиме', typeof srv.archFull === 'function' && typeof srv.archVerdict === 'function');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(readFileSync(join(ROOT, 'reddit-tagger', 'score.js'), 'utf8'), ctx);
const HOME = ['tjournal_refugees'], NOW = Date.UTC(2026, 10, 11);

// входы: сохранённые проверки (если есть) + синтетические
const inputs = [];
const DIR = join(ROOT, 'dist', 'crawl');
if (existsSync(DIR)) {
  for (const f of readdirSync(DIR).filter((x) => /^verdicts.*\.json$/.test(x))) {
    for (const v of Object.values(JSON.parse(readFileSync(join(DIR, f), 'utf8')))) {
      if (!v || !v.raw || !v.ev) continue;
      const e = v.ev;
      inputs.push({ first: NOW / 1000 - (e.age || 0) * 86400, sleep: e.sleep || 0, lk: e.lk, ck: e.ck, farm: e.farm ? { ...e.farm } : null,
        old: { ...e.old }, recent: { ...e.rec, oldest: 0, newest: 0 }, subs: v.raw.subs, votes: v.raw.votes, subsP: v.raw.subsP, votesP: v.raw.votesP });
    }
  }
}
const base = { first: NOW / 1000 - 900 * 86400, sleep: 0, lk: null, ck: null, farm: null, old: { n: 0, cyr: 0, lat: 0, nsfw: 0 }, recent: { n: 0, cyr: 0, lat: 0, cyrPosts: 0 }, subs: {}, votes: {}, subsP: {}, votesP: {} };
inputs.push(base,
  { ...base, subs: { expectedrussians: 20 }, votes: { expectedrussians: { up: 20, down: 0 } } },
  { ...base, subs: { ukrainerussiareport: 9 }, votes: { ukrainerussiareport: { up: 8, down: 0 } } },
  { ...base, subs: { tjournal_refugees: 30 }, votes: { tjournal_refugees: { up: 5, down: 20 } } },
  { ...base, sleep: 300, old: { n: 50, cyr: 0, lat: 50, nsfw: 30 }, recent: { n: 20, cyr: 15, lat: 5, cyrPosts: 3 } });
let diff = 0;
for (const a of inputs) {
  const x = JSON.stringify(srv.archVerdict(a, HOME, NOW)), y = JSON.stringify(ctx.archVerdict(a, HOME, NOW));
  if (x !== y) diff++;
}
ok(`сервер = check-tj/расширение на ${inputs.length} входах`, diff === 0, diff ? `расхождений ${diff}` : '');

console.log(bad ? `\nОШИБОК: ${bad}` : '\nСервер считает так же, как скрипт и расширение.');
process.exit(bad ? 1 : 0);
