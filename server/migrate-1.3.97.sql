-- сервер 1.3.97: лимит новых ключей синхронизации с установки. ДО выкладки кода:
--   npx wrangler d1 execute reddit-tagger --remote --command "ALTER TABLE sync_ident ADD COLUMN owner TEXT"
ALTER TABLE sync_ident ADD COLUMN owner TEXT;
