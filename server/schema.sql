CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  min_votes INTEGER NOT NULL DEFAULT 2,
  created INTEGER NOT NULL
);

-- token хранится только в виде sha256
CREATE TABLE IF NOT EXISTS members (
  token_hash TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  acct TEXT,       -- п.14: HMAC-id подтверждённого reddit-аккаунта (без ника)
  blocked INTEGER  -- п.15: устройство отключено сменой ключа — новых голосов/жалоб не шлёт (принятые остаются)
);
CREATE INDEX IF NOT EXISTS members_acct ON members(acct);
CREATE INDEX IF NOT EXISTS members_group ON members(group_id);

-- одна строка = один участник поставил одну метку одному юзеру reddit
CREATE TABLE IF NOT EXISTS votes (
  group_id TEXT NOT NULL,
  member TEXT NOT NULL,
  user TEXT NOT NULL,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  sub TEXT,
  created INTEGER NOT NULL,
  PRIMARY KEY (group_id, member, user, tag)
);
CREATE INDEX IF NOT EXISTS votes_user ON votes(group_id, user);
CREATE INDEX IF NOT EXISTS votes_member ON votes(member, created);

-- встреча помеченного юзера в посте/комменте; один пост считается один раз на всю группу
CREATE TABLE IF NOT EXISTS sightings (
  group_id TEXT NOT NULL,
  user TEXT NOT NULL,
  thing TEXT NOT NULL,
  sub TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (group_id, user, thing)
);
CREATE INDEX IF NOT EXISTS sightings_sub ON sightings(group_id, sub);

-- жалоба участника на конкретный пост/коммент юзера; одна жалоба на один коммент от одного участника
CREATE TABLE IF NOT EXISTS complaints (
  group_id TEXT NOT NULL,
  member TEXT NOT NULL,
  user TEXT NOT NULL,
  name TEXT NOT NULL,
  thing TEXT NOT NULL,
  sub TEXT,
  reason TEXT,
  link TEXT,
  created INTEGER NOT NULL,
  PRIMARY KEY (group_id, member, user, thing)
);
CREATE INDEX IF NOT EXISTS complaints_user ON complaints(group_id, user);
CREATE INDEX IF NOT EXISTS complaints_member ON complaints(member, created);

-- журнал вступлений (только хэш IP), чтобы с одного адреса нельзя было наплодить участников
CREATE TABLE IF NOT EXISTS joins (
  ip_hash TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS joins_ip ON joins(ip_hash, created);

-- хэш ключа админа (sha256 от 'admin:' + ключ); сам ключ на сервере не хранится
CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key_hash TEXT NOT NULL
);

-- общий слой жалоб для всех пользователей расширения
INSERT OR IGNORE INTO groups (id, name, code, min_votes, created) VALUES ('public', 'Все пользователи', 'public', 2, 0);

-- вердикты автопроверки (консерва, минусуют тут…), которые выгрузил владелец; видны всем пользователям.
-- tags — JSON-список кодов меток, evidence — JSON с цифрами (без текстов чужих комментов).
-- Живут 30 дней (expires): потом пропадают, если их не подтвердили новой проверкой.
CREATE TABLE IF NOT EXISTS verdicts (
  user TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tags TEXT NOT NULL,
  evidence TEXT,
  checked INTEGER NOT NULL, -- последнее реальное сканирование (архив/reddit)
  updated INTEGER,          -- когда вердикт записан/изменён (1.3.89; у старой базы — migrate-1.3.89.sql)
  expires INTEGER NOT NULL  -- срок хранения: от записи/продления, не от checked
);
CREATE INDEX IF NOT EXISTS verdicts_expires ON verdicts(expires);

-- очередь новых ников (1.3.80): расширения пользователей присылают ники, которые проверили сами и которых нет на сервере.
-- Предварительные метки/цифры — только подсказка (не публикуются); публикует владелец после своей проверки через архив.
-- Один ник — одна строка; reports — сколько разных участников прислали.
CREATE TABLE IF NOT EXISTS queue (
  user TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  first INTEGER NOT NULL,
  last INTEGER NOT NULL,
  reports INTEGER NOT NULL DEFAULT 1,
  pre_tags TEXT,
  pre_ev TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  checked INTEGER,
  err TEXT,
  lease INTEGER,   -- 1.3.91: бронь автоочереди (до какого времени ник занят проверкой)
  tries INTEGER    -- 1.3.91: сколько раз архив не ответил
);
CREATE INDEX IF NOT EXISTS queue_status ON queue(status, first);
-- кто прислал (хэш участника — как в votes/complaints), для подсчёта разных людей и лимитов
CREATE TABLE IF NOT EXISTS queue_rep (
  user TEXT NOT NULL,
  member TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (user, member)
);
CREATE INDEX IF NOT EXISTS queue_rep_member ON queue_rep(member, created);

-- 1.3.91 автоочередь: результаты тестового режима (не публикуются) и сырые цифры по сабам опубликованных автоматикой вердиктов
CREATE TABLE IF NOT EXISTS autoqueue_test (
  user TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tags TEXT NOT NULL,
  evidence TEXT,
  raw TEXT,
  t INTEGER NOT NULL,
  err TEXT,       -- тест: архив не ответил (повтор через час, до 5 раз)
  tries INTEGER
);
CREATE TABLE IF NOT EXISTS verdict_raw (
  user TEXT PRIMARY KEY,
  raw TEXT NOT NULL,
  t INTEGER NOT NULL
);

-- сервер 1.3.92: кэш успешных ответов архива (6 ч) и замеры запусков автоочереди (14 дней)
CREATE TABLE IF NOT EXISTS archive_cache (url TEXT PRIMARY KEY, body TEXT NOT NULL, t INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS autoqueue_runs (
  t INTEGER NOT NULL, mode TEXT, nicks INTEGER, ok INTEGER, errors INTEGER, requests INTEGER, cache_hits INTEGER,
  wall_ms INTEGER, fetch_ms INTEGER, wait_ms INTEGER, other_ms INTEGER, retries INTEGER,
  pace_ms INTEGER, sleep_ms INTEGER, db_ms INTEGER
);
CREATE INDEX IF NOT EXISTS autoqueue_runs_t ON autoqueue_runs(t);
-- общий для всех запусков «шлагбаум» архива: до какого времени ждать после 429
CREATE TABLE IF NOT EXISTS archive_gate (id INTEGER PRIMARY KEY, blocked_until INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0);

-- п.14 довірені: id аккаунта — HMAC(ник) секретом сервера; заявка хранит ник только до подтверждения/истечения
CREATE TABLE IF NOT EXISTS trusted (acct TEXT PRIMARY KEY, by TEXT NOT NULL, granted INTEGER NOT NULL, revoked INTEGER);
CREATE TABLE IF NOT EXISTS trust_pending (token_hash TEXT PRIMARY KEY, nick TEXT NOT NULL, code TEXT NOT NULL, created INTEGER NOT NULL,
  expires INTEGER NOT NULL, checked INTEGER, tries INTEGER);
CREATE TABLE IF NOT EXISTS trust_status (token_hash TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, t INTEGER NOT NULL);
-- лимит заявок на доверие с одной установки (не больше 5 новых кодов в сутки)
CREATE TABLE IF NOT EXISTS trust_starts (token_hash TEXT NOT NULL, t INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS trust_starts_tok ON trust_starts(token_hash, t);

-- 1.3.96: синхронизация своих данных по ключу (WISHLIST п.15). Сервер хранит только шифротекст полей.
CREATE TABLE IF NOT EXISTS sync_ident (
  id TEXT PRIMARY KEY,
  auth_hash TEXT NOT NULL UNIQUE, -- хеш секрета, выведенного из ключа (сам ключ сервер не видит)
  key_no INTEGER NOT NULL,        -- номер текущего ключа
  ver INTEGER NOT NULL DEFAULT 0, -- счётчик версий полей (выдаёт сервер)
  floor INTEGER NOT NULL DEFAULT 0, -- последняя версия среди надгробий, удалённых навсегда (старее — только полный снимок)
  acct TEXT,                      -- довіра личности (id аккаунта из п.14), если подтвердилась на одном из устройств
  rot_op TEXT, rot_auth_hash TEXT, rot_key_no INTEGER, last_op TEXT, -- смена ключа (атомарно, с id операции)
  created INTEGER NOT NULL,
  owner TEXT                      -- 1.3.97: установка, создавшая ключ (лимит новых ключей в сутки)
);
CREATE TABLE IF NOT EXISTS sync_devices (
  token_hash TEXT PRIMARY KEY,    -- токен установки (members)
  ident TEXT NOT NULL,
  key_no INTEGER NOT NULL,
  added INTEGER NOT NULL,
  last INTEGER
);
CREATE INDEX IF NOT EXISTS sync_devices_ident ON sync_devices(ident);
CREATE TABLE IF NOT EXISTS sync_fields (
  ident TEXT NOT NULL,
  key_no INTEGER NOT NULL,
  f TEXT NOT NULL,                -- непрозрачный id поля (HMAC имени на устройстве)
  ver INTEGER NOT NULL,
  d TEXT,                         -- шифротекст; NULL — надгробие (удалено)
  del INTEGER,                    -- время удаления (надгробия живут 180 дней)
  PRIMARY KEY (ident, key_no, f)
);
CREATE INDEX IF NOT EXISTS sync_fields_ver ON sync_fields(ident, key_no, ver);
