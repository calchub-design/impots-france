import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../server/game/engine.js';
import { aid, makeEngine, newPlayer } from './helpers.js';

describe('saisons', () => {
  it('le dernier bloc termine la saison : champion et Pierre finale distincts', () => {
    const { engine, clock } = makeEngine({ cubeSize: 1, baseHp: 6 });
    const events: EngineEvent[] = [];
    engine.on((e) => events.push(e));
    engine.startSeason({ name: 'Saison test' });
    const alice = newPlayer(engine, 'Alice');
    const bob = newPlayer(engine, 'Bob');
    // Alice frappe 5 fois, Bob porte le coup final.
    for (let i = 0; i < 5; i++) engine.mine(alice, { actionId: aid(), layer: 0, block: 0 });
    clock.advance(1000);
    const final = engine.mine(bob, { actionId: aid(), layer: 0, block: 0 });
    expect(final).toMatchObject({ ok: true, destroyed: true });
    expect(engine.activeSeason).toBeNull();
    const ended = events.find((e) => e.type === 'seasonEnded');
    expect(ended).toBeDefined();
    if (ended?.type !== 'seasonEnded') throw new Error();
    expect(ended.season).toMatchObject({
      name: 'Saison test',
      status: 'ended',
      endReason: 'completed',
      championName: 'Alice',
      finalStoneName: 'Bob',
    });
    const res = engine.seasonResults(ended.season.id)!;
    expect(res.players).toEqual([
      { rank: 1, name: 'Alice', hits: 5 },
      { rank: 2, name: 'Bob', hits: 1 },
    ]);
    // Plus de minage possible.
    expect(engine.mine(alice, { actionId: aid(), layer: 0, block: 0 })).toMatchObject({ reason: 'no_active_season' });
  });

  it('égalité : le joueur ayant atteint le score en premier l\'emporte', () => {
    const { engine, clock } = makeEngine({ cubeSize: 2, baseHp: 100 });
    engine.startSeason();
    const a = newPlayer(engine, 'Anna');
    const b = newPlayer(engine, 'Basile');
    engine.mine(b, { actionId: aid(), layer: 0, block: 0 });
    clock.advance(10);
    engine.mine(a, { actionId: aid(), layer: 0, block: 0 });
    expect(engine.leaderboard().map((e) => e.name)).toEqual(['Basile', 'Anna']);
    const info = engine.endSeason('admin');
    expect(info.championName).toBe('Basile');
    expect(info.finalStoneName).toBeNull();
  });

  it('la saison se termine à l\'échéance et la suivante démarre après le délai', () => {
    const { engine, clock } = makeEngine({ cubeSize: 2, autoStartSeason: true, seasonCooldownMs: 60_000, seasonDurationMs: 3600_000 });
    engine.tick();
    const s1 = engine.activeSeason!;
    expect(s1.name).toBe('Saison 1');
    expect(s1.ends_at - s1.starts_at).toBe(3600_000);
    clock.advance(3600_000);
    engine.tick();
    expect(engine.activeSeason).toBeNull();
    expect(engine.upcomingSeasonAt).toBe(clock.t + 60_000);
    expect(engine.listSeasons()[0]).toMatchObject({ endReason: 'timeout', championName: null });
    clock.advance(59_000);
    engine.tick();
    expect(engine.activeSeason).toBeNull();
    clock.advance(1000);
    engine.tick();
    expect(engine.activeSeason?.name).toBe('Saison 2');
    expect(engine.cubeSnapshot()!.destroyedBlocks).toBe(0);
  });

  it('un coup après l\'échéance clôt la saison et est refusé', () => {
    const { engine, clock } = makeEngine({ cubeSize: 2, seasonDurationMs: 1000 });
    engine.startSeason();
    const p = newPlayer(engine);
    clock.advance(1000);
    expect(engine.mine(p, { actionId: aid(), layer: 0, block: 0 })).toMatchObject({ reason: 'no_active_season' });
    expect(engine.listSeasons()[0].status).toBe('ended');
  });

  it('une seule saison active à la fois', () => {
    const { engine } = makeEngine();
    engine.startSeason();
    expect(() => engine.startSeason()).toThrow(/déjà en cours/);
  });

  it('brigade championne : uniquement parmi les brigades d\'au moins 5 membres', () => {
    const { engine, clock } = makeEngine({ cubeSize: 3, baseHp: 1000, maxActionsPerSecond: 1000 });
    engine.startSeason();
    // Brigade A : 5 membres, 5 coups chacun = 25
    const ownerA = newPlayer(engine, 'ChefA');
    const a = engine.createBrigade(ownerA, 'Les Foreurs');
    const membersA = [ownerA];
    for (let i = 0; i < 4; i++) {
      const p = newPlayer(engine, `A${i}`);
      engine.joinBrigade(p, a.inviteCode.toLowerCase());
      membersA.push(p);
    }
    // Brigade B : 2 membres, 50 coups chacun = 100 (non éligible)
    const ownerB = newPlayer(engine, 'ChefB');
    const b = engine.createBrigade(ownerB, 'Petits Bras');
    const pb = newPlayer(engine, 'B1');
    engine.joinBrigade(pb, b.inviteCode);
    for (const p of membersA) for (let i = 0; i < 5; i++) engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
    for (const p of [ownerB, pb]) for (let i = 0; i < 50; i++) engine.mine(p, { actionId: aid(), layer: 0, block: 1 });
    clock.advance(1);
    const board = engine.brigadeBoard();
    expect(board[0]).toMatchObject({ name: 'Petits Bras', hits: 100, eligible: false, members: 2 });
    expect(board[1]).toMatchObject({ name: 'Les Foreurs', hits: 25, eligible: true, members: 5 });
    const info = engine.endSeason('admin');
    expect(info.championBrigadeName).toBe('Les Foreurs');
    const res = engine.seasonResults(info.id)!;
    expect(res.brigades).toEqual([{ rank: 1, name: 'Les Foreurs', hits: 25 }]);
  });
});

describe('brigades', () => {
  it('création, code d\'invitation, adhésion et limite de 10 membres', () => {
    const { engine } = makeEngine();
    const owner = newPlayer(engine, 'Chef');
    const b = engine.createBrigade(owner, 'Les Taupes');
    expect(b.inviteCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(b.members).toHaveLength(1);
    for (let i = 0; i < 9; i++) engine.joinBrigade(newPlayer(engine), b.inviteCode);
    expect(engine.brigadeInfo(owner)!.members).toHaveLength(10);
    expect(() => engine.joinBrigade(newPlayer(engine), b.inviteCode)).toThrow(/complète/);
  });

  it('un joueur ne peut appartenir qu\'à une brigade ; noms uniques', () => {
    const { engine } = makeEngine();
    const p = newPlayer(engine);
    const q = newPlayer(engine);
    const b = engine.createBrigade(p, 'Alpha');
    expect(() => engine.createBrigade(p, 'Beta')).toThrow(/déjà/);
    expect(() => engine.createBrigade(q, 'alpha')).toThrow(/déjà pris/);
    engine.createBrigade(q, 'Gamma');
    expect(() => engine.joinBrigade(q, b.inviteCode)).toThrow(/Quittez/);
    expect(() => engine.joinBrigade(newPlayer(engine), 'ZZZZZZZZ')).toThrow(/inconnu/);
    expect(() => engine.joinBrigade(newPlayer(engine), 'bad')).toThrow(/invalide/);
    expect(() => engine.createBrigade(newPlayer(engine), 'x')).toThrow(/3 à 24/);
  });

  it('départ : transfert du rôle de chef, dissolution quand vide', () => {
    const { engine, store } = makeEngine();
    const owner = newPlayer(engine);
    const m = newPlayer(engine);
    const b = engine.createBrigade(owner, 'Delta');
    engine.joinBrigade(m, b.inviteCode);
    engine.leaveBrigade(owner);
    expect(engine.brigadeInfo(owner)).toBeNull();
    expect(engine.brigadeInfo(m)!.ownerId).toBe(m);
    engine.leaveBrigade(m);
    expect(store.getBrigade(b.id)).toBeUndefined();
    expect(() => engine.leaveBrigade(m)).toThrow(/aucune/);
  });

  it('les coups sont attribués à la brigade du moment', () => {
    const { engine, clock } = makeEngine({ cubeSize: 2, baseHp: 100 });
    engine.startSeason();
    const p = newPlayer(engine);
    engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
    const b = engine.createBrigade(p, 'Epsilon');
    clock.advance(300);
    engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
    engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
    expect(engine.brigadeBoard().find((x) => x.brigadeId === b.id)!.hits).toBe(2);
    expect(engine.myStats(p, 0).hits).toBe(3);
  });
});

describe('profil', () => {
  it('valide pseudo et skin (cosmétique uniquement)', () => {
    const { engine } = makeEngine();
    const p = newPlayer(engine);
    expect(engine.setName(p, '  Zoé   la  Mineuse ').name).toBe('Zoé la Mineuse');
    expect(() => engine.setName(p, 'a')).toThrow();
    expect(() => engine.setName(p, '<script>')).toThrow();
    expect(engine.setSkin(p, 'frost').skin).toBe('frost');
    expect(() => engine.setSkin(p, 'golden-pickaxe-x2')).toThrow(/inconnu/);
  });
});
