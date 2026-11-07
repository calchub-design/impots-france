import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RULES, loadConfig, type GameRules } from '../server/config.js';
import { SqliteStore } from '../server/db/sqlite.js';
import { GameEngine, type EngineEvent } from '../server/game/engine.js';
import { BRIGADE_OBJECTIVES, BrigadeObjectiveTracker, tiersReached, validateBrigadeObjectives } from '../server/game/brigadeObjectives.js';
import { startGameServer, type GameServer } from '../server/net/gameServer.js';
import { brigadeEmblem, BRIGADE_EMBLEMS } from '../shared/brigades.js';
import type { BrigadeInfo, ServerMessage } from '../shared/protocol.js';
import { aid, FakeClock, makeEngine, newPlayer, NO_DISCOVERIES, tempDbPath } from './helpers.js';
import { TestClient } from './wsClient.js';

/** Grands blocs : aucune couche ne tombe (sauf indication), cadence relevée pour les tests. */
const RULES: Partial<GameRules> = { cubeSize: 4, baseHp: 100_000, hpPerLayer: 0, maxActionsPerSecond: 100_000, ...NO_DISCOVERIES };

function makeBrigade(engine: GameEngine, size: number, name = 'Les Foreurs') {
  const ids = Array.from({ length: size }, (_, i) => newPlayer(engine, `${name.slice(0, 8)}-${i}`));
  const info = engine.createBrigade(ids[0], name);
  for (const id of ids.slice(1)) engine.joinBrigade(id, info.inviteCode);
  return { ids, code: info.inviteCode, id: info.id };
}
function mineN(engine: GameEngine, clock: FakeClock, player: string, n: number) {
  for (let i = 0; i < n; i++) {
    clock.advance(1);
    const cube = engine.cubeSnapshot()!;
    const block = cube.currentHp.findIndex((h, j) => h > 0 && j >= (i % cube.currentHp.length)) ;
    const r = engine.mine(player, { actionId: aid('b'), layer: cube.currentLayer, block: block >= 0 ? block : cube.currentHp.findIndex((h) => h > 0) });
    expect(r.ok).toBe(true);
  }
}
const obj = (info: BrigadeInfo | null, id: string) => info!.objectives!.objectives.find((o) => o.id === id)!;
function progressEvents(engine: GameEngine) {
  const list: Extract<EngineEvent, { type: 'brigadeProgress' }>[] = [];
  engine.on((e) => e.type === 'brigadeProgress' && list.push(e));
  return list;
}

describe('objectifs de brigade : configuration', () => {
  it('trois objectifs à paliers, adaptés aux petits groupes', () => {
    expect(BRIGADE_OBJECTIVES.objectives.map((o) => [o.id, o.kind, o.tiers, o.minHits ?? null])).toEqual([
      ['effort', 'brigade-hits', [500, 5000, 25000], null],
      ['together', 'members-min-hits', [2, 3, 5], 100],
      ['signal', 'layers-explored', [1, 3, 6], 50],
    ]);
    // Tous les premiers paliers sont accessibles à une brigade de deux membres.
    expect(BRIGADE_OBJECTIVES.objectives.find((o) => o.id === 'together')!.tiers[0]).toBeLessThanOrEqual(2);
    expect(tiersReached([2, 3, 5], 4)).toBe(2);
  });

  it('validation du fichier : paliers croissants, minHits requis, au plus 10 membres, libellés des paliers', () => {
    const ok = { objectives: [{ id: 'a', kind: 'brigade-hits', title: 'A', description: 'd', tiers: [1, 2] }], tierLabels: ['I', 'II'] };
    expect(() => validateBrigadeObjectives(ok)).not.toThrow();
    expect(() => validateBrigadeObjectives({ ...ok, objectives: [{ ...ok.objectives[0], tiers: [2, 2] }] })).toThrow(/croissants/);
    expect(() => validateBrigadeObjectives({ ...ok, objectives: [{ ...ok.objectives[0], kind: 'members-min-hits' }] })).toThrow(/minHits/);
    expect(() => validateBrigadeObjectives({ ...ok, objectives: [{ ...ok.objectives[0], kind: 'members-min-hits', minHits: 5, tiers: [3, 11] }] })).toThrow(/10 membres/);
    expect(() => validateBrigadeObjectives({ ...ok, tierLabels: ['I'] })).toThrow(/tierLabels/);
    expect(() => validateBrigadeObjectives({ ...ok, objectives: [{ ...ok.objectives[0], kind: 'bonus-degats' }] })).toThrow(/type inconnu/);
  });

  it('emblème stable dérivé du nom', () => {
    expect(brigadeEmblem('Les Foreurs')).toBe(brigadeEmblem('Les Foreurs'));
    expect(BRIGADE_EMBLEMS).toContain(brigadeEmblem('Taupes du Nord'));
  });
});

describe('objectifs de brigade : progression', () => {
  it('brigade de 2 membres (non qualifiée au titre) : progresse, palier « Effort collectif I » au 500e coup', () => {
    const { engine, clock } = makeEngine(RULES);
    engine.startSeason();
    const ev = progressEvents(engine);
    const b = makeBrigade(engine, 2);
    mineN(engine, clock, b.ids[0], 300);
    mineN(engine, clock, b.ids[1], 199);
    let info = engine.brigadeInfo(b.ids[0]);
    expect(obj(info, 'effort')).toMatchObject({ value: 499, reached: 0 });
    expect(engine.brigadeBoard()[0]).toMatchObject({ eligible: false, hits: 499 });
    mineN(engine, clock, b.ids[1], 1);
    info = engine.brigadeInfo(b.ids[1]);
    expect(obj(info, 'effort')).toMatchObject({ value: 500, reached: 1 });
    // Le second membre a franchi 100 coups avant : « Tous ensemble I » est aussi débloqué.
    expect(info!.objectives!.distinctions.map((d) => d.label).sort()).toEqual(['Effort collectif I', 'Tous ensemble I']);
    expect(info!.objectives).toMatchObject({ title: 'Brigade éveillée', frame: 1, totals: { hits: 500 } });
    expect(ev.filter((e) => e.unlocked.length).map((e) => e.unlocked)).toEqual([['Tous ensemble I'], ['Effort collectif I']]);
    // « Tous ensemble » : deux membres à 100 coups ou plus.
    expect(obj(info, 'together')).toMatchObject({ value: 2, reached: 1, minHits: 100 });
    // Contribution de chaque membre, POUR la brigade.
    expect(info!.objectives!.contributors.map((c) => [c.name, c.hits, c.member])).toEqual([
      ['Les Fore-0', 300, true],
      ['Les Fore-1', 200, true],
    ]);
  });

  it('brigade de 5 membres : « Tous ensemble » compte les membres distincts au-dessus du minimum, pas les coups', () => {
    const { engine, clock } = makeEngine(RULES);
    engine.startSeason();
    const b = makeBrigade(engine, 5);
    mineN(engine, clock, b.ids[0], 400); // un seul gros contributeur
    expect(obj(engine.brigadeInfo(b.ids[0]), 'together')).toMatchObject({ value: 1, reached: 0 });
    mineN(engine, clock, b.ids[1], 100);
    mineN(engine, clock, b.ids[2], 100);
    mineN(engine, clock, b.ids[3], 99);
    const info = engine.brigadeInfo(b.ids[4]);
    expect(obj(info, 'together')).toMatchObject({ value: 3, reached: 2 });
    expect(engine.brigadeBoard()[0].eligible).toBe(true);
    expect(info!.objectives!.distinctions.map((d) => d.label).sort()).toEqual(['Effort collectif I', 'Tous ensemble I', 'Tous ensemble II']);
  });

  it('brigade de 10 membres : tous les paliers de « Tous ensemble » ; brigade pleine refusée au 11e', () => {
    const { engine, clock } = makeEngine(RULES);
    engine.startSeason();
    const b = makeBrigade(engine, 10);
    const extra = newPlayer(engine);
    expect(() => engine.joinBrigade(extra, b.code)).toThrow(/complète/);
    for (const id of b.ids) mineN(engine, clock, id, 100);
    const info = engine.brigadeInfo(b.ids[0]);
    expect(obj(info, 'together')).toMatchObject({ value: 10, reached: 3 });
    expect(obj(info, 'effort')).toMatchObject({ value: 1000, reached: 1 });
    expect(info!.objectives!.contributors).toHaveLength(10);
  });

  it('« Exploration du Signal » : couche terminée où la brigade a donné au moins 50 coups', () => {
    const { engine, clock } = makeEngine({ ...RULES, cubeSize: 8, baseHp: 1 }); // 64 blocs à 1 PV par couche
    engine.startSeason();
    const a = makeBrigade(engine, 2, 'Alpha');
    const z = makeBrigade(engine, 2, 'Zeta');
    mineN(engine, clock, a.ids[0], 30);
    mineN(engine, clock, a.ids[1], 24); // Alpha : 54 coups sur la couche 1
    mineN(engine, clock, z.ids[0], 9); // Zeta : 9 coups
    expect(obj(engine.brigadeInfo(a.ids[0]), 'signal').value).toBe(0); // couche pas encore terminée
    const solo = newPlayer(engine);
    mineN(engine, clock, solo, 1); // le dernier bloc par un joueur sans brigade
    expect(engine.cubeSnapshot()!.currentLayer).toBe(1);
    expect(obj(engine.brigadeInfo(a.ids[0]), 'signal')).toMatchObject({ value: 1, reached: 1 });
    expect(obj(engine.brigadeInfo(z.ids[0]), 'signal')).toMatchObject({ value: 0, reached: 0 });
  });

  it('arrivées et départs : contributions acquises à la brigade du moment, jamais transférées ni recomptées', () => {
    const { engine, clock, store } = makeEngine(RULES);
    const season = engine.startSeason();
    const a = makeBrigade(engine, 3, 'Alpha');
    const nomade = a.ids[2];
    mineN(engine, clock, nomade, 60);
    engine.leaveBrigade(nomade);
    mineN(engine, clock, nomade, 40); // sans brigade : pour personne
    let info = engine.brigadeInfo(a.ids[0]);
    expect(info!.objectives!.contributors.find((c) => c.id === nomade)).toMatchObject({ hits: 60, member: false });
    expect(obj(info, 'effort').value).toBe(60);
    const b = makeBrigade(engine, 1, 'Beta');
    engine.joinBrigade(nomade, b.code);
    mineN(engine, clock, nomade, 50);
    expect(engine.brigadeInfo(nomade)!.objectives!.contributors.find((c) => c.id === nomade)!.hits).toBe(50);
    expect(obj(engine.brigadeInfo(a.ids[0]), 'effort').value).toBe(60); // Alpha inchangée
    // Retour dans Alpha : la contribution reprend à 60, sans remise à zéro ni double compte.
    engine.leaveBrigade(nomade);
    engine.joinBrigade(nomade, a.code);
    mineN(engine, clock, nomade, 40);
    info = engine.brigadeInfo(nomade);
    expect(info!.objectives!.contributors.find((c) => c.id === nomade)).toMatchObject({ hits: 100, member: true });
    expect(obj(info, 'together').value).toBe(1); // a franchi 100 coups pour Alpha
    // Somme des contributions par brigade = coups donnés en brigade (journal des coups).
    const perBrigade = [a.id, b.id].map((id) => store.getBrigadeMemberHits(season.id, id).find((r) => r.player_id === nomade)?.hits ?? 0);
    expect(perBrigade).toEqual([100, 50]);
    expect(engine.myStats(nomade, 0).hits).toBe(190);
  });

  it('pas de remise à zéro abusive : dissoudre puis recréer donne une nouvelle brigade sans les distinctions', () => {
    const { engine, clock } = makeEngine(RULES);
    engine.startSeason();
    const a = makeBrigade(engine, 2, 'Phénix');
    mineN(engine, clock, a.ids[0], 500);
    expect(engine.brigadeInfo(a.ids[0])!.objectives!.distinctions).toHaveLength(1);
    engine.leaveBrigade(a.ids[1]);
    engine.leaveBrigade(a.ids[0]); // brigade vide : supprimée
    const again = engine.createBrigade(a.ids[0], 'Phénix');
    expect(again.id).not.toBe(a.id);
    expect(again.objectives).toMatchObject({ distinctions: [], title: null, frame: 0, totals: { hits: 0 } });
    expect(obj(again, 'effort').value).toBe(0);
    // Regagner le palier exige de vrais coups, comptés à nouveau une seule fois.
    mineN(engine, clock, a.ids[0], 500);
    expect(engine.brigadeInfo(a.ids[0])!.objectives!.distinctions.map((d) => d.label)).toEqual(['Effort collectif I']);
  });

  it('doublons (même actionId) jamais comptés ; distinction enregistrée une seule fois', () => {
    const { engine, clock, store } = makeEngine(RULES);
    const season = engine.startSeason();
    const b = makeBrigade(engine, 2);
    mineN(engine, clock, b.ids[0], 499);
    const id = aid('dup');
    for (let i = 0; i < 4; i++) engine.mine(b.ids[1], { actionId: id, layer: 0, block: 3 });
    const info = engine.brigadeInfo(b.ids[0]);
    expect(obj(info, 'effort').value).toBe(500);
    expect(info!.objectives!.contributors.find((c) => c.id === b.ids[1])!.hits).toBe(1);
    expect(store.insertBrigadeDistinction(season.id, b.id, 'effort', 1, clock.t)).toBe(false);
  });

  it('aucun effet sur le jeu ni le championnat : résultats identiques avec ou sans objectifs de brigade', () => {
    const run = (withObjectives: boolean) => {
      const { engine, clock } = makeEngine({ ...RULES, baseHp: 3, maxActionsPerSecond: 5 });
      if (!withObjectives) {
        const t = engine.brigadeObjectives as unknown as Record<string, () => void>;
        t.onHit = () => {};
        t.onLayerCompleted = () => {};
      }
      engine.startSeason();
      const b = makeBrigade(engine, 3);
      const results: unknown[] = [];
      for (let i = 0; i < 90; i++) {
        clock.advance(i % 5 === 0 ? 40 : 170);
        results.push(engine.mine(b.ids[i % 3], { actionId: `act-${String(i).padStart(6, '0')}`, layer: engine.cubeSnapshot()!.currentLayer, block: (i * 7) % 16 }));
      }
      const strip = <T extends object>(xs: T[]) => xs.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'playerId' && k !== 'brigadeId')));
      return { results, board: strip(engine.leaderboard()), brigades: strip(engine.brigadeBoard()), me: b.ids.map((id) => engine.myStats(id, 0)), play: b.ids.map((id) => engine.playtime(id)), cube: engine.cubeSnapshot() };
    };
    expect(run(true)).toEqual(run(false));
  });

  it('nouvelle saison : objectifs remis à zéro, distinctions de la saison passée conservées avec son nom', () => {
    const { engine, clock } = makeEngine(RULES);
    engine.startSeason({ name: 'Saison 1' });
    const b = makeBrigade(engine, 2);
    mineN(engine, clock, b.ids[0], 500);
    engine.endSeason('admin');
    // Intersaison : identité et distinctions, pas d'objectifs.
    expect(engine.brigadeInfo(b.ids[0])!.objectives).toMatchObject({ objectives: [], distinctions: [{ seasonName: 'Saison 1', label: 'Effort collectif I' }] });
    engine.startSeason({ name: 'Saison 2' });
    const info = engine.brigadeInfo(b.ids[0])!;
    expect(obj(info, 'effort').value).toBe(0);
    expect(info.objectives!.title).toBeNull();
    expect(info.objectives!.distinctions.map((d) => d.seasonName)).toEqual(['Saison 1']);
  });
});

describe('objectifs de brigade : redémarrage', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  it('après un redémarrage sans fermeture propre : même progression, mêmes distinctions, suite exacte', () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const clock = new FakeClock();
    const mk = () => new GameEngine(new SqliteStore(db.path), { ...DEFAULT_RULES, ...RULES, autoStartSeason: false }, { now: clock.now });
    const e1 = mk();
    e1.startSeason();
    const b = makeBrigade(e1, 3);
    mineN(e1, clock, b.ids[0], 120);
    mineN(e1, clock, b.ids[1], 99);
    const before = e1.brigadeInfo(b.ids[0]);
    const e2 = mk();
    expect(e2.brigadeInfo(b.ids[0])).toEqual(before);
    mineN(e2, clock, b.ids[1], 1);
    expect(obj(e2.brigadeInfo(b.ids[2]), 'together')).toMatchObject({ value: 2, reached: 1 });
  });
});

describe('objectifs de brigade : WebSocket', () => {
  let server: GameServer | null = null;
  let cleanup: (() => void) | null = null;
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await server?.close();
    server = null;
    cleanup?.();
  });

  it('contributions simultanées, distinctions reçues par tous les membres, rien pour les autres, reconnexion', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DB_PATH: db.path, STATIC_DIR: '/nonexistent' });
    config.rules = { ...config.rules, autoStartSeason: false, ...RULES, maxActionsPerSecond: 1000 };
    server = await startGameServer({ config, manualTick: true });
    // Seuils réduits (même code, autre fichier de configuration) : la protection anti-flood
    // limite chaque connexion à 40 messages/s, on mine donc peu et au rythme d'un joueur.
    const small = validateBrigadeObjectives({ ...BRIGADE_OBJECTIVES, objectives: BRIGADE_OBJECTIVES.objectives.map((o) => ({ ...o, tiers: o.id === 'effort' ? [60, 600, 6000] : o.tiers, ...(o.minHits ? { minHits: 5 } : {}) })) });
    (server.engine as unknown as { brigadeObjectives: BrigadeObjectiveTracker }).brigadeObjectives = new BrigadeObjectiveTracker(server.store, small);
    server.engine.startSeason();
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const members = [0, 1, 2].map(() => new TestClient(url));
    const outsider = new TestClient(url);
    clients.push(...members, outsider);
    for (const [i, c] of members.entries()) await c.connect(undefined, `Membre ${i}`);
    await outsider.connect(undefined, 'Dehors');
    members[0].send({ t: 'brigadeCreate', name: 'Les Foreurs' });
    const created = (await members[0].waitFor((m) => m.t === 'brigade' && m.brigade !== null)) as Extract<ServerMessage, { t: 'brigade' }>;
    for (const c of members.slice(1)) {
      c.send({ t: 'brigadeJoin', code: created.brigade!.inviteCode });
      await c.waitFor((m) => m.t === 'brigade' && m.brigade !== null).catch((e) => {
        throw new Error(`${e.message} ${JSON.stringify(c.received.map((m) => m.t === 'error' ? m : m.t))}`);
      });
    }
    const unlockedAll = members.map((c) => c.waitFor((m) => m.t === 'brigade' && !!m.unlocked?.includes('Effort collectif I'), 20_000));
    // Deux membres minent en même temps ; le troisième ne mine pas mais reçoit la distinction.
    await Promise.all(
      [members[0], members[1]].map(async (c, k) => {
        for (let i = 0; i < 30; i++) {
          expect((await c.mine(0, (i + k * 5) % 16)).ok).toBe(true);
          await new Promise((r) => setTimeout(r, 30));
        }
      }),
    );
    const got = (await Promise.all(unlockedAll)) as Extract<ServerMessage, { t: 'brigade' }>[];
    for (const g of got) expect(g.brigade!.objectives!.distinctions.map((d) => d.label)).toContain('Effort collectif I');
    expect(outsider.received.some((m) => m.t === 'brigade' && m.brigade !== null)).toBe(false);
    // Mise à jour groupée de la progression : le troisième membre voit les 500 coups.
    await members[2].waitFor((m) => m.t === 'brigade' && m.brigade?.objectives?.totals.hits === 60).catch(() => null);
    const last = members[2].received.filter((m): m is Extract<ServerMessage, { t: 'brigade' }> => m.t === 'brigade').at(-1)!;
    expect(last.brigade!.objectives!.totals.hits).toBe(60);
    expect(last.brigade!.objectives!.objectives.find((o) => o.id === 'together')).toMatchObject({ value: 2, reached: 1 });
    // Reconnexion : même état.
    await members[1].close();
    const w = await members[1].connect();
    expect(w.brigade!.objectives!.objectives.find((o) => o.id === 'effort')).toMatchObject({ value: 60, reached: 1 });
    expect(w.brigade!.objectives!.contributors.map((c) => c.hits)).toEqual([30, 30, 0]);
  }, 40_000);
});
