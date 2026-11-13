-- сервер 1.3.96: синхронизация по ключу (п.15). ДО выкладки кода:
--   npx wrangler d1 execute reddit-tagger --remote --file migrate-1.3.96.sql
ALTER TABLE members ADD COLUMN blocked INTEGER;
CREATE TABLE IF NOT EXISTS sync_ident (
  id TEXT PRIMARY KEY,
  auth_hash TEXT NOT NULL UNIQUE, -- хеш секрета, выведенного из ключа (сам ключ сервер не видит)
  key_no INTEGER NOT NULL,        -- номер текущего ключа
  ver INTEGER NOT NULL DEFAULT 0, -- счётчик версий полей (выдаёт сервер)
  floor INTEGER NOT NULL DEFAULT 0, -- последняя версия среди надгробий, удалённых навсегда (старее — только полный снимок)
  acct TEXT,                      -- довіра личности (id аккаунта из п.14), если подтвердилась на одном из устройств
  rot_op TEXT, rot_auth_hash TEXT, rot_key_no INTEGER, last_op TEXT, -- смена ключа (атомарно, с id операции)
  created INTEGER NOT NULL
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
