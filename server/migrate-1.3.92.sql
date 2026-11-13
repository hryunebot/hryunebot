-- сервер 1.3.92: кэш ответов архива и замеры автоочереди. Выполнить ДО выкладки кода:
--   npx wrangler d1 execute reddit-tagger --remote --file migrate-1.3.92.sql
CREATE TABLE IF NOT EXISTS archive_cache (url TEXT PRIMARY KEY, body TEXT NOT NULL, t INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS autoqueue_runs (
  t INTEGER NOT NULL, mode TEXT, nicks INTEGER, ok INTEGER, errors INTEGER, requests INTEGER, cache_hits INTEGER,
  wall_ms INTEGER, fetch_ms INTEGER, wait_ms INTEGER, other_ms INTEGER, retries INTEGER
);
CREATE INDEX IF NOT EXISTS autoqueue_runs_t ON autoqueue_runs(t);
-- общий для всех запусков «шлагбаум» архива: до какого времени ждать после 429
CREATE TABLE IF NOT EXISTS archive_gate (id INTEGER PRIMARY KEY, blocked_until INTEGER NOT NULL DEFAULT 0);
