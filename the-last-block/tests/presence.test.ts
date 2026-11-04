import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.js';
import { startGameServer, type GameServer } from '../server/net/gameServer.js';
import { PRESENCE_WINDOW_MS, type ServerMessage } from '../shared/protocol.js';
import { aid, makeEngine, newPlayer, tempDbPath } from './helpers.js';
import { TestClient } from './wsClient.js';

describe('présence observée (moteur)', () => {
  it('liste le dernier bloc frappé de chaque joueur, avec sa brigade, du plus récent au plus ancien', () => {
    const { engine, clock } = makeEngine({ cubeSize: 8, baseHp: 50 });
    engine.startSeason();
    const a = newPlayer(engine, 'Ana');
    const b = newPlayer(engine, 'Bao');
    engine.createBrigade(b, 'Les Taupes');
    engine.mine(a, { actionId: aid(), layer: 0, block: 3 });
    clock.advance(1000);
    engine.mine(a, { actionId: aid(), layer: 0, block: 9 });
    clock.advance(500);
    engine.mine(b, { actionId: aid(), layer: 0, block: 20 });
    expect(engine.presence()).toEqual([
      { playerId: b, name: 'Bao', skin: 'classic', brigadeName: 'Les Taupes', block: 20, ageMs: 0 },
      { playerId: a, name: 'Ana', skin: 'classic', brigadeName: null, block: 9, ageMs: 500 },
    ]);
  });

  it('expire après 20 s sans coup ; un coup refusé ne compte pas', () => {
    const { engine, clock } = makeEngine({ cubeSize: 4, baseHp: 1 });
    engine.startSeason();
    const a = newPlayer(engine);
    engine.mine(a, { actionId: aid(), layer: 0, block: 0 });
    clock.advance(PRESENCE_WINDOW_MS);
    expect(engine.presence()).toHaveLength(1);
    clock.advance(1);
    expect(engine.presence()).toHaveLength(0);
    const b = newPlayer(engine);
    expect(engine.mine(b, { actionId: aid(), layer: 0, block: 0 }).ok).toBe(false); // déjà détruit
    expect(engine.presence()).toHaveLength(0);
  });

  it('respecte le choix de masquer sa position (persisté)', () => {
    const { engine, store } = makeEngine({ cubeSize: 4, baseHp: 9 });
    engine.startSeason();
    const a = newPlayer(engine);
    engine.setPresenceVisible(a, false);
    engine.mine(a, { actionId: aid(), layer: 0, block: 1 });
    expect(engine.presence()).toEqual([]);
    expect(store.getPlayer(a)!.presence_hidden).toBe(1);
    engine.setPresenceVisible(a, true);
    expect(engine.presence()).toHaveLength(1);
    expect(() => engine.setPresenceVisible(a, 'non')).toThrow();
  });

  it('changement de couche et fin de saison : la présence de l\'ancienne couche disparaît', () => {
    const { engine } = makeEngine({ cubeSize: 2, baseHp: 1, hpPerLayer: 0, maxActionsPerSecond: 100 });
    engine.startSeason();
    const a = newPlayer(engine);
    for (let i = 0; i < 4; i++) engine.mine(a, { actionId: aid(), layer: 0, block: i });
    expect(engine.cubeSnapshot()!.currentLayer).toBe(1);
    expect(engine.presence()).toEqual([]);
    engine.mine(a, { actionId: aid(), layer: 1, block: 2 });
    expect(engine.presence().map((p) => p.block)).toEqual([2]);
    engine.endSeason('admin');
    expect(engine.presence()).toEqual([]);
  });
});

describe('présence via WebSocket', () => {
  let server: GameServer | null = null;
  let cleanup: (() => void) | null = null;
  const clients: TestClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await server?.close();
    server = null;
    cleanup?.();
  });

  it('diffusée avec le classement ; masquable ; jamais de position de caméra', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DB_PATH: db.path, STATIC_DIR: '/nonexistent' });
    config.rules = { ...config.rules, autoStartSeason: false, cubeSize: 8, baseHp: 50 };
    server = await startGameServer({ config, manualTick: true });
    server.engine.startSeason();
    const a = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
    const b = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(a, b);
    await a.connect(undefined, 'Ana');
    const wb = await b.connect(undefined, 'Bao');
    expect(wb.presence).toEqual([]);
    expect(wb.presenceVisible).toBe(true);

    await a.mine(0, 42 % 64);
    const seen = (await b.waitFor((m) => m.t === 'leaderboard' && m.presence.length > 0)) as Extract<ServerMessage, { t: 'leaderboard' }>;
    expect(seen.presence[0]).toMatchObject({ name: 'Ana', block: 42, brigadeName: null });
    expect(Object.keys(seen.presence[0]).sort()).toEqual(['ageMs', 'block', 'brigadeName', 'name', 'playerId', 'skin']);

    a.send({ t: 'setPresence', visible: false });
    expect(await a.waitFor((m) => m.t === 'profile')).toMatchObject({ presenceVisible: false });
    await a.mine(0, 43);
    const hidden = (await b.waitFor((m) => m.t === 'leaderboard' && m.leaderboard.some((e) => e.hits === 2))) as Extract<ServerMessage, { t: 'leaderboard' }>;
    expect(hidden.presence).toEqual([]);
  });
});
