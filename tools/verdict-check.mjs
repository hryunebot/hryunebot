// Проверка вердикта по нахрюкам (score.js): орк / спорщик / непонятно и баллы.
// Запуск: node tools/verdict-check.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { URL };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../reddit-tagger/score.js', import.meta.url), 'utf8'), ctx);

const cases = [
  // [описание, up, down, ожидаемый вердикт]
  ['15 нахрюков, 11 плюсов / 4 минуса', 11, 4, 'own'],
  ['спорил: 2 плюса / 12 минусов', 2, 12, 'debater'],
  ['поровну 5 / 5', 5, 5, 'unclear'],
  ['оценок мало: 1 / 1', 1, 1, 'unclear'],
  ['без оценок', 0, 0, 'unclear'],
  ['ровно 60% плюсов: 3 / 2', 3, 2, 'own'],
  ['ровно 60% минусов: 2 / 3', 2, 3, 'debater'],
];
let bad = 0;
for (const [d, up, down, want] of cases) {
  const got = ctx.nahrukVerdict(up, down);
  if (got !== want) bad++;
  console.log(`${got === want ? 'ok ' : 'FAIL'}  ${d} -> ${got}`);
}
const full = ctx.nahrukPoints(15, 2);
const pct = (p) => ctx.botPercent(p, 7);
console.log(`\n15 нахрюков: орк ${pct(full)}%, орк? ${pct(full / 2)}%, спорщик ${pct(0)}%`);
// «👎 минусуют тут»
const H = ['tjournal_refugees'];
const hv1 = ctx.homeVotes({ tjournal_refugees: { up: 1, down: 6 }, pics: { up: 9, down: 1 } }, H);
const cases2 = [
  ['в tj минусуют, снаружи плюсуют → метка + контраст', hv1.hit && hv1.contrast, true],
  ['в tj минусуют, снаружи пусто → без контраста', ctx.homeVotes({ tjournal_refugees: { up: 0, down: 4 } }, H).contrast, false],
  ['в tj минусуют, снаружи пусто → метка есть', ctx.homeVotes({ tjournal_refugees: { up: 0, down: 4 } }, H).hit, true],
  ['в tj плюсуют → нет', ctx.homeVotes({ tjournal_refugees: { up: 8, down: 2 } }, H).hit, false],
  ['оценок мало (2) → нет', ctx.homeVotes({ tjournal_refugees: { up: 0, down: 2 } }, H).hit, false],
  ['52 плюса / 29 минусов (много минусов) → метка', ctx.homeVotes({ tjournal_refugees: { up: 52, down: 29 } }, H).hit, true],
  ['16 плюсов / 11 минусов (41%, 11 минусов) → метка', ctx.homeVotes({ tjournal_refugees: { up: 16, down: 11 } }, H).hit, true],
  ['20 плюсов / 7 минусов (26%, мало минусов) → нет', ctx.homeVotes({ tjournal_refugees: { up: 20, down: 7 } }, H).hit, false],
  ['40 плюсов / 10 минусов (20%) → нет', ctx.homeVotes({ tjournal_refugees: { up: 40, down: 10 } }, H).hit, false],
  ['281 плюс / 7 минусов → нет', ctx.homeVotes({ tjournal_refugees: { up: 281, down: 7 } }, H).hit, false],
  ['много минусов, но без 60% — контраста нет', ctx.homeVotes({ tjournal_refugees: { up: 52, down: 29 }, pics: { up: 9, down: 0 } }, H).contrast, false],
];
for (const [d, got, want] of cases2) { if (got !== want) bad++; console.log((got === want ? 'ok ' : 'FAIL') + '  ' + d + ' -> ' + got); }
// Метки правил по сабам: источник спорщика и разбор кодов с сервера
const RV = (subs, votes, home) => ctx.ruleVerdicts(subs, votes, home || ['tjournal_refugees']).tags.join('+');
const cases3 = [
  ['орочьи сабы, плюсуют → ork', RV({ ukrainerussiareport: 10 }, { ukrainerussiareport: { up: 8, down: 1 } }), 'ork'],
  ['орочьи сабы, минусуют → deb_ork', RV({ ukrainerussiareport: 10 }, { ukrainerussiareport: { up: 1, down: 8 } }), 'deb_ork'],
  ['клоунский саб, минусуют → deb_clown', RV({ reddituatalks: 5 }, { reddituatalks: { up: 0, down: 4 } }), 'deb_clown'],
  ['rusaskreddit, минусуют → deb_watch', RV({ rusaskreddit: 5 }, { rusaskreddit: { up: 0, down: 4 } }), 'deb_watch'],
  ['спорит у орков, свой в rusaskreddit → deb_ork+watch', RV({ ukrainerussiareport: 5, rusaskreddit: 5 }, { ukrainerussiareport: { up: 0, down: 5 }, rusaskreddit: { up: 5, down: 0 } }), 'deb_ork+watch'],
  ['«слежу» пропадает при 100+ плюсах в tj', RV({ rusaskreddit: 50 }, { rusaskreddit: { up: 30, down: 0 }, tjournal_refugees: { up: 120, down: 3 } }), ''],
  ['мало постов (2) → ничего', RV({ ukrainerussiareport: 2 }, { ukrainerussiareport: { up: 2, down: 0 } }), ''],
  ['разбор deb_clown', JSON.stringify(ctx.parseRuleCode('deb_clown')), '{"kind":"clown","verdict":"debater"}'],
  ['разбор watch?', JSON.stringify(ctx.parseRuleCode('watch?')), '{"kind":"watch","verdict":"unclear"}'],
  ['разбор старого debater', JSON.stringify(ctx.parseRuleCode('debater')), '{"kind":"ork","verdict":"debater"}'],
  ['не правило: kons', ctx.parseRuleCode('kons'), null],
];
for (const [d, got, want] of cases3) { if (got !== want) bad++; console.log((got === want ? 'ok ' : 'FAIL') + '  ' + d + ' -> ' + got); }
// «свій»
const TT = (up, down) => ctx.homeTrust({ tjournal_refugees: { up, down } }, ['tjournal_refugees']).trusted;
const cases4 = [
  ['281+/7− (владелец) → свій', TT(281, 7), true],
  ['100+/15− (87%) → свій', TT(100, 15), true],
  ['99+/0− (мало плюсов) → нет', TT(99, 0), false],
  ['150+/40− (79%) → нет', TT(150, 40), false],
  ['слабая метка: орк?', ctx.isWeakHit({ verdict: 'unclear' }), true],
  ['слабая метка: консерва?', ctx.isWeakHit({ kons: 'weak' }), true],
  ['консерва у «свого» тоже прячется (1.3.90)', ctx.isWeakHit({ kons: 'full' }), true],
  ['не слабая: мінусують', ctx.isWeakHit({ homeDown: {}, tag: 'минусуют' }), false],
  ['слабая метка: слежу', ctx.isWeakHit({ tag: 'слежу', verdict: 'own' }), true],
  ['не слабая: спорщик', ctx.isWeakHit({ tag: 'орк', verdict: 'debater' }), false],
  ['не слабая: орк', ctx.isWeakHit({ tag: 'орк', verdict: 'own' }), false],
  ['клоун у «свого» сворачивается (1.3.89)', ctx.isWeakHit({ tag: 'клоун', verdict: 'own' }), true],
  ['клоун-спорщик не сворачивается', ctx.isWeakHit({ tag: 'клоун', verdict: 'debater' }), false],
];
for (const [d, got, want] of cases4) { if (got !== want) bad++; console.log((got === want ? 'ok ' : 'FAIL') + '  ' + d + ' -> ' + got); }
// Вес поста (×3): один заплюсованный пост у орков = 3 «нахрюка»
const W = (subs, votes, subsP, votesP) => ctx.ruleVerdicts(subs, votes, ['tjournal_refugees'], subsP, votesP);
const w1 = W({ ukrainerussiareport: 1 }, { ukrainerussiareport: { up: 1, down: 0 } }, { ukrainerussiareport: 1 }, { ukrainerussiareport: { up: 1, down: 0 } });
const w2 = W({ ukrainerussiareport: 2 }, { ukrainerussiareport: { up: 2, down: 0 } }, {}, {});
const cases5 = [
  ['1 заплюсованный пост → только орк? (вес 3, < 6)', w1.tags.join('+'), 'ork?'],
  ['порог 6: 5 заплюсованных → орк?', W({ ukrainerussiareport: 5 }, { ukrainerussiareport: { up: 5, down: 0 } }).tags.join('+'), 'ork?'],
  ['порог 6: 6 заплюсованных → орк', W({ ukrainerussiareport: 6 }, { ukrainerussiareport: { up: 6, down: 0 } }).tags.join('+'), 'ork'],
  ['порог 6 и для клоуна: 4 → клоун?', W({ reddituatalks: 4 }, { reddituatalks: { up: 4, down: 0 } }).tags.join('+'), 'clown?'],
  ['2 заплюсованных поста = 6 нахрюков, но 2 подтверждения → только орк?', W({ ukrainerussiareport: 2 }, { ukrainerussiareport: { up: 2, down: 0 } }, { ukrainerussiareport: 2 }, { ukrainerussiareport: { up: 2, down: 0 } }).tags.join('+'), 'ork?'],
  ['1 пост + 3 коммента, все в плюсе: 4 записи < 5 → орк?', W({ ukrainerussiareport: 4 }, { ukrainerussiareport: { up: 4, down: 0 } }, { ukrainerussiareport: 1 }, { ukrainerussiareport: { up: 1, down: 0 } }).tags.join('+'), 'ork?'],
  ['2 поста + 3 коммента, все в плюсе: 5 записей → орк', W({ ukrainerussiareport: 5 }, { ukrainerussiareport: { up: 5, down: 0 } }, { ukrainerussiareport: 2 }, { ukrainerussiareport: { up: 2, down: 0 } }).tags.join('+'), 'ork'],
  ['спорщик по реальным: 1 пост в плюсе (×3 не перевешивает) + 3 коммента в минусе', W({ ukrainerussiareport: 4 }, { ukrainerussiareport: { up: 1, down: 3 } }, { ukrainerussiareport: 1 }, { ukrainerussiareport: { up: 1, down: 0 } }).tags.join('+'), 'deb_ork'],
  ['клоун 1.3.89: ×115 → потолок 2', String(ctx.rulePoints(ctx.DEFAULT_RULES[1], 115)), '2'],
  ['клоун 1.3.89: ×7 → 1.4 (не растёт до 2)', String(ctx.rulePoints(ctx.DEFAULT_RULES[1], 7)), '1.4'],
  ['серверный клоун ×115 → 2, клоун? → 1', ctx.srvRuleFull('clown', 115) + '/' + ctx.ruleHitPoints(ctx.srvRuleFull('clown', 115), 'unclear', 10, 0), '2/1'],
  ['серверный орк ×20 → за нахрюки (4), слежу → 1', ctx.srvRuleFull('ork', 20) + '/' + ctx.srvRuleFull('watch', 50), '4/1'],
  ['у орка потолка нет: ×115 → 23', String(ctx.rulePoints(ctx.DEFAULT_RULES[0], 115)), '23'],
  ['«клоун?» — сначала потолок, потом пополам: 1', String(ctx.ruleCap('clown', ctx.nahrukPoints(115, 2)) / 2), '1'],
  ['мало плюсов: 9 нахрюков, +4/−0 → орк?', W({ ukrainerussiareport: 9 }, { ukrainerussiareport: { up: 4, down: 0 } }).tags.join('+'), 'ork?'],
  ['5 плюсов: 9 нахрюков, +5/−0 → орк', W({ ukrainerussiareport: 9 }, { ukrainerussiareport: { up: 5, down: 0 } }).tags.join('+'), 'ork'],
  ['спорщика порог не трогает: 4 заминусованных', W({ ukrainerussiareport: 4 }, { ukrainerussiareport: { up: 0, down: 4 } }).tags.join('+'), 'deb_ork'],
  ['  счёт с весом, плюсы — реальные записи', w1.ev.ork.n + '/' + w1.ev.ork.up + '/' + w1.ev.ork.upW, '3/1/3'],
  ['  посты/комменты отдельно', w1.ev.ork.posts + '+' + w1.ev.ork.comments, '1+0'],
  ['2 коммента → мало (n=2)', w2.tags.join('+'), ''],
  ['без данных о постах — как раньше', W({ ukrainerussiareport: 10 }, { ukrainerussiareport: { up: 8, down: 1 } }).tags.join('+'), 'ork'],
];
for (const [d, got, want] of cases5) { if (got !== want) bad++; console.log((got === want ? 'ok ' : 'FAIL') + '  ' + d + ' -> ' + got); }
// Спорщик −1: автобаллы не ниже нуля, жалобы людей не трогает
const P = (people, auto) => ctx.botPercent(ctx.botPoints(people, people, Math.max(0, auto.reduce((a, b) => a + b, 0))), 7);
const cases6 = [
  ['консерва (4) + спорщик (−1) → как 3 балла', P(0, [4, ctx.DEBATER_POINTS]), P(0, [3])],
  ['только спорщик → 0%', P(0, [ctx.DEBATER_POINTS]), 0],
  ['2 жалобы + спорщик → жалобы целиком', P(2, [ctx.DEBATER_POINTS]), P(2, [])],
];
for (const [d, got, want] of cases6) { if (got !== want) bad++; console.log((got === want ? 'ok ' : 'FAIL') + '  ' + d + ' -> ' + got + '%'); }
// «Свій»: два пути (1.3.79) и вариант C для баллов «?»
const TJ = (up, down, pUp = 0, pDown = 0) => ({ tjournal_refugees: { up, down } });
const TP = (pUp, pDown) => ({ tjournal_refugees: { up: pUp, down: pDown } });
const cases7 = [
  ['старый путь: 100+ плюсов, 85%+', ctx.homeTrust(TJ(110, 5), ['tjournal_refugees'], {}, 50).way, 'old'],
  ['новый путь: 60+ комментов в плюсе, 85%+, история упёрлась', ctx.homeTrust(TJ(70, 5), ['tjournal_refugees'], {}, 100).way, 'new'],
  ['новый путь не работает без упора в лимит', ctx.homeTrust(TJ(70, 5), ['tjournal_refugees'], {}, 60).trusted, false],
  ['новый путь считает только комменты: 70 плюсов, из них 15 постов → 55 < 60', ctx.homeTrust(TJ(70, 5), ['tjournal_refugees'], TP(15, 0), 120).trusted, false],
  ['новый путь: доля < 85% → нет', ctx.homeTrust(TJ(70, 20), ['tjournal_refugees'], {}, 150).trusted, false],
  ['из цифр вердикта без cUp/trunc — только старый путь', ctx.trustOf({ up: 90, down: 2 }).trusted, false],
  ['из цифр вердикта с cUp/trunc — новый путь', ctx.trustOf({ up: 90, down: 2, cUp: 80, cDown: 2, trunc: true }).way, 'new'],
  ['свій по старому: уверенный клоун пополам', ctx.trustedPoints({ kind: 'clown', verdict: 'own', points: 6 }, 'old'), 3],
  ['свій по новому: уверенный клоун в полную силу', ctx.trustedPoints({ kind: 'clown', verdict: 'own', points: 6 }, 'new'), 6],
  ['свій по новому: уверенный орк (метка расширения) в полную силу', ctx.trustedPoints({ tag: 'орк', verdict: 'own', points: 4 }, 'new'), 4],
  ['свій по новому: консерва — пополам, как раньше', ctx.trustedPoints({ kons: 'full', points: 4 }, 'new'), 2],
  ['свій по новому: спорщик — пополам, как раньше', ctx.trustedPoints({ kind: 'ork', verdict: 'debater', points: -1 }, 'new'), -0.5],
  ['C: свой там — полные баллы', ctx.ruleHitPoints(4, 'own', 9, 1), 4],
  ['C: спорщик — как раньше', ctx.ruleHitPoints(4, 'debater', 1, 9), -1],
  ['C: «?» с малым числом оценок — половина', ctx.ruleHitPoints(4, 'unclear', 1, 1), 2],
  ['C: «?» при 40% минусов — половина', +ctx.ruleHitPoints(4, 'unclear', 6, 4).toFixed(2), 2],
  ['C: «?» при 50% минусов — четверть', +ctx.ruleHitPoints(4, 'unclear', 5, 5).toFixed(2), 1],
  ['C: «?» при 59% минусов — почти ноль', ctx.ruleHitPoints(4, 'unclear', 41, 59) < 0.11, true],
  ['C: определение спорщика не менялось (60% минусов)', ctx.nahrukVerdict(4, 6), 'debater'],
];
for (const [d, got, want] of cases7) { if (got !== want) bad++; console.log((got === want ? 'ok ' : 'FAIL') + '  ' + d + ' -> ' + got); }
// Вид значков (1.3.82): сворачивание и скрытый нахрюкометр у «своих»
const cases8 = [
  ['авто: 2 метки — не сворачивать', ctx.badgesCompact('auto', 2), false],
  ['авто: 3 метки — сворачивать', ctx.badgesCompact('auto', 3), true],
  ['без настройки — как авто', ctx.badgesCompact(undefined, 3), true],
  ['всегда — даже одна метка', ctx.badgesCompact('always', 1), true],
  ['никогда — даже пять меток', ctx.badgesCompact('never', 5), false],
  ['авто на телефоне/узком окне — сворачивать даже 1 метку (13.11)', ctx.badgesCompact('auto', 1, true), true],
  ['«никогда» действует и на телефоне', ctx.badgesCompact('never', 5, true), false],
  ['число у метки — реальные записи: 18 пост. + 3 комм. = 21, не 57', ctx.hitCount({ n: 57, posts: 18, comments: 3 }), 21],
  ['число без разбивки на посты/комменты — n как есть', ctx.hitCount({ n: 6 }), 6],
  ['свій, 9% — нахрюкометр не показываем', ctx.meterHidden(9, true), true],
  ['свій, 10% — показываем', ctx.meterHidden(10, true), false],
  ['не свій, 3% — показываем', ctx.meterHidden(3, false), false],
];
for (const [d, got, want] of cases8) { if (got !== want) bad++; console.log((got === want ? 'ok ' : 'FAIL') + '  ' + d + ' -> ' + got); }
// 1.3.89: ruAsska убран из «орка», expectedrussians — «мягкий» (по нему одному максимум «орк?»)
const E = (subs, votes) => ctx.ruleVerdicts(subs, votes, ['tjournal_refugees']).tags.join('+');
const S = (o) => {
  const st = { autoRules: [{ icon: '👹', tag: 'орк', subs: ['ukrainerussiareport', 'genzedong', 'ruasska', 'expectedrussians', 'vataru'], min: 3, points: 2 }, { tag: 'слежу', subs: ['rusaskreddit'], flat: true, trustHome: 100 }], orkV: o };
  ctx.migratePresets(st); return st;
};
const m5 = S(5), m6 = S(6);
const cases9 = [
  ['ruAsska, 20 плюсов → ничего', E({ ruasska: 20 }, { ruasska: { up: 20, down: 0 } }), ''],
  ['expectedrussians, 20 плюсов → только орк?', E({ expectedrussians: 20 }, { expectedrussians: { up: 20, down: 0 } }), 'ork?'],
  ['expectedrussians, минусуют → спорщик (как раньше)', E({ expectedrussians: 10 }, { expectedrussians: { up: 1, down: 8 } }), 'deb_ork'],
  ['expectedrussians 20 + vataRU 2 → орк? (vataRU мало)', E({ expectedrussians: 20, vataru: 2 }, { expectedrussians: { up: 20, down: 0 }, vataru: { up: 2, down: 0 } }), 'ork?'],
  ['expectedrussians + ukrainerussiareport 8 (+7) → орк', E({ expectedrussians: 20, ukrainerussiareport: 8 }, { expectedrussians: { up: 20, down: 0 }, ukrainerussiareport: { up: 7, down: 0 } }), 'ork'],
  ['ukrainerussiareport 8 (+7) без expectedrussians → орк', E({ ukrainerussiareport: 8 }, { ukrainerussiareport: { up: 7, down: 0 } }), 'ork'],
  ['миграция v6: ruasska убран', m5.autoRules[0].subs.includes('ruasska'), false],
  ['миграция v6: expectedrussians мягкий', JSON.stringify(m5.autoRules[0].soft), '["expectedrussians"]'],
  ['миграция: номер 6', m5.orkV, 6],
  ['уже v6 — не трогаем (владелец вернул ruasska руками)', m6.autoRules[0].subs.includes('ruasska'), true],
  ['сохранение настроек: flat/trustHome не теряются', JSON.stringify(ctx.keepRuleExtras({ tag: 'слежу', subs: ['rusaskreddit'] }, m5.autoRules)), '{"tag":"слежу","subs":["rusaskreddit"],"flat":true,"trustHome":100}'],
  ['сохранение настроек: soft только из оставшихся сабов', JSON.stringify(ctx.keepRuleExtras({ tag: 'орк', subs: ['genzedong'] }, m5.autoRules).soft), undefined],
];
for (const [d, got, want] of cases9) { if (got !== want) bad++; console.log((got === want ? 'ok ' : 'FAIL') + '  ' + d + ' -> ' + got); }
process.exit(bad ? 1 : 0);
