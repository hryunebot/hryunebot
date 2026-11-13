-- сервер 1.3.93: общий темп запросов к архиву (next_at) и подробные замеры. ДО выкладки кода:
--   npx wrangler d1 execute reddit-tagger --remote --file migrate-1.3.93.sql
ALTER TABLE archive_gate ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE autoqueue_runs ADD COLUMN pace_ms INTEGER;
ALTER TABLE autoqueue_runs ADD COLUMN sleep_ms INTEGER;
ALTER TABLE autoqueue_runs ADD COLUMN db_ms INTEGER;
