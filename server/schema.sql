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
  created INTEGER NOT NULL
);
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
  err TEXT
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
