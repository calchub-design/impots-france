import { copyFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Sauvegarde et vérification de la base SQLite.
 *
 * `VACUUM INTO` produit une copie COHÉRENTE de la base, y compris pendant que
 * le serveur écrit (mode WAL) : la copie reflète un état validé, jamais une
 * transaction à moitié écrite. La copie est ensuite contrôlée (integrity_check)
 * et son contenu résumé (saisons, joueurs, coups), pour qu'une restauration ne
 * parte jamais d'un fichier abîmé.
 */

export function backupFileName(at: number): string {
  return `lastblock-${new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.sqlite`;
}

export interface BackupCheck {
  ok: boolean;
  integrity: string;
  seasons: number;
  players: number;
  hits: number;
}

/** Contrôle d'intégrité d'un fichier de base (ouvert en lecture seule). */
export function checkDatabaseFile(path: string): BackupCheck {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    const n = (sql: string) => {
      try {
        return (db.prepare(sql).get() as { n: number }).n;
      } catch {
        return -1;
      }
    };
    const out = { integrity, seasons: n('SELECT COUNT(*) AS n FROM seasons'), players: n('SELECT COUNT(*) AS n FROM players'), hits: n('SELECT COUNT(*) AS n FROM hits') };
    return { ok: integrity === 'ok' && out.seasons >= 0 && out.players >= 0 && out.hits >= 0, ...out };
  } finally {
    db.close();
  }
}

/** Sauvegarde à chaud par une connexion fournie (`run` exécute VACUUM INTO). */
export function backupWith(run: (path: string) => void, dir: string, at: number): { path: string; bytes: number; check: BackupCheck } {
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });
  const path = join(target, backupFileName(at));
  if (existsSync(path)) throw new Error(`la sauvegarde ${path} existe déjà`);
  run(path);
  const check = checkDatabaseFile(path);
  if (!check.ok) throw new Error(`sauvegarde invalide (${check.integrity})`);
  return { path, bytes: statSync(path).size, check };
}

/** Sauvegarde à chaud d'un fichier de base, par une connexion séparée (script en ligne de commande). */
export function backupDatabaseFile(dbPath: string, dir: string, at = Date.now()) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    return backupWith((p) => db.prepare('VACUUM INTO ?').run(p), dir, at);
  } finally {
    db.close();
  }
}

/**
 * Restauration (serveur ARRÊTÉ) : la sauvegarde est vérifiée, la base actuelle et
 * ses fichiers WAL/SHM sont mis de côté (jamais supprimés), puis la sauvegarde est
 * copiée à la place et vérifiée à nouveau.
 */
export function restoreDatabaseFile(backupPath: string, dbPath: string, at = Date.now()): { restored: string; previous: string[]; check: BackupCheck } {
  const pre = checkDatabaseFile(backupPath);
  if (!pre.ok) throw new Error(`sauvegarde invalide (${pre.integrity}) : restauration annulée`);
  const suffix = `.avant-restauration-${new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
  const previous: string[] = [];
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + ext)) {
      renameSync(dbPath + ext, dbPath + ext + suffix);
      previous.push(dbPath + ext + suffix);
    }
  }
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  copyFileSync(backupPath, dbPath);
  const check = checkDatabaseFile(dbPath);
  if (!check.ok) throw new Error(`copie restaurée invalide (${check.integrity}) ; l'ancienne base est conservée : ${previous.join(', ')}`);
  return { restored: dbPath, previous, check };
}
