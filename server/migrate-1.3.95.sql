-- сервер 1.3.95: лимит заявок на доверие с одной установки. ДО выкладки кода:
--   npx wrangler d1 execute reddit-tagger --remote --file migrate-1.3.95.sql
CREATE TABLE IF NOT EXISTS trust_starts (token_hash TEXT NOT NULL, t INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS trust_starts_tok ON trust_starts(token_hash, t);
