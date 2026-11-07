import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../server/config.js';
import { SqliteStore } from '../server/db/sqlite.js';
import { GameEngine } from '../server/game/engine.js';
import { tempDbPath, NO_DISCOVERIES } from './helpers.js';

describe('migration de schéma v1 → v2', () => {
  it('ajoute les clés de pseudo, conserve les données et tolère les homonymes historiques', () => {
    const db = tempDbPath();
    try {
      // Base telle que créée par la première version (pas de colonne name_key).
      const v1 = new DatabaseSync(db.path);
      v1.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta VALUES ('schema_version', '1');
        CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE,
          skin TEXT NOT NULL DEFAULT 'classic', auth_provider TEXT NOT NULL DEFAULT 'guest',
          created_at INTEGER NOT NULL, last_action_at INTEGER);
        INSERT INTO players(id, name, token_hash, created_at) VALUES
          ('a', 'Mineur-1234', 'h1', 1), ('b', 'mineur-1234', 'h2', 2), ('c', 'Zoé', 'h3', 3);
        CREATE TABLE brigades (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
          invite_code TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL);
        INSERT INTO brigades VALUES ('br', 'Les Foreurs', 'les foreurs', 'ABCDEFGH', 'a', 1);
      `);
      v1.close();

      const store = new SqliteStore(db.path);
      const engine = new GameEngine(store, { ...DEFAULT_RULES, autoStartSeason: false, ...NO_DISCOVERIES });
      const check = new DatabaseSync(db.path);
      expect(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: '2' });
      const rows = check.prepare('SELECT id, name, name_key FROM players ORDER BY id').all();
      expect(rows).toEqual([
        { id: 'a', name: 'Mineur-1234', name_key: 'mineur-1234' },
        { id: 'b', name: 'mineur-1234', name_key: null }, // homonyme historique : clé non réservée
        { id: 'c', name: 'Zoé', name_key: 'zoé' },
      ]);
      check.close();
      // Le joueur sans clé peut choisir un nouveau pseudo libre, pas celui d'un autre.
      expect(() => engine.setName('b', 'MINEUR-1234')).toThrow(/déjà utilisé/);
      expect(engine.setName('b', 'Bastien').name).toBe('Bastien');
      // Les brigades existantes restent trouvables par nom (unicité conservée).
      expect(() => engine.createBrigade('c', 'les foreurs')).toThrow(/déjà pris/);
      // Réouverture : migration idempotente.
      store.close();
      new SqliteStore(db.path).close();
    } finally {
      db.cleanup();
    }
  });
});
