-- 1.3.89: третья дата вердикта. Выполнить ОДИН раз на рабочей базе (повторно — ошибка «duplicate column», это не страшно):
--   npx wrangler d1 execute reddit-tagger --remote --file migrate-1.3.89.sql
-- Старые записи: updated = checked (до 1.3.89 checked и был датой записи).
ALTER TABLE verdicts ADD COLUMN updated INTEGER;
UPDATE verdicts SET updated = checked WHERE updated IS NULL;
