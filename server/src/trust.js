// Хрюнебот: довірені користувачі (WISHLIST п.14, владелец + ГПТ 13.11.2026).
// В ОБЩИЙ слой (видно всем) идут только метки и жалобы довірених; один reddit-аккаунт = один голос, сколько бы у него
// ни было установок. Довіреним становится «свій» (в т.ч. автоматический) без плохих меток — после подтверждения, что
// reddit-аккаунт его: случайный одноразовый код (срок 24 ч, привязан к токену установки) человек пишет комментом в
// r/tjournal_refugees, сервер по расписанию находит этот коммент в архиве от этого автора. Плюс ручной допуск владельцем.
// Доверие бессрочное, отзывает владелец; при отзыве голоса перестают учитываться (общий слой считается при каждом запросе).
//
// Приватность: id аккаунта — HMAC(нормализованный ник, секрет сервера TRUST_SECRET) — простой хеш ника перебирается.
// Ник хранится только в заявке (trust_pending) до подтверждения или истечения срока — потом строка удаляется.
// Связка «токен ↔ аккаунт» — только id (members.acct), ника там нет. В логи ник и код не пишем.

const USER_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const TRUST = {
  startsPerDay: 5, // заявок (новых кодов) с одной установки в сутки
  codeTtl: 3 * 24 * 60 * 60 * 1000, // код действует 3 суток (13.11: архив ArcticShift бывает позади на 1,5+ суток)
  recheckMs: 2 * 60 * 1000, // одну заявку проверяем не чаще раза в 2 минуты
  sub: 'tjournal_refugees',
  // Отказ в автоматическом допуске дают ТОЛЬКО автоматические признаки проверки архивом (владелец, 13.11): не «свій»,
  // 👹 орк, 🤷 орк?, 🥫 консерва (полная), 👎 мінусують. Ручные метки людей в решение НЕ входят. Ручной допуск владельца — всегда.
  bad: ['ork', 'ork?', 'kons', 'homedown'],
};
// Пороги общего слоя (владелец, 13.11): 3 разных довірених аккаунта и для меток, и для жалоб; настройки сервера, без автороста
export const trustTagMin = (env) => Math.min(Math.max(parseInt(env && env.TRUST_TAG_MIN, 10) || 3, 1), 1000);
export const trustComplaintMin = (env) => Math.min(Math.max(parseInt(env && env.TRUST_COMPLAINT_MIN, 10) || 3, 1), 1000);

export function normNick(s) { return String(s || '').trim().replace(/^\/?u\//i, '').toLowerCase(); }

// id аккаунта: HMAC-SHA256(нормализованный ник) секретом сервера, hex
export async function acctOf(env, nick) {
  const secret = env && env.TRUST_SECRET;
  if (!secret || String(secret).length < 16) { const e = new Error('Доверие не настроено на сервере'); e.status = 503; throw e; }
  const n = normNick(nick);
  if (!USER_RE.test(n)) { const e = new Error('Неверный ник'); e.status = 400; throw e; }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('acct:' + n));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// случайный код: hryu- + 10 символов без похожих (0/O, 1/I/L)
export function newCode() {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(10));
  return 'hryu-' + [...b].map((x) => A[x % A.length]).join('');
}

// SQL: голос/жалоба засчитывается в общий слой, только если её участник привязан к довіреному (не отозванному) аккаунту
export const TRUSTED_JOIN = (alias) => `JOIN members tm ON tm.token_hash = ${alias}.member JOIN trusted tt ON tt.acct = tm.acct AND tt.revoked IS NULL`;

// Статус для участника (без ника)
export async function trustStatus(db, member) {
  const m = await db.prepare('SELECT m.acct, m.blocked, t.revoked, t.by FROM members m LEFT JOIN trusted t ON t.acct = m.acct WHERE m.token_hash = ?').bind(member).first();
  if (m && m.blocked) return { status: 'blocked' }; // п.15: отключено сменой ключа синхронизации
  if (m && m.acct && m.by && !m.revoked) return { status: 'trusted', by: m.by };
  if (m && m.acct && m.revoked) return { status: 'revoked' };
  const p = await db.prepare('SELECT code, expires, created, checked, tries FROM trust_pending WHERE token_hash = ?').bind(member).first();
  // в ожидании: сколько раз сервер уже искал коммент и когда последний раз — чтобы человек не гадал, что происходит
  if (p && p.expires > Date.now()) return { status: 'pending', code: p.code, expires: p.expires, created: p.created, tries: p.tries || 0, checked: p.checked || 0 };
  const s = await db.prepare('SELECT status, reason FROM trust_status WHERE token_hash = ?').bind(member).first();
  if (s) return { status: s.status, reason: s.reason || null };
  return { status: 'none' };
}

// Одна проверка заявки (из расписания автоочереди): ищем коммент с кодом от этого автора в tj после выдачи кода.
// fetchArchJson(url) → { ok, data } — через общий шлагбаум/кэш автоочереди; check(nick) → вердикт архива (archVerdict);
// trustOf(home) — из score.js. Неполный ответ архива — заявка остаётся «в ожидании», попробуем снова.
export async function checkOnePending(db, env, { fetchArchJson, check, trustOf, now = Date.now() }) {
  await db.prepare('DELETE FROM trust_pending WHERE expires <= ?').bind(now).run(); // просроченные — вместе с ником
  const p = await db.prepare('SELECT token_hash, nick, code, created FROM trust_pending WHERE COALESCE(checked, 0) < ? ORDER BY COALESCE(checked, 0), created LIMIT 1')
    .bind(now - TRUST.recheckMs).first();
  if (!p) return null;
  await db.prepare('UPDATE trust_pending SET checked = ?, tries = COALESCE(tries, 0) + 1 WHERE token_hash = ?').bind(now, p.token_hash).run();
  const url = `https://arctic-shift.photon-reddit.com/api/comments/search?author=${encodeURIComponent(p.nick)}&after=${Math.floor(p.created / 1000) - 60}&limit=100&sort=desc&fields=body,subreddit,created_utc`;
  const r = await fetchArchJson(url);
  if (!r || !r.ok) return { pending: true, error: 'archive' };
  const found = r.data.some((c) => String(c.subreddit || '').toLowerCase() === TRUST.sub && String(c.body || '').includes(p.code));
  if (!found) return { pending: true };
  // коммент найден — аккаунт его; решаем допуск
  const acct = await acctOf(env, p.nick);
  const t = await db.prepare('SELECT by, revoked FROM trusted WHERE acct = ?').bind(acct).first();
  let status = 'trusted', reason = null;
  if (t && t.revoked) { status = 'revoked'; reason = 'доступ отозван владельцем'; }
  else if (!t) {
    let v = null;
    try { v = await check(p.nick); } catch { return { pending: true, error: 'archive' }; } // проверка не завершена — подождём
    const tr = v && v.ev && v.ev.home ? trustOf(v.ev.home) : { trusted: false };
    const bad = (v && v.tags || []).filter((x) => TRUST.bad.includes(x));
    if (!tr.trusted) { status = 'denied'; reason = 'не «свой» в r/tjournal_refugees'; }
    else if (bad.length) { status = 'denied'; reason = 'есть метки: ' + bad.join(', '); }
  }
  const stmts = [
    db.prepare('DELETE FROM trust_pending WHERE token_hash = ?').bind(p.token_hash), // ник больше не нужен
    db.prepare('INSERT OR REPLACE INTO trust_status (token_hash, status, reason, t) VALUES (?, ?, ?, ?)').bind(p.token_hash, status, reason, now),
  ];
  if (status === 'trusted' || status === 'revoked') stmts.push(db.prepare('UPDATE members SET acct = ? WHERE token_hash = ?').bind(acct, p.token_hash));
  if (status === 'trusted' && !t) stmts.push(db.prepare("INSERT OR IGNORE INTO trusted (acct, by, granted, revoked) VALUES (?, 'auto', ?, NULL)").bind(acct, now));
  await db.batch(stmts);
  return { done: status };
}

// Владелец подтверждает заявку вручную (архив отстаёт, а человека он знает) — ПО КОДУ одной заявки, не по нику: ник в
// заявке может быть чужим. Владелец сверяет код с человеком в знакомом канале связи и подтверждает именно эту установку.
export async function approvePending(db, env, code, now = Date.now()) {
  const c = String(code || '').trim().toLowerCase();
  const p = await db.prepare('SELECT token_hash, nick FROM trust_pending WHERE code = ? AND expires > ?').bind(c, now).first();
  if (!p) { const e = new Error('Заявка с таким кодом не найдена'); e.status = 404; throw e; }
  const rows = [{ token_hash: p.token_hash }];
  const n = p.nick;
  const acct = await acctOf(env, n);
  const stmts = [db.prepare("INSERT INTO trusted (acct, by, granted, revoked) VALUES (?, 'manual', ?, NULL) ON CONFLICT(acct) DO UPDATE SET by = 'manual', revoked = NULL").bind(acct, now)];
  for (const r of rows) {
    stmts.push(db.prepare('UPDATE members SET acct = ? WHERE token_hash = ?').bind(acct, r.token_hash));
    stmts.push(db.prepare("INSERT OR REPLACE INTO trust_status (token_hash, status, reason, t) VALUES (?, 'trusted', NULL, ?)").bind(r.token_hash, now));
  }
  stmts.push(db.prepare('DELETE FROM trust_pending WHERE token_hash = ?').bind(p.token_hash));
  await db.batch(stmts);
  return { linked: rows.length, id: acct.slice(0, 8) };
}
