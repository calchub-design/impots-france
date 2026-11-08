// Sauvegarde à chaud de la base SQLite (copie cohérente par VACUUM INTO, puis contrôle d'intégrité).
// Fonctionne pendant que le serveur tourne (connexion séparée, mode WAL).
//
//   npm run build && node scripts/backup.mjs --db ./data/beta-48h.sqlite --out ./data/backups
import { existsSync } from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
if (!existsSync('dist/server/server/ops/backup.js')) {
  console.error("Lancez d'abord `npm run build`.");
  process.exit(2);
}
const { backupDatabaseFile } = await import('../dist/server/server/ops/backup.js');
const db = arg('--db', process.env.DB_PATH);
const out = arg('--out', process.env.BACKUP_DIR ?? './data/backups');
if (!db || !existsSync(db)) {
  console.error(`Base introuvable : ${db ?? '(précisez --db ou DB_PATH)'}`);
  process.exit(2);
}
const r = backupDatabaseFile(db, out);
console.log(`Sauvegarde : ${r.path} (${(r.bytes / 1e6).toFixed(2)} Mo) — intégrité ${r.check.integrity}, ${r.check.players} joueurs, ${r.check.hits} coups, ${r.check.seasons} saisons.`);
