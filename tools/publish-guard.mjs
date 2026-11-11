// Хрюнебот: можно ли скрипту отправлять вердикты на сервер (1.3.80).
// Очередь (--queue / --queue-errors) по умолчанию ТОЛЬКО проверяет и показывает. Отправка — лишь с --publish,
// при ключе админа и свежем бэкапе базы (файл в dist/backup не старше maxAgeMin минут). Без этого — честный отказ с причиной.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const BACKUP_CMD = 'cd server; npx wrangler d1 export reddit-tagger --remote --output ../dist/backup/d1-ГГГГММДД-ЧЧММ.sql';

// Самый свежий бэкап: { file, ageMin } или null
export function newestBackup(dir, now = Date.now()) {
  if (!existsSync(dir)) return null;
  let best = null;
  for (const f of readdirSync(dir)) {
    if (!/\.sql$/i.test(f)) continue;
    const st = statSync(join(dir, f));
    if (!st.size) continue; // пустой файл — не бэкап
    if (!best || st.mtimeMs > best.t) best = { file: f, t: st.mtimeMs };
  }
  return best ? { file: best.file, ageMin: Math.round((now - best.t) / 60000) } : null;
}

// queue — режим очереди; publish — есть флаг --publish; dry — --dry; hasKey — есть ключ админа;
// backup — результат newestBackup; maxAgeMin — сколько минут бэкап считается свежим.
export function publishDecision({ queue, publish, dry, hasKey, backup, maxAgeMin = 60 }) {
  if (dry) return { upload: false, reason: 'режим --dry: только проверка' };
  if (!hasKey) return { upload: false, reason: 'нет ключа админа: только проверка' };
  if (!queue) return { upload: true, reason: 'обычный режим' }; // прежнее поведение массовой проверки не меняем
  if (!publish) return { upload: false, reason: 'очередь без --publish: только проверка и показ (на сервер ничего не уходит)' };
  if (!backup) return { upload: false, reason: 'нет бэкапа базы в dist/backup — сначала: ' + BACKUP_CMD };
  if (backup.ageMin > maxAgeMin) return { upload: false, reason: `бэкап ${backup.file} старше ${maxAgeMin} мин (${backup.ageMin} мин) — сделайте свежий: ` + BACKUP_CMD };
  return { upload: true, reason: `--publish, бэкап ${backup.file} (${backup.ageMin} мин назад)` };
}
