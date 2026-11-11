// Хрюнебот: калибровочная выборка для ручной проверки владельцем (11.11.2026, по предложению ГПТ).
// 8 категорий без пересечений (каждый ник — в одной, по приоритету), по 6 случайных ников, фиксированное зерно.
// Исходные вердикты сохраняются до оценки. Процент нахрюкометра НЕ показываем — чтобы не влиял на оценку.
// Тексты чужих комментов не копируем: только цифры и ссылки.
// Запуск: node tools/calib-sample.mjs [--seed 20261111] [--per 6]   (под 1.3.89: --seed 1389 --per 4 → 28 ников, орков 0)
// Результат: dist/audit/calib-<seed>.json (выборка + исходные вердикты) и dist/audit/calib-<seed>.html (лист для оценки).
import fs from 'node:fs';
const ROOT = new URL('../', import.meta.url);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SEED = +arg('seed', 20261111), PER = +arg('per', 6);
const DIR = new URL('dist/crawl/', ROOT);
const all = {};
for (const f of fs.readdirSync(DIR).filter((x) => /^verdicts.*\.json$/.test(x))) {
  for (const v of Object.values(JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8')))) {
    if (!v || !v.name || !v.tags) continue;
    const k = v.name.toLowerCase();
    if (!all[k] || all[k].t < v.t) all[k] = v;
  }
}
const has = (v, ...t) => v.tags.some((x) => t.includes(x));
const CATS = [
  ['kons', '🥫 Консерва / консерва?', (v) => has(v, 'kons', 'kons?')],
  ['deb', '🥊 Спорщики / 👎 мінусують', (v) => v.tags.some((x) => x.startsWith('deb_') || x === 'debater') || has(v, 'homedown')],
  ['clown', '🤡 Клоун, уверенный', (v) => has(v, 'clown')],
  ['clown?', '🤡 Клоун?, сомнительный', (v) => has(v, 'clown?')],
  ['ork', '👹 Орк, уверенный', (v) => has(v, 'ork')],
  ['ork?', '🤷 Орк?, сомнительный', (v) => has(v, 'ork?')],
  ['watch', '👀 Стежу / стежу?', (v) => has(v, 'watch', 'watch?')],
  ['clean', '✅ Чистые', (v) => v.tags.length === 1 && v.tags[0] === 'clean'],
];
// детерминированный ГСЧ (mulberry32)
let s = SEED >>> 0;
const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const used = new Set(), sample = [];
const pool = Object.values(all).filter((v) => !/^(askgrok|grok|remindmebot|automoderator)$/i.test(v.name)).sort((a, b) => a.name.localeCompare(b.name));
const byCat = {};
for (const v of pool) { const c = CATS.find(([, , f]) => f(v)); if (c) (byCat[c[0]] ??= []).push(v); }
for (const [id, label] of CATS) {
  const list = [...(byCat[id] || [])];
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  for (const v of list.slice(0, PER)) { used.add(v.name.toLowerCase()); sample.push({ cat: id, catLabel: label, name: v.name, tags: v.tags, ev: v.ev, checked: v.t }); }
}
// порядок показа перемешан, чтобы категории не шли подряд
for (let i = sample.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sample[i], sample[j]] = [sample[j], sample[i]]; }
fs.mkdirSync(new URL('dist/audit/', ROOT), { recursive: true });
fs.writeFileSync(new URL(`dist/audit/calib-${SEED}.json`, ROOT), JSON.stringify({ seed: SEED, per: PER, made: Date.now(), poolSizes: Object.fromEntries(CATS.map(([id]) => [id, (byCat[id] || []).length])), sample }, null, 1));

// ---- лист для оценки ----
const TAGNAME = { kons: '🥫 консерва', 'kons?': '🥫 консерва?', homedown: '👎 мінусують у tj', ork: '👹 орк', 'ork?': '🤷 орк?', clown: '🤡 клоун', 'clown?': '🤡 клоун?', watch: '👀 стежу', 'watch?': '👀 стежу?', deb_ork: '🥊 спорщик (орочі саби)', deb_clown: '🥊 спорщик (RedditUaTalks)', deb_watch: '🥊 спорщик (rusAskReddit/Pikabu)', debater: '🥊 спорщик', clean: '✅ чисто' };
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 1.3.89: ruAsska убран; expectedrussians — «мягкий» (по нему одному максимум «орк?»); клоун — метка места, до 2 баллов
const SUBS = { ork: 'ukrainerussiareport, genzedong, vataRU, expectedrussians (только «?»)', clown: 'RedditUaTalks (метка места)', watch: 'rusAskReddit, Pikabu' };
const evLines = (v) => {
  const e = v.ev || {}, L = [];
  for (const k of ['ork', 'clown', 'watch']) { const o = e[k]; if (o && o.n) L.push(`${k === 'ork' ? '👹' : k === 'clown' ? '🤡' : '👀'} ${SUBS[k]}: ${o.posts ?? '?'} пост. + ${o.comments ?? '?'} комм., оценки +${o.up}/−${o.down}`); }
  const h = e.home || {}; L.push(`tj: заплюсовано ${h.up ?? 0}, заминусовано ${h.down ?? 0}`);
  if (e.age != null) L.push(`аккаунту ${e.age} дн., самый долгий перерыв ${e.sleep ?? '?'} дн.`);
  if (e.old && e.old.n) L.push(`раньше (старше 3 мес.): ${e.old.n} записей, латиница ${e.old.lat}, кириллица ${e.old.cyr}, NSFW ${e.old.nsfw}`);
  if (e.rec && e.rec.n) L.push(`сейчас (3 мес.): ${e.rec.n} записей, кириллица ${e.rec.cyr}, латиница ${e.rec.lat}, постов кириллицей ${e.rec.cyrPosts ?? 0}`);
  if (e.farm && e.farm.posts) L.push(`ферма: постов ${e.farm.posts}, до ${e.farm.burst} сабов за сутки, коротких картинок ${e.farm.imgShort}; карма постов ${e.lk ?? '?'}, комментов ${e.ck ?? '?'}`);
  return L;
};
const cards = sample.map((v, i) => `<div class="c" data-n="${esc(v.name)}"><div class="h"><b>${i + 1}. u/${esc(v.name)}</b>
 <a href="https://www.reddit.com/user/${encodeURIComponent(v.name)}/" target="_blank">reddit</a>
 <a href="https://rosint.dev/?u=${encodeURIComponent(v.name)}" target="_blank">rosint (архив)</a></div>
 <div class="t">Хрюнебот утверждает: <b>${v.tags.map((t) => esc(TAGNAME[t] || t)).join(', ')}</b></div>
 <ul>${evLines(v).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
 <div class="r">${[['ok', '✔ данные и вывод подтверждаются'], ['data', '✖ данные неправильные'], ['concl', '✖ данные верны, вывод необоснованный'], ['unk', '? недостаточно доказательств']].map(([k, t]) => `<label><input type="radio" name="r${i}" value="${k}"> ${t}</label>`).join('')}</div>
 <input class="cm" placeholder="комментарий (необязательно)"></div>`).join('\n');
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Калибровка Хрюнебота</title>
<style>:root{color-scheme:light dark}body{font:15px/1.45 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:14px;background:#fff;color:#111}
@media (prefers-color-scheme:dark){body{background:#151517;color:#eee}.c{background:#1f1f23!important;border-color:#333!important}input.cm{background:#111;color:#eee;border-color:#444}}
.c{border:1px solid #ddd;border-radius:12px;padding:12px;margin:12px 0;background:#fafafa}.h a{margin-left:10px;font-size:13px}.t{margin:6px 0}
ul{margin:6px 0 8px 18px;padding:0}.r label{display:block;padding:5px 0}input.cm{width:100%;box-sizing:border-box;padding:7px;border-radius:8px;border:1px solid #ccc;font-size:15px}
button{font:600 15px system-ui;padding:10px 18px;border-radius:10px;border:0;background:#2f9e44;color:#fff;margin-top:10px}#out{width:100%;height:120px;margin-top:10px;font:12px monospace}</style></head><body>
<h2>Калибровка: ${sample.length} ников</h2>
<p>По каждому нику открой reddit и архив (rosint), посмотри, подтверждают ли материалы то, что утверждает Хрюнебот. Процент специально не показан. Ответы сохраняются в этом браузере; в конце — «Скопировать результаты» и вставь в чат.</p>
${cards}
<button id="copy">Скопировать результаты</button> <span id="cnt"></span><textarea id="out" readonly></textarea>
<script>
const KEY='hryu-calib-${SEED}';const save=()=>{const r={};document.querySelectorAll('.c').forEach((c,i)=>{const x=c.querySelector('input[type=radio]:checked');r[c.dataset.n]={a:x?x.value:'',c:c.querySelector('.cm').value}});try{localStorage.setItem(KEY,JSON.stringify(r))}catch{};const n=Object.values(r).filter(x=>x.a).length;document.getElementById('cnt').textContent='оценено '+n+' из ${sample.length}';return r};
try{const r=JSON.parse(localStorage.getItem(KEY)||'{}');document.querySelectorAll('.c').forEach(c=>{const v=r[c.dataset.n];if(!v)return;const x=c.querySelector('input[value="'+v.a+'"]');if(x)x.checked=true;c.querySelector('.cm').value=v.c||''})}catch{}
document.addEventListener('change',save);document.addEventListener('input',save);save();
document.getElementById('copy').onclick=()=>{const t=JSON.stringify({seed:${SEED},answers:save()});const o=document.getElementById('out');o.value=t;o.select();try{navigator.clipboard.writeText(t)}catch{}};
</script></body></html>`;
fs.writeFileSync(new URL(`dist/audit/calib-${SEED}.html`, ROOT), html);
console.log(`выборка: ${sample.length} ников; размеры категорий: ${CATS.map(([id]) => `${id} ${(byCat[id] || []).length}`).join(', ')}`);
for (const [id] of CATS) console.log(`  ${id}: ${sample.filter((x) => x.cat === id).map((x) => x.name).join(', ')}`);
