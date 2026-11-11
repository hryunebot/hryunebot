// Reddit Tagger — общий сервер для групп (Cloudflare Workers + D1).
//
// Группа: создатель получает код приглашения, остальные входят по коду.
// Метка группы показывается у ника, когда её поставили не меньше min_votes участников.

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-admin-key',
};
const DAY = 86400000;
const DAILY_TAG_LIMIT = 1000; // меток в сутки на участника
const DAILY_COMPLAINT_LIMIT = 300; // жалоб в сутки на участника
const USER_RE = /^[A-Za-z0-9_-]{1,32}$/;
// Вердикты автопроверки: только известные коды меток; «clean» — проверен, ничего не нашли (чтобы другие не перепроверяли).
const VERDICT_TAGS = new Set(['kons', 'kons?', 'homedown', 'ork', 'ork?', 'clown', 'clown?', 'watch', 'watch?', 'debater', 'deb_ork', 'deb_clown', 'deb_watch', 'novoreg', 'hidden', 'clean']);
const VERDICT_TTL = 30 * DAY;
const ALPH = 'abcdefghjkmnpqrstuvwxyz23456789';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

const rnd = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => ALPH[b % ALPH.length]).join('');
async function sha(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const cleanTag = (t) => String(t ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
const cleanSub = (s) => (s ? String(s).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30) : '') || null;
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function auth(db, req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) fail(401, 'Нет токена');
  const row = await db
    .prepare('SELECT m.token_hash, g.id, g.name, g.code, g.min_votes FROM members m JOIN groups g ON g.id = m.group_id WHERE m.token_hash = ?')
    .bind(await sha(token))
    .first();
  if (!row) fail(401, 'Токен не найден — войдите в группу заново');
  return { member: row.token_hash, group: { id: row.id, name: row.name, code: row.code, minVotes: row.min_votes } };
}

const PUBLIC = 'public'; // общий слой для всех пользователей: жалобы + базовые метки
// В общий слой идут только базовые метки (свои — нет); видны, когда метку поставили 3+ разных человека (владелец, 09.11).
const PUBLIC_TAGS = new Set(['зрадойоб', 'орк', 'новорег', 'консерва']);
const PUBLIC_TAG_MIN = 3;
const PUBLIC_TAG_LIMIT = 200; // меток в сутки на участника общего слоя
// Очередь новых ников (1.3.80): не больше 30 за раз и 200 в сутки от участника; предварительные цифры — до 1000 символов.
const QUEUE_BATCH = 30, QUEUE_DAY = 200, QUEUE_EV_MAX = 1000;
const JOINS_PER_IP_DAY = 5;

// Анонимность жалобщиков: время храним грубо, чтобы нельзя было сопоставить
// «кто когда сидел на reddit» или «какой IP вошёл → какой участник появился».
const HOUR = 3600000;
const toDay = (t) => Math.floor(t / DAY) * DAY;
const toHour = (t) => Math.floor(t / HOUR) * HOUR;

// Не больше 5 вступлений/групп в сутки с одного IP. Хэш IP солится текущей датой,
// поэтому завтра тот же адрес даст другой хэш — связать IP между днями нельзя.
async function checkJoinRate(db, req) {
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const day = toDay(Date.now());
  const h = await sha(`rt-salt:${day}:${ip}`);
  await db.prepare('DELETE FROM joins WHERE created < ?').bind(day).run(); // вчерашние записи не нужны
  const r = await db.prepare('SELECT COUNT(*) n FROM joins WHERE ip_hash = ?').bind(h).first();
  if (r.n >= JOINS_PER_IP_DAY) fail(429, 'Слишком много новых входов с этого адреса, попробуйте завтра');
  await db.prepare('INSERT INTO joins (ip_hash, created) VALUES (?, ?)').bind(h, day).run();
}

const notPublic = (group) => { if (group.id === PUBLIC) fail(403, 'В общем слое только жалобы'); };

async function addMember(db, groupId) {
  const token = rnd(32);
  await db.prepare('INSERT INTO members (token_hash, group_id, created) VALUES (?, ?, ?)').bind(await sha(token), groupId, toDay(Date.now())).run();
  return token;
}

// ---------- админка владельца ----------
// Владелец видит не людей, а постоянный обезличенный номер участника («Ж-3fa9c1»),
// чтобы находить спамеров и стирать их жалобы. IP и время входа не раскрываются.
// Ключ админа: сервер хранит только его sha256 в таблице admin (как пароль на сайте).
// Номера жалобщиков солятся этим хэшем, поэтому без базы их не пересчитать.
async function adminAuth(db, req) {
  const key = (req.headers.get('x-admin-key') || '').trim();
  const row = await db.prepare('SELECT key_hash FROM admin WHERE id = 1').first();
  if (!row) fail(403, 'Ключ админа на сервере не задан');
  if (key.length < 16 || (await sha('admin:' + key)) !== row.key_hash) fail(403, 'Неверный ключ админа');
  return row.key_hash;
}
const pseudo = async (salt, member) => 'Ж-' + (await sha('who:' + salt + member)).slice(0, 6);

async function adminGroup(db, code) {
  const c = String(code || PUBLIC).trim().toLowerCase();
  const g = await db.prepare('SELECT id, name, code FROM groups WHERE code = ?').bind(c).first();
  if (!g) fail(404, 'Группа не найдена');
  return g;
}

const routes = {
  'GET /': async () => json({ ok: true, app: 'reddit-tagger' }),

  // Создать группу
  'POST /groups': async (db, body, req) => {
    await checkJoinRate(db, req);
    const name = String(body.name || '').trim().slice(0, 60) || 'Моя группа';
    const minVotes = Math.min(Math.max(parseInt(body.minVotes) || 2, 1), 50);
    const id = rnd(12);
    const code = rnd(10);
    await db.prepare('INSERT INTO groups (id, name, code, min_votes, created) VALUES (?, ?, ?, ?, ?)').bind(id, name, code, minVotes, Date.now()).run();
    const token = await addMember(db, id);
    return json({ token, group: { name, code, minVotes } });
  },

  // Вступить по коду
  'POST /join': async (db, body, req) => {
    const code = String(body.code || '').trim().toLowerCase();
    const g = await db.prepare('SELECT id, name, code, min_votes FROM groups WHERE code = ?').bind(code).first();
    if (!g) fail(404, 'Группа с таким кодом не найдена');
    await checkJoinRate(db, req);
    const token = await addMember(db, g.id);
    return json({ token, group: { name: g.name, code: g.code, minVotes: g.min_votes } });
  },

  'GET /me': async (db, _b, req) => {
    const { group } = await auth(db, req);
    const m = await db.prepare('SELECT COUNT(*) n FROM members WHERE group_id = ?').bind(group.id).first();
    return json({ group, members: m.n });
  },

  // Поставить свои метки: { items: [{ user, tags: [...], sub }] } — заменяет прежние метки этого участника на юзера.
  'POST /vote': async (db, body, req) => {
    const { member, group } = await auth(db, req);
    const pub = group.id === PUBLIC;
    const items = (Array.isArray(body.items) ? body.items : [body]).slice(0, 100);
    const used = await db.prepare('SELECT COUNT(*) n FROM votes WHERE member = ? AND created > ?').bind(member, Date.now() - DAY).first();
    let budget = (pub ? PUBLIC_TAG_LIMIT : DAILY_TAG_LIMIT) - used.n;
    const now = Date.now();
    const stmts = [];
    for (const it of items) {
      const name = String(it.user || '').replace(/^\/?u\//i, '');
      if (!USER_RE.test(name)) continue;
      const user = name.toLowerCase();
      const tags = [...new Set((it.tags || []).map(cleanTag).filter((t) => t && (!pub || PUBLIC_TAGS.has(t))))].slice(0, 10);
      stmts.push(db.prepare('DELETE FROM votes WHERE group_id = ? AND member = ? AND user = ?').bind(group.id, member, user));
      for (const tag of tags) {
        if (budget-- <= 0) fail(429, 'Лимит меток на сегодня исчерпан');
        stmts.push(db.prepare('INSERT INTO votes (group_id, member, user, name, tag, sub, created) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(group.id, member, user, name, tag, cleanSub(it.sub), now));
      }
    }
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  },

  // Метки группы для списка ников: { users: [...] } → { users: { ник: { метка: голосов } } }
  'POST /lookup': async (db, body, req) => {
    const { group } = await auth(db, req);
    const names = [...new Set((body.users || []).map((u) => String(u).toLowerCase()).filter((u) => USER_RE.test(u)))].slice(0, 400);
    const out = {};
    const complaints = {};
    for (const part of chunk(names, 90)) { // у D1 лимит 100 параметров на запрос
      const ph = part.map(() => '?').join(',');
      const [v, c] = await db.batch([
        db.prepare(`SELECT user, tag, COUNT(*) c FROM votes WHERE group_id = ? AND user IN (${ph}) GROUP BY user, tag HAVING c >= ?`).bind(group.id, ...part, group.id === PUBLIC ? PUBLIC_TAG_MIN : group.minVotes),
        // В общем слое жалобы видны, только когда пожаловались минимум min_votes разных людей.
        db.prepare(`SELECT user, COUNT(*) n, COUNT(DISTINCT member) p FROM complaints WHERE group_id = ? AND user IN (${ph}) GROUP BY user HAVING p >= ?`)
          .bind(group.id, ...part, group.id === PUBLIC ? group.minVotes : 1),
      ]);
      for (const r of v.results) (out[r.user] ??= {})[r.tag] = r.c;
      for (const r of c.results) complaints[r.user] = { n: r.n, p: r.p };
    }
    // Вердикты автопроверки (выгрузил владелец) — общие для всех, независимо от группы.
    const verdicts = {};
    const now = Date.now();
    for (const part of chunk(names, 90)) {
      const ph = part.map(() => '?').join(',');
      const r = await db.prepare(`SELECT user, tags, evidence, checked FROM verdicts WHERE expires > ? AND user IN (${ph})`).bind(now, ...part).all();
      for (const x of r.results) {
        try { verdicts[x.user] = { tags: JSON.parse(x.tags), ev: x.evidence ? JSON.parse(x.evidence) : null, checked: toDay(x.checked) }; } catch { /* битая строка — пропускаем */ }
      }
    }
    return json({ users: out, complaints, verdicts, minVotes: group.id === PUBLIC ? PUBLIC_TAG_MIN : group.minVotes });
  },

  // Вердикты владельца — открыто, без входа (это публичные выводы из публичных данных reddit):
  // { users: [...] } → { verdicts: { ник: { tags, ev, checked } } }
  'POST /verdicts': async (db, body) => {
    const names = [...new Set((body.users || []).map((u) => String(u).toLowerCase()).filter((u) => USER_RE.test(u)))].slice(0, 400);
    const verdicts = {};
    const now = Date.now();
    for (const part of chunk(names, 90)) {
      const ph = part.map(() => '?').join(',');
      const r = await db.prepare(`SELECT user, tags, evidence, checked FROM verdicts WHERE expires > ? AND user IN (${ph})`).bind(now, ...part).all();
      for (const x of r.results) {
        try { verdicts[x.user] = { tags: JSON.parse(x.tags), ev: x.evidence ? JSON.parse(x.evidence) : null, checked: toDay(x.checked) }; } catch { /* битая строка */ }
      }
    }
    return json({ verdicts });
  },

  // Очередь новых ников: { items: [{ user, tags, ev }] } — ники, которые расширение проверило само и которых нет на сервере.
  // Только общий слой (токен выдаётся автоматически). Метки/цифры — предварительные: не публикуются, только подсказка владельцу.
  // Один ник — одна строка; от одного участника ник засчитывается один раз.
  'POST /queue': async (db, body, req) => {
    const { member, group } = await auth(db, req);
    if (group.id !== PUBLIC) fail(403, 'Только общий слой');
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, QUEUE_BATCH);
    const used = await db.prepare('SELECT COUNT(*) n FROM queue_rep WHERE member = ? AND created > ?').bind(member, Date.now() - DAY).first();
    let budget = QUEUE_DAY - used.n;
    const now = Date.now();
    const out = { added: 0, dup: 0, known: 0, skipped: 0 };
    const seen = new Set();
    for (const it of items) {
      const name = String(it.user || '').replace(/^\/?u\//i, '');
      if (!USER_RE.test(name)) { out.skipped++; continue; }
      const user = name.toLowerCase();
      if (seen.has(user)) { out.dup++; continue; }
      seen.add(user);
      if (budget <= 0) { out.skipped++; continue; }
      // уже есть действующий вердикт — в очередь не нужно
      const v = await db.prepare('SELECT 1 FROM verdicts WHERE user = ? AND expires > ?').bind(user, now).first();
      if (v) { out.known++; continue; }
      const rep = await db.prepare('INSERT OR IGNORE INTO queue_rep (user, member, created) VALUES (?, ?, ?)').bind(user, member, now).run();
      const fresh = (rep.meta?.changes || 0) > 0;
      if (fresh) budget--;
      const q = await db.prepare('SELECT status FROM queue WHERE user = ?').bind(user).first();
      if (q) {
        out.dup++;
        if (fresh) await db.prepare('UPDATE queue SET reports = reports + 1, last = ? WHERE user = ?').bind(now, user).run();
        continue;
      }
      const tags = [...new Set((it.tags || []).map(String).filter((t) => VERDICT_TAGS.has(t)))];
      let ev = null;
      try { ev = it.ev ? JSON.stringify(it.ev) : null; } catch { ev = null; }
      if (ev && ev.length > QUEUE_EV_MAX) ev = null;
      await db.prepare('INSERT INTO queue (user, name, first, last, reports, pre_tags, pre_ev, status) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
        .bind(user, name, now, now, JSON.stringify(tags), ev, 'new').run();
      out.added++;
    }
    return json({ ok: true, ...out });
  },

  // Жалоба на пост/коммент: { user, thing, sub, reason, link, undo? }
  'POST /complain': async (db, body, req) => {
    const { member, group } = await auth(db, req);
    const name = String(body.user || '').replace(/^\/?u\//i, '');
    if (!USER_RE.test(name)) fail(400, 'Некорректный ник');
    const user = name.toLowerCase();
    const thing = String(body.thing || '').slice(0, 30) || 'manual-' + rnd(10);
    if (body.undo) {
      await db.prepare('DELETE FROM complaints WHERE group_id = ? AND member = ? AND user = ? AND thing = ?').bind(group.id, member, user, thing).run();
      return json({ ok: true });
    }
    const used = await db.prepare('SELECT COUNT(*) n FROM complaints WHERE member = ? AND created > ?').bind(member, Date.now() - DAY).first();
    if (used.n >= DAILY_COMPLAINT_LIMIT) fail(429, 'Лимит жалоб на сегодня исчерпан');
    const link = /^https:\/\/(www\.|old\.)?reddit\.com\//.test(String(body.link || '')) ? String(body.link).slice(0, 300) : null;
    await db
      .prepare('INSERT OR IGNORE INTO complaints (group_id, member, user, name, thing, sub, reason, link, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(group.id, member, user, name, thing, cleanSub(body.sub), cleanTag(body.reason) || null, link, toHour(Date.now()))
      .run();
    const c = await db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT member) p FROM complaints WHERE group_id = ? AND user = ?').bind(group.id, user).first();
    const hidden = group.id === PUBLIC && c.p < group.minVotes; // ниже порога чужие жалобы не раскрываем
    return json({ ok: true, complaints: hidden ? { n: 0, p: 0 } : { n: c.n, p: c.p } });
  },

  // Встречи: { items: [{ user, sub, thing }] }. Засчитываются только юзеры, у которых в группе есть метки.
  'POST /sightings': async (db, body, req) => {
    const { group } = await auth(db, req);
    notPublic(group);
    const now = Date.now();
    const stmts = [];
    for (const it of (body.items || []).slice(0, 200)) {
      const user = String(it.user || '').toLowerCase();
      const thing = String(it.thing || '').slice(0, 30);
      const sub = cleanSub(it.sub);
      if (!USER_RE.test(user) || !thing || !sub) continue;
      stmts.push(
        db.prepare('INSERT OR IGNORE INTO sightings (group_id, user, thing, sub, created) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM votes WHERE group_id = ? AND user = ?) OR EXISTS (SELECT 1 FROM complaints WHERE group_id = ? AND user = ?)')
          .bind(group.id, user, thing, sub, now, group.id, user, group.id, user),
      );
    }
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true, n: stmts.length });
  },

  // Все жалобы группы (последние 1000), с пометкой, какие мои.
  'GET /complaints': async (db, _b, req) => {
    const { member, group } = await auth(db, req);
    // В общем слое: мои жалобы + жалобы на тех, на кого пожаловались минимум min_votes разных людей.
    const min = group.id === PUBLIC ? group.minVotes : 1;
    const { results } = await db
      .prepare(`SELECT member, user, name, thing, sub, reason, link, created FROM complaints
        WHERE group_id = ?1 AND (member = ?2 OR user IN (SELECT user FROM complaints WHERE group_id = ?1 GROUP BY user HAVING COUNT(DISTINCT member) >= ?3))
        ORDER BY created DESC, user, thing LIMIT 1000`) // не по порядку вставки, чтобы не выдавать очерёдность
      .bind(group.id, member, min)
      .all();
    return json({
      complaints: results.map((r) => ({
        user: r.user, name: r.name, thing: r.thing, sub: r.sub, reason: r.reason, link: r.link, created: toDay(r.created),
        mine: r.member === member,
      })),
    });
  },

  // ---------- админка (заголовок x-admin-key) ----------

  // Все жалобы группы с обезличенным номером жалобщика. ?group=код (по умолчанию общий слой).
  'GET /admin/complaints': async (db, _b, req) => {
    const salt = await adminAuth(db, req);
    const g = await adminGroup(db, new URL(req.url).searchParams.get('group'));
    const { results } = await db
      .prepare('SELECT member, name, thing, sub, reason, link, created FROM complaints WHERE group_id = ? ORDER BY created DESC, user, thing LIMIT 5000')
      .bind(g.id)
      .all();
    const ids = new Map();
    for (const r of results) if (!ids.has(r.member)) ids.set(r.member, await pseudo(salt, r.member));
    const per = {};
    const rows = results.map((r) => {
      const who = ids.get(r.member);
      per[who] = (per[who] || 0) + 1;
      return { who, name: r.name, thing: r.thing, sub: r.sub, reason: r.reason, link: r.link, created: toDay(r.created) };
    });
    // Метки участников (в общем слое — только базовые), чтобы видеть накрутку
    const vr = await db.prepare('SELECT member, name, tag, created FROM votes WHERE group_id = ? ORDER BY created DESC, user, tag LIMIT 5000').bind(g.id).all();
    const votes = [];
    for (const r of vr.results) {
      if (!ids.has(r.member)) ids.set(r.member, await pseudo(salt, r.member));
      const who = ids.get(r.member);
      per[who] = (per[who] || 0) + 1;
      votes.push({ who, name: r.name, tag: r.tag, created: toDay(r.created) });
    }
    const members = await db.prepare('SELECT COUNT(*) n FROM members WHERE group_id = ?').bind(g.id).first();
    return json({ group: { name: g.name, code: g.code }, members: members.n, complaints: rows, votes, perWho: per });
  },

  // Стереть все жалобы и метки одного участника (спамер): { who: 'Ж-3fa9c1', group? }
  'POST /admin/purge': async (db, body, req) => {
    const salt = await adminAuth(db, req);
    const g = await adminGroup(db, body.group);
    const { results } = await db.prepare('SELECT member FROM complaints WHERE group_id = ?1 UNION SELECT member FROM votes WHERE group_id = ?1').bind(g.id).all();
    let removed = 0;
    for (const r of results) {
      if ((await pseudo(salt, r.member)) !== body.who) continue;
      const [a, b] = await db.batch([
        db.prepare('DELETE FROM complaints WHERE group_id = ? AND member = ?').bind(g.id, r.member),
        db.prepare('DELETE FROM votes WHERE group_id = ? AND member = ?').bind(g.id, r.member),
      ]);
      removed += (a.meta?.changes || 0) + (b.meta?.changes || 0);
    }
    return json({ ok: true, removed });
  },

  // Выгрузить вердикты автопроверки (только владелец): { items: [{ user, tags: ['kons', …], evidence: {…} }] }
  // Повторная выгрузка того же ника заменяет вердикт и продлевает его ещё на 30 дней.
  'POST /admin/verdicts': async (db, body, req) => {
    await adminAuth(db, req);
    const now = Date.now();
    const stmts = [];
    for (const it of (Array.isArray(body.items) ? body.items : []).slice(0, 200)) {
      const name = String(it.user || '').replace(/^\/?u\//i, '');
      if (!USER_RE.test(name)) continue;
      const tags = [...new Set((it.tags || []).map(String).filter((t) => VERDICT_TAGS.has(t)))];
      if (!tags.length) continue;
      let ev = null;
      try { ev = it.evidence ? JSON.stringify(it.evidence) : null; } catch { ev = null; }
      if (ev && ev.length > 2000) ev = null; // только цифры, без длинных текстов
      // Три даты (1.3.89, владелец + ГПТ): checked — последнее реальное сканирование (присылает скрипт, не позже «сейчас»;
      // нет — значит, сканировали сейчас), updated — когда записали/поменяли вердикт, expires — срок хранения от записи.
      // Перезаливка по новым правилам не «омолаживает» проверку.
      const c = Number(it.checked);
      const checked = Number.isFinite(c) && c > 0 && c <= now ? Math.floor(c) : now;
      stmts.push(db.prepare('INSERT OR REPLACE INTO verdicts (user, name, tags, evidence, checked, updated, expires) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(name.toLowerCase(), name, JSON.stringify(tags), ev, checked, now, now + VERDICT_TTL));
    }
    await db.prepare('DELETE FROM verdicts WHERE expires < ?').bind(now).run(); // просроченные чистим заодно
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true, saved: stmts.length });
  },

  // Снять вердикт с ника (только владелец): { user }
  'POST /admin/verdicts/delete': async (db, body, req) => {
    await adminAuth(db, req);
    const user = String(body.user || '').replace(/^\/?u\//i, '').toLowerCase();
    if (!USER_RE.test(user)) fail(400, 'Некорректный ник');
    const r = await db.prepare('DELETE FROM verdicts WHERE user = ?').bind(user).run();
    return json({ ok: true, removed: r.meta?.changes || 0 });
  },

  // Очередь для проверки (только владелец): ?status=new|error&limit=N. Сначала те, у кого расширение что-то нашло,
  // потом — кого прислало больше людей; «чистые» по предварительной проверке — в конце. Ники с действующим вердиктом не отдаём.
  'GET /admin/queue': async (db, _b, req) => {
    await adminAuth(db, req);
    const p = new URL(req.url).searchParams;
    const status = ['new', 'error', 'checked'].includes(p.get('status')) ? p.get('status') : 'new';
    const limit = Math.min(Math.max(parseInt(p.get('limit')) || 200, 1), 1000);
    const { results } = await db.prepare(`SELECT q.name, q.reports, q.pre_tags, q.first, q.err FROM queue q
        WHERE q.status = ? AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.user = q.user AND v.expires > ?)
        ORDER BY CASE WHEN q.pre_tags IS NULL OR q.pre_tags = '[]' OR q.pre_tags = '["clean"]' THEN 1 ELSE 0 END, q.reports DESC, q.first
        LIMIT ?`).bind(status, Date.now(), limit).all();
    return json({ queue: results.map((r) => ({ name: r.name, reports: r.reports, pre: r.pre_tags ? JSON.parse(r.pre_tags) : [], first: toDay(r.first), err: r.err })) });
  },

  // Отметить проверенные (только владелец): { items: [{ user, status: 'checked' | 'error', err? }] }
  'POST /admin/queue/done': async (db, body, req) => {
    await adminAuth(db, req);
    const now = Date.now();
    const stmts = [];
    for (const it of (Array.isArray(body.items) ? body.items : []).slice(0, 500)) {
      const user = String(it.user || '').replace(/^\/?u\//i, '').toLowerCase();
      if (!USER_RE.test(user)) continue;
      const st = it.status === 'error' ? 'error' : 'checked';
      stmts.push(db.prepare('UPDATE queue SET status = ?, checked = ?, err = ? WHERE user = ?').bind(st, now, st === 'error' ? String(it.err || '').slice(0, 200) : null, user));
    }
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true, marked: stmts.length });
  },

  // Статистика очереди (только владелец)
  'GET /admin/queue/stats': async (db, _b, req) => {
    await adminAuth(db, req);
    const now = Date.now();
    const [byStatus, reps, known] = await db.batch([
      db.prepare('SELECT status, COUNT(*) n FROM queue GROUP BY status'),
      db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT member) m FROM queue_rep'),
      db.prepare('SELECT COUNT(*) n FROM queue q WHERE q.status = ? AND EXISTS (SELECT 1 FROM verdicts v WHERE v.user = q.user AND v.expires > ?)').bind('new', now),
    ]);
    const st = Object.fromEntries(byStatus.results.map((r) => [r.status, r.n]));
    const total = Object.values(st).reduce((a, b) => a + b, 0);
    return json({ total, new: st.new || 0, checked: st.checked || 0, error: st.error || 0, reports: reps.results[0].n, reporters: reps.results[0].m,
      dup: reps.results[0].n - total, newButKnown: known.results[0].n });
  },

  // Список вердиктов для админки (только владелец)
  'GET /admin/verdicts': async (db, _b, req) => {
    await adminAuth(db, req);
    const { results } = await db.prepare('SELECT name, tags, evidence, checked, updated, expires FROM verdicts WHERE expires > ? ORDER BY checked DESC LIMIT 5000').bind(Date.now()).all();
    return json({ verdicts: results.map((r) => ({ ...r, tags: JSON.parse(r.tags), evidence: r.evidence ? JSON.parse(r.evidence) : null })) });
  },

  // Общая статистика группы
  'GET /stats': async (db, _b, req) => {
    const { group } = await auth(db, req);
    notPublic(group);
    const [tagsRes, sightRes, namesRes, meta, compUser, compSub, recent] = await db.batch([
      db.prepare('SELECT user, tag, COUNT(*) c FROM votes WHERE group_id = ? GROUP BY user, tag HAVING c >= ? LIMIT 20000').bind(group.id, group.minVotes),
      db.prepare('SELECT sub, user, COUNT(*) n FROM sightings WHERE group_id = ? GROUP BY sub, user LIMIT 50000').bind(group.id),
      db.prepare('SELECT user, MAX(name) name FROM votes WHERE group_id = ? GROUP BY user LIMIT 20000').bind(group.id),
      db.prepare('SELECT (SELECT COUNT(*) FROM members WHERE group_id = ?1) members, (SELECT COUNT(*) FROM votes WHERE group_id = ?1) votes, (SELECT COUNT(DISTINCT member) FROM votes WHERE group_id = ?1) voters, (SELECT COUNT(*) FROM complaints WHERE group_id = ?1) complaints').bind(group.id),
      db.prepare('SELECT user, MAX(name) name, COUNT(*) n, COUNT(DISTINCT member) p, MAX(created) last FROM complaints WHERE group_id = ? GROUP BY user LIMIT 20000').bind(group.id),
      db.prepare('SELECT sub, COUNT(*) n, COUNT(DISTINCT user) u FROM complaints WHERE group_id = ? AND sub IS NOT NULL GROUP BY sub').bind(group.id),
      db.prepare('SELECT name, sub, reason, link, created FROM complaints WHERE group_id = ? ORDER BY created DESC, user, thing LIMIT 50').bind(group.id),
    ]);
    for (const r of recent.results) r.created = toDay(r.created);
    for (const r of compUser.results) r.last = toDay(r.last);

    const names = Object.fromEntries(namesRes.results.map((r) => [r.user, r.name]));
    const users = {};
    const mk = (user, name) => (users[user] ??= { name: name || names[user] || user, tags: {}, total: 0, subs: {}, complaints: 0, complainers: 0 });
    for (const r of tagsRes.results) mk(r.user).tags[r.tag] = r.c;
    for (const r of compUser.results) Object.assign(mk(r.user, r.name), { complaints: r.n, complainers: r.p, lastComplaint: r.last });
    const subComp = Object.fromEntries(compSub.results.map((r) => [r.sub, r]));
    const subs = {};
    for (const r of sightRes.results) {
      const u = users[r.user];
      if (!u) continue; // у юзера нет меток выше порога и нет жалоб
      u.total += r.n;
      u.subs[r.sub] = r.n;
      const s = (subs[r.sub] ??= { name: r.sub, users: 0, total: 0, tags: {}, top: [], complaints: subComp[r.sub]?.n || 0 });
      s.users++;
      s.total += r.n;
      s.top.push({ name: u.name, n: r.n });
      for (const t of Object.keys(u.tags)) s.tags[t] = (s.tags[t] || 0) + 1;
    }
    // Сабы, где жаловались, но встреч ещё нет
    for (const r of compSub.results) subs[r.sub] ??= { name: r.sub, users: r.u, total: 0, tags: {}, top: [], complaints: r.n };
    const subList = Object.values(subs).sort((a, b) => b.users - a.users || b.complaints - a.complaints || b.total - a.total).slice(0, 300);
    for (const s of subList) s.top = s.top.sort((a, b) => b.n - a.n).slice(0, 8);
    const userList = Object.values(users)
      .map((u) => ({ ...u, votes: Object.values(u.tags).reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.complaints + b.votes - (a.complaints + a.votes) || b.total - a.total)
      .slice(0, 300);

    return json({ group, meta: meta.results[0], subs: subList, users: userList, recent: recent.results });
  },
};

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const route = routes[`${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`];
    if (!route) return json({ error: 'Не найдено' }, 404);
    try {
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      return await route(env.DB, body, req, env);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500);
    }
  },
};
