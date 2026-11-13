-- 1.3.91: автоочередь. Выполнить ОДИН раз на рабочей базе ДО выкладки кода (повтор — ошибка «duplicate column», не страшно):
--   npx wrangler d1 execute reddit-tagger --remote --file migrate-1.3.91.sql
ALTER TABLE queue ADD COLUMN lease INTEGER;
ALTER TABLE queue ADD COLUMN tries INTEGER;
CREATE TABLE IF NOT EXISTS autoqueue_test (user TEXT PRIMARY KEY, name TEXT NOT NULL, tags TEXT NOT NULL, evidence TEXT, raw TEXT, t INTEGER NOT NULL, err TEXT, tries INTEGER);
CREATE TABLE IF NOT EXISTS verdict_raw (user TEXT PRIMARY KEY, raw TEXT NOT NULL, t INTEGER NOT NULL);
