import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RULES, loadConfig, type GameRules } from '../server/config.js';
import { SqliteStore } from '../server/db/sqlite.js';
import { GameEngine, type EngineEvent } from '../server/game/engine.js';
import { applyHit, emptyProgress, MISSION_CONTENT, progressCaps, rankFor, validateMissionContent } from '../server/game/missions.js';
import { startGameServer, type GameServer } from '../server/net/gameServer.js';
import type { MissionsState } from '../shared/missions.js';
import type { ServerMessage } from '../shared/protocol.js';
import { aid, FakeClock, makeEngine, newPlayer, NO_DISCOVERIES, tempDbPath } from './helpers.js';
import { TestClient } from './wsClient.js';

const HOUR = 3600_000;
/** Cube de 4 couches de 4 × 4 blocs, blocs à 3 PV, cadence relevée pour les tests. */
const RULES: Partial<GameRules> = { cubeSize: 4, baseHp: 3, hpPerLayer: 0, maxActionsPerSecond: 1000, ...NO_DISCOVERIES };

const mission = (s: MissionsState, id: string) => s.missions.find((m) => m.id === id)!;
function missionEvents(engine: GameEngine) {
  const list: Extract<EngineEvent, { type: 'missions' }>[] = [];
  engine.on((e) => e.type === 'missions' && list.push(e));
  return list;
}
function hit(engine: GameEngine, clock: FakeClock, player: string, block: number, layer?: number, actionId = aid('m')) {
  clock.advance(250);
  return engine.mine(player, { actionId, layer: layer ?? engine.cubeSnapshot()!.currentLayer, block });
}
/** Détruit toute la couche courante (dernier coup donné par `last`). */
function finishLayer(engine: GameEngine, clock: FakeClock, others: string, last: string) {
  const cube = engine.cubeSnapshot()!;
  const L = cube.currentLayer;
  const alive = cube.currentHp.map((h, i) => (h > 0 ? i : -1)).filter((i) => i >= 0);
  for (const idx of alive) {
    for (let h = engine.cubeSnapshot()!.currentHp[idx]; h > 0; h--) {
      const isLast = idx === alive[alive.length - 1] && h === 1;
      expect(hit(engine, clock, isLast ? last : others, idx, L).ok).toBe(true);
    }
  }
}

describe('missions : configuration et calcul', () => {
  it('trois missions initiales aux seuils configurables 20 / 10 / 1', () => {
    expect(MISSION_CONTENT.missions.map((m) => [m.id, m.kind, m.target])).toEqual([
      ['first-impacts', 'hits', 20],
      ['explorer', 'distinct-blocks', 10],
      ['collective', 'layer-contribution', 1],
    ]);
    const base = { missions: [{ id: 'a', kind: 'hits', target: 5, title: 'A', description: 'd' }] };
    expect(validateMissionContent(base).missions[0].target).toBe(5);
    expect(() => validateMissionContent({ missions: [{ ...base.missions[0], kind: 'damage' }] })).toThrow(/type inconnu/);
    expect(() => validateMissionContent({ missions: [{ ...base.missions[0], target: 0 }] })).toThrow(/seuil/);
    expect(() => validateMissionContent({ missions: [base.missions[0], base.missions[0]] })).toThrow(/double/);
    expect(() => validateMissionContent({ ...base, ranks: [{ at: 5, title: 'x' }, { at: 2, title: 'y' }] })).toThrow(/croissants/);
  });

  it('avancement plafonné : au-delà des seuils, plus rien ne change (donc plus aucune écriture)', () => {
    const caps = progressCaps(MISSION_CONTENT);
    let p = emptyProgress();
    for (let i = 0; i < 30; i++) p = applyHit(p, 0, i % 12, caps).next;
    expect(p).toEqual({ hits: 20, blocks: Array.from({ length: 10 }, (_, i) => `0:${i}`), layers: [0], layersDone: 0 });
    expect(applyHit(p, 0, 11, caps).changed).toBe(false);
    expect(applyHit(p, 1, 0, caps)).toMatchObject({ changed: true, newLayer: true });
    expect(rankFor(MISSION_CONTENT, 0)).toEqual({ rank: null, next: { at: 1, title: 'Initié du Signal' } });
    expect(rankFor(MISSION_CONTENT, 12).rank?.title).toBe('Prospecteur');
  });
});

describe('missions : progression côté serveur', () => {
  it('« Premiers impacts » : accomplie au 20e coup validé, pas avant ; les coups refusés ne comptent pas', () => {
    const { engine, clock } = makeEngine(RULES);
    engine.startSeason();
    const ev = missionEvents(engine);
    const a = newPlayer(engine, 'Ada');
    for (let i = 0; i < 19; i++) expect(hit(engine, clock, a, i % 16).ok).toBe(true);
    // Refusés : couche verrouillée, hors limites, action mal formée.
    expect(engine.mine(a, { actionId: aid('x'), layer: 2, block: 0 }).ok).toBe(false);
    expect(engine.mine(a, { actionId: aid('x'), layer: 0, block: 999 }).ok).toBe(false);
    expect(engine.mine(a, { actionId: 'x', layer: 0, block: 0 }).ok).toBe(false);
    let s = engine.missionsState(a);
    expect(mission(s, 'first-impacts')).toMatchObject({ progress: 19, done: false });
    expect(hit(engine, clock, a, 3).ok).toBe(true);
    s = engine.missionsState(a);
    expect(mission(s, 'first-impacts')).toMatchObject({ progress: 20, done: true, completedAt: clock.t });
    expect(ev.filter((e) => e.completed.includes('first-impacts'))).toHaveLength(1);
    // Au-delà : plafonné, plus d'événement.
    hit(engine, clock, a, 4);
    expect(mission(engine.missionsState(a), 'first-impacts').progress).toBe(20);
  });

  it('coup renvoyé avec le même actionId (retransmission, reconnexion) : jamais compté deux fois', () => {
    const { engine, clock } = makeEngine(RULES);
    engine.startSeason();
    const a = newPlayer(engine);
    const id = aid('dup');
    expect(hit(engine, clock, a, 0, 0, id)).toMatchObject({ ok: true, duplicate: false });
    for (let i = 0; i < 5; i++) expect(hit(engine, clock, a, 0, 0, id)).toMatchObject({ ok: true, duplicate: true });
    const s = engine.missionsState(a);
    expect(mission(s, 'first-impacts').progress).toBe(1);
    expect(mission(s, 'explorer').progress).toBe(1);
  });

  it('« Explorateur » : 10 blocs distincts, frapper le même bloc ne compte qu\'une fois', () => {
    const { engine, clock } = makeEngine({ ...RULES, baseHp: 5 });
    engine.startSeason();
    const a = newPlayer(engine);
    for (let i = 0; i < 4; i++) hit(engine, clock, a, 7);
    for (let b = 0; b < 8; b++) hit(engine, clock, a, b === 7 ? 15 : b);
    expect(mission(engine.missionsState(a), 'explorer')).toMatchObject({ progress: 9, done: false });
    hit(engine, clock, a, 12);
    expect(mission(engine.missionsState(a), 'explorer')).toMatchObject({ progress: 10, done: true });
  });

  it('« Contribution collective » : tous ceux qui ont frappé la couche aujourd\'hui, quand elle est terminée aujourd\'hui', () => {
    const { engine, clock } = makeEngine({ ...RULES, baseHp: 1 });
    engine.startSeason();
    const a = newPlayer(engine, 'Ada');
    const b = newPlayer(engine, 'Bo');
    const c = newPlayer(engine, 'Cy'); // frappe la couche 2 seulement
    const ev = missionEvents(engine);
    hit(engine, clock, a, 0);
    expect(mission(engine.missionsState(a), 'collective').done).toBe(false);
    finishLayer(engine, clock, b, b); // Bo termine la couche 1 (Ada y a contribué)
    expect(mission(engine.missionsState(a), 'collective')).toMatchObject({ progress: 1, done: true });
    expect(mission(engine.missionsState(b), 'collective').done).toBe(true);
    hit(engine, clock, c, 0);
    expect(mission(engine.missionsState(c), 'collective').done).toBe(false);
    // Événement reçu par Ada alors que c'est Bo qui a donné le dernier coup.
    expect(ev.some((e) => e.playerId === a && e.completed.includes('collective'))).toBe(true);
  });

  it('couche frappée la veille mais terminée aujourd\'hui : il faut aussi la frapper aujourd\'hui', () => {
    const { engine, clock } = makeEngine({ ...RULES, baseHp: 1 });
    engine.startSeason();
    const a = newPlayer(engine);
    const b = newPlayer(engine);
    clock.t = Date.UTC(2026, 0, 15, 23, 50);
    hit(engine, clock, a, 0);
    clock.t = Date.UTC(2026, 0, 16, 0, 5);
    finishLayer(engine, clock, b, b);
    expect(mission(engine.missionsState(a), 'collective').done).toBe(false);
    expect(mission(engine.missionsState(b), 'collective').done).toBe(true);
  });

  it('deux joueurs simultanés : progressions indépendantes, chacun ses événements', () => {
    const { engine, clock } = makeEngine(RULES);
    engine.startSeason();
    const ev = missionEvents(engine);
    const a = newPlayer(engine);
    const b = newPlayer(engine);
    for (let i = 0; i < 25; i++) {
      hit(engine, clock, a, i % 16);
      if (i % 2 === 0) hit(engine, clock, b, (i + 5) % 16);
    }
    expect(mission(engine.missionsState(a), 'first-impacts')).toMatchObject({ progress: 20, done: true });
    expect(mission(engine.missionsState(b), 'first-impacts')).toMatchObject({ progress: 13, done: false });
    expect(ev.every((e) => e.playerId === a || e.playerId === b)).toBe(true);
    expect(ev.filter((e) => e.completed.includes('first-impacts')).map((e) => e.playerId)).toEqual([a]);
  });

  it('changement de jour UTC : remise à zéro à 00 h, historique de la veille conservé', () => {
    const { engine, clock } = makeEngine(RULES);
    engine.startSeason();
    const a = newPlayer(engine);
    clock.t = Date.UTC(2026, 0, 15, 23, 59, 0);
    for (let i = 0; i < 20; i++) hit(engine, clock, a, i % 16); // 5 s plus tard : encore le 15
    let s = engine.missionsState(a);
    expect(s.day).toBe('2026-01-15');
    expect(mission(s, 'first-impacts').done).toBe(true);
    expect(s.resetsAt).toBe(Date.UTC(2026, 0, 16));
    clock.t = Date.UTC(2026, 0, 16, 0, 0, 1);
    s = engine.missionsState(a, true);
    expect(s.day).toBe('2026-01-16');
    expect(s.missions.every((m) => m.progress === 0 && !m.done)).toBe(true);
    expect(s.history).toHaveLength(1);
    expect(s.history![0].day).toBe('2026-01-15');
    expect([...s.history![0].missions].sort()).toEqual(['explorer', 'first-impacts']);
    expect(s.seasonCompleted).toBe(2);
    hit(engine, clock, a, 0);
    expect(mission(engine.missionsState(a), 'first-impacts').progress).toBe(1);
  });

  it('historique conservé pour la saison, rang honorifique ; nouvelle saison : compteur à zéro', () => {
    const { engine, clock } = makeEngine({ ...RULES, baseHp: 50, seasonDurationMs: 60 * 24 * HOUR });
    const s1 = engine.startSeason();
    const a = newPlayer(engine);
    for (const d of [10, 11, 12]) {
      clock.t = Date.UTC(2026, 1, d, 12);
      for (let i = 0; i < 20; i++) hit(engine, clock, a, i % 16);
    }
    const st = engine.missionsState(a, true);
    expect(st.seasonCompleted).toBe(6);
    expect(st.rank?.title).toBe('Initié du Signal');
    expect(st.nextRank).toEqual({ at: 10, title: 'Prospecteur' });
    expect(st.history!.map((h) => h.day)).toEqual(['2026-02-12', '2026-02-11', '2026-02-10']);
    engine.endSeason('admin');
    expect(engine.missionsState(a)).toMatchObject({ seasonId: null, missions: [] });
    engine.startSeason();
    const st2 = engine.missionsState(a, true);
    expect(st2.seasonCompleted).toBe(0);
    expect(st2.history).toEqual([]);
    expect(engine.store.countMissionCompletions(s1.id, a)).toBe(6);
  });

  it('récompense cosmétique gratuite : teinte « Signal » débloquée par une journée complète, jamais avant', () => {
    const { engine, clock } = makeEngine({ ...RULES, baseHp: 1 });
    engine.startSeason();
    const ev = missionEvents(engine);
    const a = newPlayer(engine);
    expect(() => engine.setSkin(a, 'signal')).toThrow(/débloquer/);
    finishLayer(engine, clock, a, a); // 16 coups, 16 blocs, couche terminée
    expect(engine.missionsState(a).missions.map((m) => m.done)).toEqual([false, true, true]);
    expect(engine.missionsState(a).reward?.unlocked).toBe(false);
    for (let i = 0; i < 4; i++) hit(engine, clock, a, i);
    const s = engine.missionsState(a);
    expect(s.missions.every((m) => m.done)).toBe(true);
    expect(s.reward).toMatchObject({ unlock: 'skin:signal', unlocked: true });
    expect(ev.filter((e) => e.unlocked.includes('skin:signal'))).toHaveLength(1);
    expect(engine.setSkin(a, 'signal').skin).toBe('signal');
  });

  it('teinte « Signal » sans aucune couche terminée : les missions principales suffisent, le bonus reste un bonus', () => {
    const { engine, clock } = makeEngine({ ...RULES, baseHp: 50 }); // aucune couche ne peut tomber
    engine.startSeason();
    const ev = missionEvents(engine);
    const a = newPlayer(engine);
    expect(MISSION_CONTENT.missions.filter((m) => m.bonus).map((m) => m.id)).toEqual(['collective']);
    expect(engine.missionsState(a).missions.find((m) => m.id === 'collective')!.bonus).toBe(true);
    for (let i = 0; i < 20; i++) hit(engine, clock, a, i % 10);
    const s = engine.missionsState(a);
    expect(s.missions.map((m) => [m.id, m.done])).toEqual([
      ['first-impacts', true],
      ['explorer', true],
      ['collective', false],
    ]);
    expect(s.reward).toMatchObject({ unlock: 'skin:signal', unlocked: true });
    expect(ev.filter((e) => e.unlocked.includes('skin:signal'))).toHaveLength(1);
    expect(engine.setSkin(a, 'signal').skin).toBe('signal');
    // Le bonus reste compté dans le rang de saison quand il est accompli.
    expect(s.seasonCompleted).toBe(2);
  });

  it('configuration : la récompense quotidienne exige au moins une mission principale', () => {
    const m = { id: 'a', kind: 'hits', target: 5, title: 'A', description: 'd' };
    expect(() => validateMissionContent({ missions: [{ ...m, bonus: true }], dailyReward: { unlock: 'x', label: 'X' } })).toThrow(/principale/);
    expect(() => validateMissionContent({ missions: [{ ...m, bonus: 'oui' }] })).toThrow(/bonus/);
    expect(validateMissionContent({ missions: [m, { ...m, id: 'b', bonus: true }], dailyReward: { unlock: 'x', label: 'X' } }).missions.map((x) => x.bonus)).toEqual([false, true]);
  });

  it('aucun effet sur le jeu : PV, scores, classement, temps de jeu et cadence identiques avec ou sans missions', () => {
    const run = (withMissions: boolean) => {
      const { engine, clock } = makeEngine({ ...RULES, maxActionsPerSecond: 5 });
      if (!withMissions) {
        const m = engine.missions as unknown as Record<string, () => void>;
        m.onHit = () => {};
        m.onLayerCompleted = () => {};
      }
      engine.startSeason();
      const a = newPlayer(engine, 'Ada');
      const b = newPlayer(engine, 'Bo');
      const results: unknown[] = [];
      for (let i = 0; i < 60; i++) {
        clock.advance(i % 7 === 0 ? 50 : 180);
        results.push(engine.mine(i % 3 ? a : b, { actionId: `act-${i.toString().padStart(6, '0')}`, layer: engine.cubeSnapshot()!.currentLayer, block: (i * 5) % 16 }));
      }
      return { results, board: engine.leaderboard().map(({ playerId: _id, ...e }) => e), me: [engine.myStats(a, 0), engine.myStats(b, 0)], play: [engine.playtime(a), engine.playtime(b)], cube: engine.cubeSnapshot() };
    };
    expect(run(true)).toEqual(run(false));
  });

  it('pas de lecture répétée : une lecture par joueur et par jour, plus d\'écriture une fois les seuils atteints', () => {
    const { engine, clock, store } = makeEngine({ ...RULES, baseHp: 50 });
    engine.startSeason();
    const a = newPlayer(engine);
    const calls = { read: 0, write: 0 };
    const s = store as unknown as Record<string, (...x: unknown[]) => unknown>;
    for (const [name, key] of [['getDailyMissions', 'read'], ['saveDailyMissions', 'write']] as const) {
      const orig = s[name].bind(store);
      s[name] = (...x: unknown[]) => {
        calls[key]++;
        return orig(...x);
      };
    }
    for (let i = 0; i < 100; i++) hit(engine, clock, a, i % 12);
    for (let i = 0; i < 20; i++) engine.missionsState(a);
    expect(calls.read).toBe(1);
    expect(calls.write).toBe(20); // une écriture par coup tant que « Premiers impacts » progresse, puis plus rien
  });

  it('mémoire désynchronisée (coup finalement refusé par la base) : avancement inchangé', () => {
    const { engine, clock } = makeEngine({ ...RULES, baseHp: 1 });
    engine.startSeason();
    const a = newPlayer(engine);
    hit(engine, clock, a, 0);
    // Le bloc 0 est détruit en base ; on fait croire à la mémoire qu'il est encore vivant.
    (engine as unknown as { state: { hp: Int32Array } }).state.hp[0] = 1;
    expect(hit(engine, clock, a, 0)).toMatchObject({ ok: false, reason: 'already_destroyed' });
    expect(mission(engine.missionsState(a), 'first-impacts').progress).toBe(1);
  });
});

describe('missions : redémarrage', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  it('après un redémarrage sans fermeture propre : même avancement, pas de perte ni de double comptage', () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const clock = new FakeClock();
    const mk = () => new GameEngine(new SqliteStore(db.path), { ...DEFAULT_RULES, ...RULES, autoStartSeason: false }, { now: clock.now });
    const e1 = mk();
    e1.startSeason();
    const a = newPlayer(e1);
    for (let i = 0; i < 12; i++) hit(e1, clock, a, i);
    const before = e1.missionsState(a, true);
    const e2 = mk();
    expect(e2.missionsState(a, true)).toEqual(before);
    for (let i = 0; i < 8; i++) hit(e2, clock, a, i);
    const after = e2.missionsState(a);
    expect(mission(after, 'first-impacts')).toMatchObject({ progress: 20, done: true });
    expect(e2.store.countMissionCompletions(e2.activeSeason!.id, a)).toBe(2);
  });
});

describe('missions : WebSocket', () => {
  let server: GameServer | null = null;
  let cleanup: (() => void) | null = null;
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await server?.close();
    server = null;
    cleanup?.();
  });

  it('deux joueurs, reconnexion, renvoi d\'un coup, changement de jour : progression exacte et personnelle', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    let now = Date.UTC(2026, 3, 1, 23, 58);
    const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DB_PATH: db.path, STATIC_DIR: '/nonexistent' });
    config.rules = { ...config.rules, autoStartSeason: false, ...RULES, maxActionsPerSecond: 100 };
    server = await startGameServer({ config, manualTick: true, now: () => now });
    server.engine.startSeason();
    const A = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
    const B = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(A, B);
    const wa = await A.connect(undefined, 'Alice');
    await B.connect(undefined, 'Bob');
    expect(wa.missions?.missions.map((m) => [m.id, m.progress, m.done])).toEqual([
      ['first-impacts', 0, false],
      ['explorer', 0, false],
      ['collective', 0, false],
    ]);
    // Les deux minent en même temps.
    const ids: string[] = [];
    await Promise.all([
      (async () => {
        for (let i = 0; i < 20; i++) {
          const id = `alice-${i.toString().padStart(4, '0')}`;
          ids.push(id);
          expect((await A.mine(0, i % 16, id)).ok).toBe(true);
          now += 300;
        }
      })(),
      (async () => {
        for (let i = 0; i < 7; i++) expect((await B.mine(0, (i * 3) % 16)).ok).toBe(true);
      })(),
    ]);
    const doneMsg = A.received.find((m) => m.t === 'missions' && m.completed?.includes('first-impacts'));
    expect(doneMsg).toBeTruthy();
    // Bob ne reçoit que ses propres missions.
    const bMissions = B.received.filter((m): m is Extract<ServerMessage, { t: 'missions' }> => m.t === 'missions');
    expect(bMissions.length).toBeGreaterThan(0);
    expect(bMissions.at(-1)!.missions.missions[0].progress).toBe(7);
    expect(B.received.some((m) => m.t === 'missions' && m.completed?.includes('first-impacts'))).toBe(false);

    // Reconnexion d'Alice, puis renvoi de coups déjà appliqués : rien n'est recompté.
    await A.close();
    const w2 = await A.connect();
    expect(mission(w2.missions!, 'first-impacts')).toMatchObject({ progress: 20, done: true });
    for (const id of ids.slice(0, 5)) expect(await A.mine(0, 0, id)).toMatchObject({ ok: true, duplicate: true });
    expect(server.engine.store.countMissionCompletions(server.engine.activeSeason!.id, w2.player.id)).toBe(2);

    // Minuit UTC : les joueurs connectés reçoivent leurs missions remises à zéro.
    now = Date.UTC(2026, 3, 2, 0, 0, 1);
    const resetA = A.waitFor((m) => m.t === 'missions' && m.missions.day === '2026-04-02');
    const resetB = B.waitFor((m) => m.t === 'missions' && m.missions.day === '2026-04-02');
    server.checkDayRollover();
    const [ra, rb] = (await Promise.all([resetA, resetB])) as Extract<ServerMessage, { t: 'missions' }>[];
    expect(ra.missions.missions.every((m) => m.progress === 0 && !m.done)).toBe(true);
    expect(ra.missions.history?.[0]).toMatchObject({ day: '2026-04-01' });
    expect(rb.missions.missions[0].progress).toBe(0);
  }, 30_000);
});
