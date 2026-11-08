// Restauration d'une sauvegarde, SERVEUR ARRÊTÉ. La base actuelle est mise de côté
// (renommée « .avant-restauration-… »), jamais supprimée.
//
//   npm run build && node scripts/restore.mjs --backup ./data/backups/lastblock-….sqlite --db ./data/beta-48h.sqlite [--port 8080]
import { existsSync } from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
if (!existsSync('dist/server/server/ops/backup.js')) {
  console.error("Lancez d'abord `npm run build`.");
  process.exit(2);
}
const { restoreDatabaseFile } = await import('../dist/server/server/ops/backup.js');
const backup = arg('--backup');
const db = arg('--db', process.env.DB_PATH);
const port = arg('--port', process.env.PORT ?? '8080');
if (!backup || !existsSync(backup) || !db) {
  console.error('Usage : node scripts/restore.mjs --backup FICHIER --db BASE [--port 8080]');
  process.exit(2);
}
// Refus si un serveur répond encore sur ce port : il faut l'arrêter d'abord.
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
  if (r.status) {
    console.error(`Un serveur répond sur le port ${port} : arrêtez-le avant de restaurer (systemctl stop …).`);
    process.exit(3);
  }
} catch {
  /* aucun serveur : on peut restaurer */
}
const r = restoreDatabaseFile(backup, db);
console.log(`Restaurée : ${r.restored} (intégrité ${r.check.integrity}, ${r.check.players} joueurs, ${r.check.hits} coups).`);
console.log(`Ancienne base conservée : ${r.previous.join(', ') || '(aucune)'}`);
