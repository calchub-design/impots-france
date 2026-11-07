import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RULES, type GameRules } from '../server/config.js';
import { SqliteStore } from '../server/db/sqlite.js';
import { GameEngine } from '../server/game/engine.js';

/**
 * Saison sans découverte, configurée explicitement : la plupart des tests utilisent de
 * petits cubes (moins de six couches), pour lesquels le profil « standard » est refusé.
 */
export const NO_DISCOVERIES = { discoveryProfile: 'none' } as const;

export class FakeClock {
  constructor(public t = Date.UTC(2026, 0, 15, 10, 0, 0)) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export function tempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tlb-test-'));
  return { path: join(dir, 'test.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeEngine(rules: Partial<GameRules> = {}, dbPath = ':memory:') {
  const clock = new FakeClock();
  const store = new SqliteStore(dbPath);
  const engine = new GameEngine(store, { ...DEFAULT_RULES, autoStartSeason: false, ...NO_DISCOVERIES, ...rules }, { now: clock.now });
  return { engine, store, clock };
}

let n = 0;
export function aid(prefix = 'act'): string {
  n++;
  return `${prefix}-${n.toString().padStart(6, '0')}`;
}

export function newPlayer(engine: GameEngine, name?: string): string {
  return engine.connectGuest(undefined, name).player.id;
}
