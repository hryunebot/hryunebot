-- сервер 1.3.94: довірені користувачі (п.14). ДО выкладки кода (и задать секрет: npx wrangler secret put TRUST_SECRET):
--   npx wrangler d1 execute reddit-tagger --remote --file migrate-1.3.94.sql
ALTER TABLE members ADD COLUMN acct TEXT;
CREATE INDEX IF NOT EXISTS members_acct ON members(acct);
CREATE TABLE IF NOT EXISTS trusted (acct TEXT PRIMARY KEY, by TEXT NOT NULL, granted INTEGER NOT NULL, revoked INTEGER);
CREATE TABLE IF NOT EXISTS trust_pending (token_hash TEXT PRIMARY KEY, nick TEXT NOT NULL, code TEXT NOT NULL, created INTEGER NOT NULL,
  expires INTEGER NOT NULL, checked INTEGER, tries INTEGER);
CREATE TABLE IF NOT EXISTS trust_status (token_hash TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, t INTEGER NOT NULL);
