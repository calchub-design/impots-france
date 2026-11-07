import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../server/db/sqlite.js';
import { GameEngine } from '../server/game/engine.js';
import { DEFAULT_RULES } from '../server/config.js';
import { aid, makeEngine, newPlayer, tempDbPath, NO_DISCOVERIES } from './helpers.js';

describe('minage : règles de base', () => {
  it('applique un coup valide et retire un PV', () => {
    const { engine } = makeEngine({ cubeSize: 2, baseHp: 3 });
    engine.startSeason();
    const p = newPlayer(engine);
    const r = engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
    expect(r).toEqual({ ok: true, duplicate: false, layer: 0, block: 0, hpAfter: 2, destroyed: false });
    expect(engine.cubeSnapshot()!.currentHp[0]).toBe(2);
    expect(engine.myStats(p, 0)).toEqual({ hits: 1, blocks: 0, rank: 1 });
  });

  it('refuse un bloc déjà détruit', () => {
    const { engine, clock } = makeEngine({ cubeSize: 2, baseHp: 1 });
    engine.startSeason();
    const a = newPlayer(engine);
    const b = newPlayer(engine);
    expect(engine.mine(a, { actionId: aid(), layer: 0, block: 1 })).toMatchObject({ ok: true, destroyed: true });
    clock.advance(10);
    expect(engine.mine(b, { actionId: aid(), layer: 0, block: 1 })).toEqual({ ok: false, reason: 'already_destroyed' });
    expect(engine.myStats(b, 0).hits).toBe(0);
  });

  it('refuse les couches verrouillées, hors limites et les actions mal formées', () => {
    const { engine } = makeEngine({ cubeSize: 3 });
    engine.startSeason();
    const p = newPlayer(engine);
    expect(engine.mine(p, { actionId: aid(), layer: 1, block: 0 })).toMatchObject({ ok: false, reason: 'layer_locked' });
    expect(engine.mine(p, { actionId: aid(), layer: 0, block: 9 })).toMatchObject({ ok: false, reason: 'out_of_bounds' });
    expect(engine.mine(p, { actionId: aid(), layer: -1, block: 0 })).toMatchObject({ ok: false, reason: 'out_of_bounds' });
    expect(engine.mine(p, { actionId: 'court', layer: 0, block: 0 })).toMatchObject({ ok: false, reason: 'invalid_action' });
    expect(engine.mine(p, { actionId: aid(), layer: 0.5, block: 0 })).toMatchObject({ ok: false, reason: 'invalid_action' });
    expect(engine.mine(p, { actionId: aid(), layer: '0', block: 0 })).toMatchObject({ ok: false, reason: 'invalid_action' });
  });

  it('refuse le minage sans saison active', () => {
    const { engine } = makeEngine();
    const p = newPlayer(engine);
    expect(engine.mine(p, { actionId: aid(), layer: 0, block: 0 })).toEqual({ ok: false, reason: 'no_active_season' });
  });

  it('progresse de couche en couche, PV croissants avec la profondeur', () => {
    const { engine, clock } = makeEngine({ cubeSize: 2, baseHp: 1, hpPerLayer: 2, maxActionsPerSecond: 100 });
    engine.startSeason();
    const p = newPlayer(engine);
    for (let b = 0; b < 4; b++) {
      engine.mine(p, { actionId: aid(), layer: 0, block: b });
      clock.advance(5);
    }
    const snap = engine.cubeSnapshot()!;
    expect(snap.currentLayer).toBe(1);
    expect(snap.layerRemaining).toEqual([0, 4]);
    expect(snap.layerMaxHp).toEqual([1, 3]);
    expect(snap.currentHp).toEqual([3, 3, 3, 3]);
    expect(engine.mine(p, { actionId: aid(), layer: 0, block: 0 })).toMatchObject({ ok: false, reason: 'already_destroyed' });
  });
});

describe('idempotence et déduplication', () => {
  it('une action renvoyée avec le même actionId n\'est appliquée qu\'une fois', () => {
    const { engine, clock } = makeEngine({ cubeSize: 2, baseHp: 5 });
    engine.startSeason();
    const p = newPlayer(engine);
    const id = aid('dup');
    const first = engine.mine(p, { actionId: id, layer: 0, block: 0 });
    clock.advance(2000);
    const again = engine.mine(p, { actionId: id, layer: 0, block: 0 });
    expect(first).toMatchObject({ ok: true, duplicate: false, hpAfter: 4 });
    expect(again).toMatchObject({ ok: true, duplicate: true, hpAfter: 4 });
    expect(engine.cubeSnapshot()!.currentHp[0]).toBe(4);
    expect(engine.myStats(p, 0).hits).toBe(1);
  });

  it('le doublon renvoie le résultat d\'origine même si le bloc a été détruit depuis', () => {
    const { engine, clock } = makeEngine({ cubeSize: 2, baseHp: 2 });
    engine.startSeason();
    const a = newPlayer(engine);
    const b = newPlayer(engine);
    const id = aid('orig');
    engine.mine(a, { actionId: id, layer: 0, block: 0 });
    engine.mine(b, { actionId: aid(), layer: 0, block: 0 });
    clock.advance(1);
    expect(engine.mine(a, { actionId: id, layer: 0, block: 0 })).toMatchObject({ ok: true, duplicate: true, hpAfter: 1, destroyed: false });
  });

  it('le même actionId peut être utilisé par deux joueurs différents', () => {
    const { engine } = makeEngine({ cubeSize: 2, baseHp: 5 });
    engine.startSeason();
    const a = newPlayer(engine);
    const b = newPlayer(engine);
    expect(engine.mine(a, { actionId: 'same-id-123', layer: 0, block: 0 })).toMatchObject({ duplicate: false });
    expect(engine.mine(b, { actionId: 'same-id-123', layer: 0, block: 0 })).toMatchObject({ duplicate: false, hpAfter: 3 });
  });

  it('les doublons ne consomment pas la limite de débit', () => {
    const { engine } = makeEngine({ cubeSize: 2, baseHp: 50 });
    engine.startSeason();
    const p = newPlayer(engine);
    const id = aid();
    engine.mine(p, { actionId: id, layer: 0, block: 0 });
    for (let i = 0; i < 10; i++) expect(engine.mine(p, { actionId: id, layer: 0, block: 0 })).toMatchObject({ duplicate: true });
    for (let i = 0; i < 4; i++) expect(engine.mine(p, { actionId: aid(), layer: 0, block: 0 }).ok).toBe(true);
  });
});

describe('limite de débit : 5 actions par seconde et par compte', () => {
  it('refuse la 6e action dans la même seconde puis accepte après la fenêtre', () => {
    const { engine, clock } = makeEngine({ cubeSize: 4, baseHp: 100 });
    engine.startSeason();
    const p = newPlayer(engine);
    for (let i = 0; i < 5; i++) {
      expect(engine.mine(p, { actionId: aid(), layer: 0, block: i }).ok).toBe(true);
      clock.advance(100);
    }
    const r = engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
    expect(r).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(r.ok === false && r.retryAfterMs).toBe(500);
    clock.advance(500);
    expect(engine.mine(p, { actionId: aid(), layer: 0, block: 0 }).ok).toBe(true);
  });

  it('fenêtre glissante : jamais plus de 5 coups acceptés sur 1000 ms', () => {
    const { engine, clock } = makeEngine({ cubeSize: 4, baseHp: 10_000 });
    engine.startSeason();
    const p = newPlayer(engine);
    const accepted: number[] = [];
    for (let i = 0; i < 400; i++) {
      if (engine.mine(p, { actionId: aid(), layer: 0, block: i % 16 }).ok) accepted.push(clock.t);
      clock.advance(37);
    }
    for (let i = 5; i < accepted.length; i++) expect(accepted[i] - accepted[i - 5]).toBeGreaterThanOrEqual(1000);
    expect(accepted.length).toBeGreaterThan(70);
  });

  it('la limite est par compte, pas globale', () => {
    const { engine } = makeEngine({ cubeSize: 4, baseHp: 100 });
    engine.startSeason();
    const a = newPlayer(engine);
    const b = newPlayer(engine);
    for (let i = 0; i < 5; i++) engine.mine(a, { actionId: aid(), layer: 0, block: 0 });
    expect(engine.mine(a, { actionId: aid(), layer: 0, block: 0 })).toMatchObject({ reason: 'rate_limited' });
    expect(engine.mine(b, { actionId: aid(), layer: 0, block: 0 }).ok).toBe(true);
  });
});

describe('concurrence', () => {
  it('beaucoup de joueurs sur le même bloc : un seul destructeur, PV jamais négatifs', () => {
    const { engine, clock, store } = makeEngine({ cubeSize: 2, baseHp: 37 });
    engine.startSeason();
    const players = Array.from({ length: 20 }, () => newPlayer(engine));
    const results = [];
    // 20 joueurs x 5 tentatives "simultanées" (même horodatage) sur le bloc unique.
    for (let round = 0; round < 5; round++) {
      for (const p of players) results.push({ p, r: engine.mine(p, { actionId: aid(), layer: 0, block: 0 }) });
    }
    clock.advance(1);
    const ok = results.filter((x) => x.r.ok);
    const destroyers = ok.filter((x) => x.r.ok && x.r.destroyed);
    expect(ok.length).toBe(37);
    expect(destroyers.length).toBe(1);
    expect(results.filter((x) => !x.r.ok).every((x) => !x.r.ok && x.r.reason === 'already_destroyed')).toBe(true);
    expect(store.countHits(engine.activeSeason!.id)).toBe(37);
    const totalHits = players.reduce((s, p) => s + engine.myStats(p, 0).hits, 0);
    expect(totalHits).toBe(37);
  });

  it('la base reste la source de vérité si la mémoire est désynchronisée', () => {
    const { engine, store } = makeEngine({ cubeSize: 2, baseHp: 1 });
    const season = engine.startSeason();
    const p = newPlayer(engine);
    // Destruction "externe" (autre processus) directement en base.
    store.damageBlock(season.id, 0, 0, 'external', 0);
    expect(engine.mine(p, { actionId: aid(), layer: 0, block: 0 })).toEqual({ ok: false, reason: 'already_destroyed' });
    expect(store.countHits(season.id)).toBe(0);
  });
});

describe('persistance et reprise', () => {
  it('reprend l\'état du cube, les contributions et la déduplication après redémarrage', () => {
    const db = tempDbPath();
    try {
      const rules = { ...DEFAULT_RULES, ...NO_DISCOVERIES, cubeSize: 2, baseHp: 2, autoStartSeason: false };
      const s1 = new SqliteStore(db.path);
      let t = Date.UTC(2026, 0, 1);
      const e1 = new GameEngine(s1, rules, { now: () => t });
      e1.startSeason();
      const { player, token } = e1.connectGuest(undefined, 'Alice');
      e1.mine(player.id, { actionId: 'persist-0001', layer: 0, block: 0 });
      e1.mine(player.id, { actionId: 'persist-0002', layer: 0, block: 0 });
      e1.mine(player.id, { actionId: 'persist-0003', layer: 0, block: 1 });
      s1.close();

      const s2 = new SqliteStore(db.path);
      t += 5000;
      const e2 = new GameEngine(s2, rules, { now: () => t });
      const again = e2.connectGuest(token);
      expect(again.player).toEqual({ id: player.id, name: 'Alice', skin: 'classic' });
      expect(again.token).toBeUndefined();
      const snap = e2.cubeSnapshot()!;
      expect(snap.currentHp).toEqual([0, 1, 2, 2]);
      expect(snap.layerRemaining).toEqual([3, 4]);
      expect(e2.myStats(player.id, 0)).toEqual({ hits: 3, blocks: 1, rank: 1 });
      expect(e2.mine(player.id, { actionId: 'persist-0002', layer: 0, block: 0 })).toMatchObject({ duplicate: true, hpAfter: 0, destroyed: true });
      expect(e2.mine(player.id, { actionId: 'persist-0004', layer: 0, block: 1 })).toMatchObject({ duplicate: false, hpAfter: 0 });
      s2.close();
    } finally {
      db.cleanup();
    }
  });

  it('un jeton inconnu ou mal formé ne reprend aucun compte', () => {
    const { engine } = makeEngine();
    engine.createGuest('Alice');
    expect(engine.resumeGuest('x'.repeat(43))).toBeNull();
    expect(engine.resumeGuest('court')).toBeNull();
    expect(engine.resumeGuest({ id: 'x' })).toBeNull();
    expect(engine.resumeGuest(undefined)).toBeNull();
  });
});
