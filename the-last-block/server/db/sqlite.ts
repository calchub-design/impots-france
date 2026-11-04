import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { nameKey } from '../game/validation.js';
import type {
  BrigadeContributionRow,
  BrigadeRow,
  ContributionRow,
  GameStore,
  HitRow,
  PlayerRow,
  SeasonResultRow,
  SeasonRow,
} from './store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT,
  token_hash TEXT UNIQUE,
  skin TEXT NOT NULL DEFAULT 'classic',
  auth_provider TEXT NOT NULL DEFAULT 'guest',
  created_at INTEGER NOT NULL,
  last_action_at INTEGER
);

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','ended')),
  cube_size INTEGER NOT NULL,
  base_hp INTEGER NOT NULL,
  hp_per_layer INTEGER NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  champion_player_id TEXT,
  champion_brigade_id TEXT,
  final_stone_player_id TEXT
);
-- Au plus une saison active à la fois.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_season ON seasons(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS blocks (
  season_id INTEGER NOT NULL,
  layer INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  hp INTEGER NOT NULL CHECK (hp >= 0),
  max_hp INTEGER NOT NULL,
  destroyed_by TEXT,
  destroyed_at INTEGER,
  PRIMARY KEY (season_id, layer, idx)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  layer INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  hp_after INTEGER NOT NULL,
  destroyed INTEGER NOT NULL,
  brigade_id TEXT,
  at INTEGER NOT NULL,
  UNIQUE (player_id, action_id)
);
CREATE INDEX IF NOT EXISTS hits_season ON hits(season_id);

CREATE TABLE IF NOT EXISTS contributions (
  season_id INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  blocks INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER NOT NULL,
  PRIMARY KEY (season_id, player_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS brigade_contributions (
  season_id INTEGER NOT NULL,
  brigade_id TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  blocks INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER NOT NULL,
  PRIMARY KEY (season_id, brigade_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS playtime (
  player_id TEXT NOT NULL,
  day TEXT NOT NULL,
  active_ms INTEGER NOT NULL,
  PRIMARY KEY (player_id, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS brigades (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  invite_code TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS brigade_members (
  player_id TEXT PRIMARY KEY,
  brigade_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS brigade_members_b ON brigade_members(brigade_id);

CREATE TABLE IF NOT EXISTS season_results (
  season_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  rank INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  PRIMARY KEY (season_id, kind, rank)
);
`;

export class SqliteStore implements GameStore {
  private db: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(path: string, opts: { synchronous?: 'NORMAL' | 'FULL' } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // NORMAL (défaut) : aucune perte en cas d'arrêt brutal du PROCESSUS ; les
    // dernières transactions peuvent être perdues (base cohérente) en cas de
    // coupure de courant / crash du système. FULL : durable même dans ce cas.
    this.db.exec(`PRAGMA synchronous = ${opts.synchronous === 'FULL' ? 'FULL' : 'NORMAL'};`);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Migrations idempotentes des bases créées par une version antérieure. */
  private migrate() {
    const cols = this.db.prepare('PRAGMA table_info(players)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'name_key')) this.db.exec('ALTER TABLE players ADD COLUMN name_key TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS players_name_key ON players(name_key)');
    // Rattrapage : pseudos sans clé (v1). En cas de doublon historique, la clé
    // reste NULL : ce joueur devra changer de pseudo pour en réserver un.
    const missing = this.db.prepare('SELECT id, name FROM players WHERE name_key IS NULL').all() as { id: string; name: string }[];
    const upd = this.db.prepare('UPDATE players SET name_key = ? WHERE id = ?');
    for (const m of missing) {
      try {
        upd.run(nameKey(m.name), m.id);
      } catch {
        /* doublon historique */
      }
    }
    this.db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  }

  private st(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private get<T>(sql: string, ...p: (string | number | null)[]): T | undefined {
    return this.st(sql).get(...p) as T | undefined;
  }

  private all<T>(sql: string, ...p: (string | number | null)[]): T[] {
    return this.st(sql).all(...p) as T[];
  }

  private run(sql: string, ...p: (string | number | null)[]) {
    return this.st(sql).run(...p);
  }

  transaction<T>(fn: () => T): T {
    // Transactions imbriquées -> savepoints.
    const name = `sp${this.txDepth}`;
    if (this.txDepth === 0) this.db.exec('BEGIN IMMEDIATE');
    else this.db.exec(`SAVEPOINT ${name}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      if (this.txDepth === 0) this.db.exec('COMMIT');
      else this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      this.txDepth--;
      if (this.txDepth === 0) this.db.exec('ROLLBACK');
      else this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw err;
    }
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }

  // --- Joueurs -------------------------------------------------------------

  createPlayer(p: { id: string; name: string; nameKey: string; tokenHash: string | null; skin: string; authProvider: string; createdAt: number }): void {
    this.run(
      'INSERT INTO players(id, name, name_key, token_hash, skin, auth_provider, created_at) VALUES (?,?,?,?,?,?,?)',
      p.id, p.name, p.nameKey, p.tokenHash, p.skin, p.authProvider, p.createdAt,
    );
  }
  countPlayers(): number {
    return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM players')!.n;
  }
  getPlayerByNameKey(key: string) {
    return this.get<PlayerRow>('SELECT * FROM players WHERE name_key = ?', key);
  }
  setTokenHash(id: string, hash: string | null) {
    this.run('UPDATE players SET token_hash = ? WHERE id = ?', hash, id);
  }
  getPlayer(id: string) {
    return this.get<PlayerRow>('SELECT * FROM players WHERE id = ?', id);
  }
  getPlayerByTokenHash(hash: string) {
    return this.get<PlayerRow>('SELECT * FROM players WHERE token_hash = ?', hash);
  }
  setPlayerName(id: string, name: string, key: string) {
    this.run('UPDATE players SET name = ?, name_key = ? WHERE id = ?', name, key, id);
  }
  setPlayerSkin(id: string, skin: string) {
    this.run('UPDATE players SET skin = ? WHERE id = ?', skin, id);
  }
  setLastActionAt(id: string, at: number) {
    this.run('UPDATE players SET last_action_at = ? WHERE id = ?', at, id);
  }

  // --- Saisons -------------------------------------------------------------

  getActiveSeason() {
    return this.get<SeasonRow>("SELECT * FROM seasons WHERE status = 'active' LIMIT 1");
  }
  getLastEndedSeason() {
    return this.get<SeasonRow>("SELECT * FROM seasons WHERE status = 'ended' ORDER BY ended_at DESC, id DESC LIMIT 1");
  }
  getSeason(id: number) {
    return this.get<SeasonRow>('SELECT * FROM seasons WHERE id = ?', id);
  }
  listSeasons(limit: number) {
    return this.all<SeasonRow>('SELECT * FROM seasons ORDER BY id DESC LIMIT ?', limit);
  }
  createSeason(s: { name: string; cubeSize: number; baseHp: number; hpPerLayer: number; startsAt: number; endsAt: number }): SeasonRow {
    return this.transaction(() => {
      const r = this.run(
        "INSERT INTO seasons(name, status, cube_size, base_hp, hp_per_layer, starts_at, ends_at) VALUES (?, 'active', ?, ?, ?, ?, ?)",
        s.name, s.cubeSize, s.baseHp, s.hpPerLayer, s.startsAt, s.endsAt,
      );
      const id = Number(r.lastInsertRowid);
      const ins = this.st('INSERT INTO blocks(season_id, layer, idx, hp, max_hp) VALUES (?,?,?,?,?)');
      const perLayer = s.cubeSize * s.cubeSize;
      for (let layer = 0; layer < s.cubeSize; layer++) {
        const hp = s.baseHp + layer * s.hpPerLayer;
        for (let idx = 0; idx < perLayer; idx++) ins.run(id, layer, idx, hp, hp);
      }
      return this.getSeason(id)!;
    });
  }
  endSeason(id: number, f: { endedAt: number; reason: 'completed' | 'timeout' | 'admin'; championPlayerId: string | null; championBrigadeId: string | null; finalStonePlayerId: string | null }) {
    this.run(
      "UPDATE seasons SET status = 'ended', ended_at = ?, end_reason = ?, champion_player_id = ?, champion_brigade_id = ?, final_stone_player_id = ? WHERE id = ? AND status = 'active'",
      f.endedAt, f.reason, f.championPlayerId, f.championBrigadeId, f.finalStonePlayerId, id,
    );
  }

  // --- Blocs ---------------------------------------------------------------

  loadBlockHp(seasonId: number) {
    return this.all<{ layer: number; idx: number; hp: number }>(
      'SELECT layer, idx, hp FROM blocks WHERE season_id = ?', seasonId,
    );
  }
  damageBlock(seasonId: number, layer: number, idx: number, playerId: string, at: number): number | undefined {
    const row = this.get<{ hp: number }>(
      `UPDATE blocks SET hp = hp - 1,
         destroyed_by = CASE WHEN hp = 1 THEN ? ELSE destroyed_by END,
         destroyed_at = CASE WHEN hp = 1 THEN ? ELSE destroyed_at END
       WHERE season_id = ? AND layer = ? AND idx = ? AND hp > 0
       RETURNING hp`,
      playerId, at, seasonId, layer, idx,
    );
    return row?.hp;
  }

  // --- Coups ---------------------------------------------------------------

  findHit(playerId: string, actionId: string) {
    return this.get<HitRow>('SELECT * FROM hits WHERE player_id = ? AND action_id = ?', playerId, actionId);
  }
  insertHit(h: Omit<HitRow, 'id'>) {
    this.run(
      'INSERT INTO hits(season_id, player_id, action_id, layer, idx, hp_after, destroyed, brigade_id, at) VALUES (?,?,?,?,?,?,?,?,?)',
      h.season_id, h.player_id, h.action_id, h.layer, h.idx, h.hp_after, h.destroyed, h.brigade_id, h.at,
    );
  }
  lastDestroyingHit(seasonId: number) {
    return this.get<HitRow>('SELECT * FROM hits WHERE season_id = ? AND destroyed = 1 ORDER BY id DESC LIMIT 1', seasonId);
  }
  countHits(seasonId: number): number {
    return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM hits WHERE season_id = ?', seasonId)!.n;
  }

  // --- Contributions -------------------------------------------------------

  addContribution(seasonId: number, playerId: string, destroyed: boolean, at: number) {
    this.run(
      `INSERT INTO contributions(season_id, player_id, hits, blocks, last_hit_at) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(season_id, player_id) DO UPDATE SET hits = hits + 1, blocks = blocks + excluded.blocks, last_hit_at = excluded.last_hit_at`,
      seasonId, playerId, destroyed ? 1 : 0, at,
    );
  }
  addBrigadeContribution(seasonId: number, brigadeId: string, destroyed: boolean, at: number) {
    this.run(
      `INSERT INTO brigade_contributions(season_id, brigade_id, hits, blocks, last_hit_at) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(season_id, brigade_id) DO UPDATE SET hits = hits + 1, blocks = blocks + excluded.blocks, last_hit_at = excluded.last_hit_at`,
      seasonId, brigadeId, destroyed ? 1 : 0, at,
    );
  }
  loadContributions(seasonId: number) {
    return this.all<ContributionRow>('SELECT player_id, hits, blocks, last_hit_at FROM contributions WHERE season_id = ?', seasonId);
  }
  loadBrigadeContributions(seasonId: number) {
    return this.all<BrigadeContributionRow>('SELECT brigade_id, hits, blocks, last_hit_at FROM brigade_contributions WHERE season_id = ?', seasonId);
  }

  // --- Temps de jeu --------------------------------------------------------

  getPlaytime(playerId: string, day: string): number {
    return this.get<{ active_ms: number }>('SELECT active_ms FROM playtime WHERE player_id = ? AND day = ?', playerId, day)?.active_ms ?? 0;
  }
  setPlaytime(playerId: string, day: string, activeMs: number) {
    this.run(
      'INSERT INTO playtime(player_id, day, active_ms) VALUES (?,?,?) ON CONFLICT(player_id, day) DO UPDATE SET active_ms = excluded.active_ms',
      playerId, day, activeMs,
    );
  }

  // --- Brigades ------------------------------------------------------------

  createBrigade(b: BrigadeRow) {
    this.run(
      'INSERT INTO brigades(id, name, name_key, invite_code, owner_id, created_at) VALUES (?,?,?,?,?,?)',
      b.id, b.name, nameKey(b.name), b.invite_code, b.owner_id, b.created_at,
    );
  }
  deleteBrigade(id: string) {
    this.run('DELETE FROM brigades WHERE id = ?', id);
  }
  getBrigade(id: string) {
    return this.get<BrigadeRow>('SELECT id, name, invite_code, owner_id, created_at FROM brigades WHERE id = ?', id);
  }
  getBrigadeByCode(code: string) {
    return this.get<BrigadeRow>('SELECT id, name, invite_code, owner_id, created_at FROM brigades WHERE invite_code = ?', code);
  }
  getBrigadeByName(name: string) {
    return this.get<BrigadeRow>('SELECT id, name, invite_code, owner_id, created_at FROM brigades WHERE name_key = ?', nameKey(name));
  }
  setBrigadeOwner(id: string, ownerId: string) {
    this.run('UPDATE brigades SET owner_id = ? WHERE id = ?', ownerId, id);
  }
  getMembership(playerId: string): string | undefined {
    return this.get<{ brigade_id: string }>('SELECT brigade_id FROM brigade_members WHERE player_id = ?', playerId)?.brigade_id;
  }
  addMember(brigadeId: string, playerId: string, at: number) {
    this.run('INSERT INTO brigade_members(player_id, brigade_id, joined_at) VALUES (?,?,?)', playerId, brigadeId, at);
  }
  removeMember(playerId: string) {
    this.run('DELETE FROM brigade_members WHERE player_id = ?', playerId);
  }
  listMembers(brigadeId: string) {
    return this.all<{ id: string; name: string; joined_at: number }>(
      `SELECT p.id, p.name, m.joined_at FROM brigade_members m JOIN players p ON p.id = m.player_id
       WHERE m.brigade_id = ? ORDER BY m.joined_at, p.id`,
      brigadeId,
    );
  }
  listBrigades() {
    return this.all<BrigadeRow & { members: number }>(
      `SELECT b.id, b.name, b.invite_code, b.owner_id, b.created_at, COUNT(m.player_id) AS members
       FROM brigades b LEFT JOIN brigade_members m ON m.brigade_id = b.id GROUP BY b.id`,
    );
  }

  // --- Archives ------------------------------------------------------------

  insertSeasonResults(rows: SeasonResultRow[]) {
    const s = this.st('INSERT OR REPLACE INTO season_results(season_id, kind, rank, entity_id, name, score) VALUES (?,?,?,?,?,?)');
    for (const r of rows) s.run(r.season_id, r.kind, r.rank, r.entity_id, r.name, r.score);
  }
  getSeasonResults(seasonId: number) {
    return this.all<SeasonResultRow>('SELECT * FROM season_results WHERE season_id = ? ORDER BY kind, rank', seasonId);
  }
}
