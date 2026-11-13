// Хрюнебот: синхронизация своих данных между устройствами по ключу (WISHLIST п.15).
//
// Сервер хранит ТОЛЬКО зашифрованные поля: ключ шифрования выводится из ключа синхронизации на устройстве и сюда не
// приходит. Сервер видит: непрозрачный id поля (HMAC имени поля на устройстве), шифротекст, номер версии, время удаления.
// Доступ к «личности» (sync_ident) — по хешу секрета auth, тоже выведенного из ключа (сам ключ сервер не видит).
//
// Версии полей выдаёт сервер (общий растущий счётчик личности), часам устройств не верим. Правка принимается, только
// если основана на текущей версии поля (base); иначе — «конфликт» с текущим значением, устройство сливает и повторяет.
// Удаление — «надгробие» (d = NULL, del = время), живёт 180 дней; после чистки надгробий растёт floor личности:
// устройство, чья последняя синхронизация старше floor, получает полный снимок и не может писать, пока его не скачает.
// Смена ключа — атомарно: begin (новый auth в ожидании) → put (перешифрованные поля под новым номером ключа) →
// commit (одна пачка: новый ключ, старые поля удалены, ВСЕ другие устройства теряют доступ; их принятые голоса остаются).
// Операция с id (op): повтор после сбоя доводит её до конца.
export const SYNC = {
  tombMs: 180 * 86400000, // надгробия живут 180 дней
  maxItems: 500, // полей за один запрос
  maxData: 16000, // символов шифротекста в поле
  maxFields: 30000, // полей у личности
  maxDevices: 20,
  maxBytes: 5000000, // шифротекста на личность (5 МБ хватает на десятки тысяч ников)
  createsPerDay: 3, // новых ключей в сутки с одной установки (создать → выйти → создать не плодит личности без конца)
};
const FID_RE = /^[0-9a-f]{32}$/;
const AUTH_RE = /^[0-9a-f]{64}$/;
const OP_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function syncRoutes({ auth, fail, json, sha, PUBLIC }) {
  // устройство → личность (только общий слой); проверка, что ключ устройства текущий
  async function device(db, req, { allowStale = false } = {}) {
    const { member, group } = await auth(db, req);
    if (group.id !== PUBLIC) fail(400, 'Синхронизация — только для общего слоя');
    const d = await db.prepare('SELECT d.ident, d.key_no dk, i.key_no ik, i.ver, i.floor, i.acct, i.rot_op, i.rot_key_no, i.last_op FROM sync_devices d JOIN sync_ident i ON i.id = d.ident WHERE d.token_hash = ?')
      .bind(member).first();
    if (!d) fail(404, 'Синхронизация не настроена на этом устройстве');
    if (d.dk !== d.ik && !allowStale) fail(403, 'Ключ синхронизации изменён — введите новый ключ');
    await db.prepare('UPDATE sync_devices SET last = ? WHERE token_hash = ?').bind(Date.now(), member).run();
    await linkAcct(db, member, d);
    return { member, ...d };
  }
  // довіра идёт за личностью: подтвердилось одно устройство — довірені все её устройства (голос всё равно один: acct)
  async function linkAcct(db, member, d) {
    const m = await db.prepare('SELECT acct FROM members WHERE token_hash = ?').bind(member).first();
    if (m && m.acct && !d.acct) { await db.prepare('UPDATE sync_ident SET acct = ? WHERE id = ? AND acct IS NULL').bind(m.acct, d.ident).run(); d.acct = m.acct; }
    else if (d.acct && m && !m.acct) await db.prepare('UPDATE members SET acct = ? WHERE token_hash = ?').bind(d.acct, member).run();
  }
  // чистка старых надгробий: floor = самая поздняя версия среди удалённых навсегда
  async function purge(db, ident, now) {
    const old = await db.prepare('SELECT MAX(ver) v FROM sync_fields WHERE ident = ? AND d IS NULL AND del < ?').bind(ident, now - SYNC.tombMs).first();
    if (!old || !old.v) return null;
    await db.batch([
      db.prepare('UPDATE sync_ident SET floor = MAX(COALESCE(floor, 0), ?) WHERE id = ?').bind(old.v, ident),
      db.prepare('DELETE FROM sync_fields WHERE ident = ? AND d IS NULL AND del < ?').bind(ident, now - SYNC.tombMs),
    ]);
    return old.v;
  }
  const authHash = async (a) => { if (!AUTH_RE.test(String(a || ''))) fail(400, 'Неверный ключ синхронизации'); return sha('sync:' + a); };
  // объём шифротекста личности после записи items (старые значения тех же полей — вычитаем)
  async function checkBytes(db, ident, limit, items) {
    const cur = await db.prepare('SELECT COALESCE(SUM(LENGTH(d)), 0) b FROM sync_fields WHERE ident = ?').bind(ident).first();
    let add = 0;
    for (const it of items) add += it.d ? it.d.length : 0;
    if (cur.b + add > limit) fail(413, 'Слишком много данных для синхронизации');
  }
  const nextVer = async (db, ident) => (await db.prepare('UPDATE sync_ident SET ver = ver + 1 WHERE id = ? RETURNING ver').bind(ident).first()).ver;
  const cleanItems = (items) => {
    if (!Array.isArray(items) || items.length > SYNC.maxItems) fail(400, 'Слишком много полей за раз');
    return items.map((x) => {
      const f = String((x && x.f) || '');
      if (!FID_RE.test(f)) fail(400, 'Неверное поле');
      const d = x.d == null ? null : String(x.d);
      if (d !== null && (d.length > SYNC.maxData || !/^[A-Za-z0-9+/=]+$/.test(d))) fail(400, 'Неверные данные поля');
      return { f, d, base: Math.max(0, Math.floor(+x.base || 0)) };
    });
  };
  // если в устройстве есть довіра другого аккаунта — к чужой личности не цепляем
  async function attach(db, member, ident, keyNo) {
    const i = await db.prepare('SELECT acct FROM sync_ident WHERE id = ?').bind(ident).first();
    const m = await db.prepare('SELECT acct FROM members WHERE token_hash = ?').bind(member).first();
    if (i && i.acct && m && m.acct && i.acct !== m.acct) fail(409, 'Это устройство уже подтверждено другим аккаунтом reddit');
    const n = await db.prepare('SELECT COUNT(*) n FROM sync_devices WHERE ident = ? AND token_hash != ?').bind(ident, member).first();
    if (n && n.n >= SYNC.maxDevices) fail(429, 'Слишком много устройств');
    const now = Date.now();
    await db.batch([
      db.prepare('INSERT OR REPLACE INTO sync_devices (token_hash, ident, key_no, added, last) VALUES (?, ?, ?, ?, ?)').bind(member, ident, keyNo, now, now),
      db.prepare('UPDATE members SET blocked = NULL WHERE token_hash = ?').bind(member), // ввёл действующий ключ — снова может голосовать
    ]);
    await linkAcct(db, member, { ident, acct: i && i.acct });
  }

  return {
    // Новая личность с этого устройства: { auth } (секрет из нового случайного ключа)
    'POST /sync/create': async (db, body, req) => {
      const { member, group } = await auth(db, req);
      if (group.id !== PUBLIC) fail(400, 'Синхронизация — только для общего слоя');
      const ah = await authHash(body && body.auth);
      const now = Date.now();
      const made = await db.prepare('SELECT COUNT(*) n FROM sync_ident WHERE owner = ? AND created > ?').bind(member, now - 86400000).first();
      if (made && made.n >= SYNC.createsPerDay) fail(429, 'Слишком много новых ключей — попробуйте завтра');
      // прежняя личность этого устройства, где оно было единственным, — больше никому не нужна: удаляем вместе с данными
      const prev = await db.prepare('SELECT d.ident, (SELECT COUNT(*) FROM sync_devices x WHERE x.ident = d.ident) n FROM sync_devices d WHERE d.token_hash = ?').bind(member).first();
      // (строку личности оставляем — по ней считается лимит новых ключей; её ключ больше не действует)
      if (prev && prev.n <= 1) await db.batch([
        db.prepare('DELETE FROM sync_fields WHERE ident = ?').bind(prev.ident),
        db.prepare("UPDATE sync_ident SET auth_hash = 'dead:' || id, acct = NULL WHERE id = ?").bind(prev.ident),
      ]);
      const id = (await sha('ident:' + member + ':' + crypto.randomUUID())).slice(0, 32);
      await db.prepare('INSERT INTO sync_ident (id, auth_hash, key_no, ver, floor, created, owner) VALUES (?, ?, 1, 0, 0, ?, ?)').bind(id, ah, now, member).run();
      await attach(db, member, id, 1);
      return json({ ok: true, keyNo: 1 });
    },
    // Подключить это устройство по ключу: { auth }. Старый (сменённый) ключ — отказ.
    'POST /sync/attach': async (db, body, req) => {
      const { member, group } = await auth(db, req);
      if (group.id !== PUBLIC) fail(400, 'Синхронизация — только для общего слоя');
      const ah = await authHash(body && body.auth);
      const i = await db.prepare('SELECT id, key_no FROM sync_ident WHERE auth_hash = ?').bind(ah).first();
      if (!i) fail(403, 'Ключ синхронизации недействителен (возможно, его сменили)');
      await attach(db, member, i.id, i.key_no);
      return json({ ok: true, keyNo: i.key_no });
    },
    // Отключить синхронизацию на этом устройстве (данные на нём остаются)
    'POST /sync/leave': async (db, _b, req) => {
      const { member } = await auth(db, req);
      await db.prepare('DELETE FROM sync_devices WHERE token_hash = ?').bind(member).run();
      return json({ ok: true });
    },
    // Изменения после версии since. since < floor → полный снимок (snapshot), устройство пересчитывает своё состояние.
    'POST /sync/pull': async (db, body, req) => {
      const d = await device(db, req);
      const now = Date.now();
      await purge(db, d.ident, now);
      const i = await db.prepare('SELECT ver, floor FROM sync_ident WHERE id = ?').bind(d.ident).first();
      const since = Math.max(0, Math.floor(+(body && body.since) || 0));
      const snapshot = since > 0 && since < (i.floor || 0);
      const rows = snapshot
        ? await db.prepare('SELECT f, ver v, d FROM sync_fields WHERE ident = ? AND key_no = ? AND d IS NOT NULL ORDER BY ver').bind(d.ident, d.ik).all()
        : await db.prepare('SELECT f, ver v, d FROM sync_fields WHERE ident = ? AND key_no = ? AND ver > ? ORDER BY ver').bind(d.ident, d.ik, since).all();
      return json({ ver: i.ver, floor: i.floor || 0, snapshot, keyNo: d.ik, fields: rows.results || [] });
    },
    // Правки: { since, items: [{ f, base, d|null }] }. Приняты — новые версии; не на текущей версии — конфликт с текущим.
    'POST /sync/push': async (db, body, req) => {
      const d = await device(db, req);
      const now = Date.now();
      await purge(db, d.ident, now);
      const floor = (await db.prepare('SELECT floor FROM sync_ident WHERE id = ?').bind(d.ident).first()).floor || 0;
      const since = Math.max(0, Math.floor(+(body && body.since) || 0));
      if (since < floor) return json({ needSnapshot: true, floor }, 409); // старое устройство: сначала полный снимок
      const items = cleanItems(body && body.items);
      const cnt = await db.prepare('SELECT COUNT(*) n FROM sync_fields WHERE ident = ?').bind(d.ident).first();
      if (cnt.n + items.length > SYNC.maxFields) fail(413, 'Слишком много данных для синхронизации');
      await checkBytes(db, d.ident, SYNC.maxBytes, items);
      const applied = [], conflicts = [];
      for (const it of items) {
        const v = await nextVer(db, d.ident);
        // атомарно: запись меняется, только если её версия всё ещё base (две правки на одну версию — первая побеждает)
        const r = it.base === 0
          ? await db.prepare('INSERT INTO sync_fields (ident, key_no, f, ver, d, del) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ident, key_no, f) DO NOTHING')
            .bind(d.ident, d.ik, it.f, v, it.d, it.d === null ? now : null).run()
          : await db.prepare('UPDATE sync_fields SET ver = ?, d = ?, del = ? WHERE ident = ? AND key_no = ? AND f = ? AND ver = ?')
            .bind(v, it.d, it.d === null ? now : null, d.ident, d.ik, it.f, it.base).run();
        if (r.meta.changes) applied.push({ f: it.f, v });
        else {
          const cur = await db.prepare('SELECT ver v, d FROM sync_fields WHERE ident = ? AND key_no = ? AND f = ?').bind(d.ident, d.ik, it.f).first();
          conflicts.push({ f: it.f, v: cur ? cur.v : 0, d: cur ? cur.d : null });
        }
      }
      return json({ applied, conflicts });
    },
    // Свои устройства (без идентификаторов токенов — только короткая метка, даты, «это устройство»)
    'POST /sync/devices': async (db, _b, req) => {
      const d = await device(db, req);
      const rows = (await db.prepare('SELECT token_hash, added, last, key_no FROM sync_devices WHERE ident = ? ORDER BY added').bind(d.ident).all()).results || [];
      return json({ keyNo: d.ik, trusted: !!d.acct, devices: rows.map((r) => ({ id: r.token_hash.slice(0, 6), added: r.added, last: r.last, me: r.token_hash === d.member, stale: r.key_no !== d.ik })) });
    },
    // Смена ключа, шаг 1: { op, auth } — новый ключ в ожидании. Повтор с тем же op ничего не ломает.
    'POST /sync/rotate/begin': async (db, body, req) => {
      const d = await device(db, req);
      const op = String((body && body.op) || '');
      if (!OP_RE.test(op)) fail(400, 'Неверная операция');
      if (d.last_op === op) return json({ ok: true, done: true, keyNo: d.ik });
      if (d.rot_op === op) return json({ ok: true, keyNo: d.rot_key_no });
      const ah = await authHash(body && body.auth);
      const k = d.ik + 1;
      await db.batch([
        db.prepare('DELETE FROM sync_fields WHERE ident = ? AND key_no > ?').bind(d.ident, d.ik), // недоделанная прошлая смена
        db.prepare('UPDATE sync_ident SET rot_op = ?, rot_auth_hash = ?, rot_key_no = ? WHERE id = ?').bind(op, ah, k, d.ident),
      ]);
      return json({ ok: true, keyNo: k });
    },
    // Шаг 2: { op, items: [{ f, d|null }] } — перешифрованные поля под новым номером ключа (видны только после commit)
    'POST /sync/rotate/put': async (db, body, req) => {
      const d = await device(db, req);
      const op = String((body && body.op) || '');
      if (d.last_op === op) return json({ ok: true, done: true });
      if (!d.rot_op || d.rot_op !== op) fail(409, 'Смена ключа не начата');
      const items = cleanItems(body && body.items), now = Date.now(), out = [];
      const cnt = await db.prepare('SELECT COUNT(*) n FROM sync_fields WHERE ident = ?').bind(d.ident).first();
      if (cnt.n + items.length > 2 * SYNC.maxFields) fail(413, 'Слишком много данных для синхронизации'); // старый + новый ключ
      await checkBytes(db, d.ident, 2 * SYNC.maxBytes, items); // старый + новый ключ
      for (const it of items) {
        const v = await nextVer(db, d.ident);
        await db.prepare('INSERT OR REPLACE INTO sync_fields (ident, key_no, f, ver, d, del) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(d.ident, d.rot_key_no, it.f, v, it.d, it.d === null ? now : null).run();
        out.push({ f: it.f, v });
      }
      return json({ ok: true, applied: out });
    },
    // Шаг 3: { op } — ОДНОЙ пачкой: новый ключ действует, старые поля удалены, все ДРУГИЕ устройства отключены
    // (и их довіра снята — вернётся, когда введут новый ключ). Повтор после успеха — ok.
    'POST /sync/rotate/commit': async (db, body, req) => {
      const d = await device(db, req, { allowStale: true });
      const op = String((body && body.op) || '');
      if (d.last_op === op) return json({ ok: true, keyNo: d.ik, done: true });
      if (d.dk !== d.ik) fail(403, 'Ключ синхронизации изменён — введите новый ключ');
      if (!d.rot_op || d.rot_op !== op) fail(409, 'Смена ключа не начата');
      const k = d.rot_key_no;
      await db.batch([
        // прочие устройства теряют ДОСТУП (новых голосов/жалоб не шлют), но уже принятые голоса личности остаются в счёте:
        // acct не трогаем — счёт по аккаунту не меняется ни от смены ключа, ни от числа устройств
        db.prepare('UPDATE members SET blocked = 1 WHERE token_hash IN (SELECT token_hash FROM sync_devices WHERE ident = ? AND token_hash != ?)').bind(d.ident, d.member),
        db.prepare('DELETE FROM sync_devices WHERE ident = ? AND token_hash != ?').bind(d.ident, d.member),
        db.prepare('UPDATE sync_devices SET key_no = ? WHERE token_hash = ?').bind(k, d.member),
        db.prepare('DELETE FROM sync_fields WHERE ident = ? AND key_no < ?').bind(d.ident, k),
        db.prepare('UPDATE sync_ident SET key_no = ?, auth_hash = rot_auth_hash, rot_op = NULL, rot_auth_hash = NULL, rot_key_no = NULL, last_op = ? WHERE id = ? AND rot_op = ?')
          .bind(k, op, d.ident, op),
      ]);
      return json({ ok: true, keyNo: k });
    },
  };
}
