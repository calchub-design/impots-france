import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { startGameServer } from './net/gameServer.js';

/** Chargement minimal d'un fichier .env (sans dépendance externe). */
function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv();
const config = loadConfig();
const server = await startGameServer({ config });
console.log(`[the-last-block] serveur prêt sur http://${config.host}:${server.port} (ws: /ws, db: ${config.dbPath})`);
if (!config.adminToken) console.log('[the-last-block] ADMIN_TOKEN absent : routes /api/admin désactivées.');

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[the-last-block] arrêt (${signal})…`);
  await server.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
