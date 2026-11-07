import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_RULES, loadConfig, type GameRules } from '../server/config.js';
import { SqliteStore } from '../server/db/sqlite.js';
import { GameEngine, type EngineEvent } from '../server/game/engine.js';
import { startGameServer, type GameServer } from '../server/net/gameServer.js';
import { CEREMONY_MS, CEREMONY_STEPS, ceremonyPosition } from '../shared/ceremony.js';
import { DISCOVERY_CONTENT } from '../server/game/discoveries.js';
import type { ServerMessage } from '../shared/protocol.js';
import { aid, FakeClock, makeEngine, newPlayer, NO_DISCOVERIES, tempDbPath } from './helpers.js';
import { TestClient } from './wsClient.js';

/** Cube de 4 couches de 4 × 4 blocs à 1 PV, quatre fragments (profil mini-48h). */
const RULES: Partial<GameRules> = { cubeSize: 4, baseHp: 1, hpPerLayer: 0, maxActionsPerSecond: 1000, discoveryProfile: 'mini-48h', brigadeMinSize: 5 };

function ended(engine: GameEngine) {
  const list: Extract<EngineEvent, { type: 'seasonEnded' }>[] = [];
  engine.on((e) => e.type === 'seasonEnded' && list.push(e));
  return list;
}
/** Détruit les couches entières jusqu'à n'en laisser que `keepBlocks` blocs vivants dans tout le cube. */
function mineAll(engine: GameEngine, clock: FakeClock, players: string[], keepBlocks = 0) {
  let k = 0;
  for (;;) {
    const cube = engine.cubeSnapshot();
    if (!cube) return;
    const remaining = cube.layerRemaining.reduce((s, n) => s + n, 0);
    if (remaining <= keepBlocks) return;
    const idx = cube.currentHp.findIndex((h) => h > 0);
    clock.advance(10);
    expect(engine.mine(players[k++ % players.length], { actionId: aid('c'), layer: cube.currentLayer, block: idx }).ok).toBe(true);
  }
}

describe('cérémonie : déroulé', () => {
  it('six moments, entre 30 et 45 secondes, position synchronisée sur l\'horloge serveur', () => {
    expect(CEREMONY_STEPS.map((s) => s.id)).toEqual(['silence', 'champion', 'brigade', 'stone', 'secrets', 'cause']);
    expect(CEREMONY_MS).toBeGreaterThanOrEqual(30_000);
    expect(CEREMONY_MS).toBeLessThanOrEqual(45_000);
    expect(ceremonyPosition(0)).toEqual({ index: 0, inStepMs: 0 });
    expect(ceremonyPosition(6500)).toEqual({ index: 1, inStepMs: 500 });
    expect(ceremonyPosition(CEREMONY_MS - 1)?.index).toBe(5);
    expect(ceremonyPosition(CEREMONY_MS)).toBeNull();
    expect(ceremonyPosition(-2000)).toEqual({ index: 0, inStepMs: 0 });
  });
});

describe('cérémonie : archive de fin de saison', () => {
  it('dernier bloc frappé par deux joueurs au même instant : une seule clôture, une seule Pierre finale', () => {
    const { engine, clock, store } = makeEngine(RULES);
    const season = engine.startSeason();
    const ev = ended(engine);
    const a = newPlayer(engine, 'Ada');
    const b = newPlayer(engine, 'Bo');
    mineAll(engine, clock, [a, b], 1);
    const cube = engine.cubeSnapshot()!;
    const last = cube.currentHp.findIndex((h) => h > 0);
    clock.advance(10);
    const r1 = engine.mine(b, { actionId: aid('x'), layer: cube.currentLayer, block: last });
    const r2 = engine.mine(a, { actionId: aid('y'), layer: cube.currentLayer, block: last });
    expect(r1).toMatchObject({ ok: true, destroyed: true });
    expect(r2.ok).toBe(false);
    expect(ev).toHaveLength(1);
    const arc = ev[0].archive;
    expect(arc).toMatchObject({ seasonId: season.id, endReason: 'completed', finalStone: { name: 'Bo' }, closedAt: clock.t });
    expect(arc.totals).toMatchObject({ blocksDestroyed: 64, totalBlocks: 64, miners: 2 });
    expect(arc.discoveries.map((d) => d.code)).toEqual(['01', '03', '04', '06']);
    expect(store.countArchives(season.id)).toBe(1);
    // Clôturer une seconde fois est impossible ; rien n'est réattribué.
    expect(() => engine.endSeason('admin')).toThrow();
    expect(store.endSeason(season.id, { endedAt: 1, reason: 'admin', championPlayerId: null, championBrigadeId: null, finalStonePlayerId: null })).toBe(false);
    expect(() => store.insertSeasonArchive(season.id, '{}', 1)).toThrow();
    expect(engine.seasonArchive(season.id)).toEqual(arc);
  });

  it('champion et podium : méthode de classement et de départage du serveur (coups, puis antériorité)', () => {
    const { engine, clock } = makeEngine({ ...RULES, baseHp: 1000 });
    engine.startSeason();
    const [a, b, c] = ['Ada', 'Bo', 'Cy'].map((n) => newPlayer(engine, n));
    for (const [p, n] of [[b, 5], [a, 5], [c, 3]] as const) {
      for (let i = 0; i < n; i++) {
        clock.advance(10);
        engine.mine(p, { actionId: aid('r'), layer: 0, block: i });
      }
    }
    const board = engine.leaderboard();
    engine.endSeason('admin');
    const arc = engine.lastArchive()!;
    // Bo atteint 5 coups avant Ada : il est champion, comme dans le classement du serveur.
    expect(arc.podium.map((p) => [p.rank, p.name, p.hits])).toEqual(board.slice(0, 3).map((e) => [e.rank, e.name, e.hits]));
    expect(arc.champion).toMatchObject({ name: 'Bo', rank: 1, hits: 5 });
  });

  it('temps écoulé sans cube terminé : fin datée de l\'échéance, aucune Pierre finale, fragments verrouillés absents', () => {
    const { engine, clock } = makeEngine({ ...RULES, seasonDurationMs: 3600_000 });
    const season = engine.startSeason();
    const a = newPlayer(engine);
    mineAll(engine, clock, [a], 64 - 16); // première couche seulement
    clock.advance(2 * 3600_000);
    engine.tick();
    const arc = engine.seasonArchive(season.id)!;
    expect(arc).toMatchObject({ endReason: 'timeout', endedAt: season.ends_at, closedAt: clock.t, finalStone: null });
    expect(arc.discoveries.map((d) => d.code)).toEqual(['01']);
    expect(arc.discoveriesTotal).toBe(4);
    const json = JSON.stringify(arc);
    for (const f of DISCOVERY_CONTENT.fragments.filter((x) => ['predecessors', 'warning', 'final-transmission'].includes(x.id))) {
      expect(json).not.toContain(f.text);
      expect(json).not.toContain(f.title);
    }
  });

  it('clôture administrative et saison sans contribution : pas de champion, pas de brigade, pas de Pierre finale', () => {
    const { engine } = makeEngine(RULES);
    const season = engine.startSeason();
    engine.endSeason('admin');
    expect(engine.seasonArchive(season.id)).toMatchObject({
      endReason: 'admin',
      champion: null,
      podium: [],
      championBrigade: null,
      finalStone: null,
      totals: { hits: 0, blocksDestroyed: 0, miners: 0, brigades: 0 },
      discoveries: [],
    });
  });

  it('brigade championne : uniquement si qualifiée (effectif minimal), avec emblème, contribution et membres', () => {
    const run = (minSize: number) => {
      const { engine, clock } = makeEngine({ ...RULES, baseHp: 1000, brigadeMinSize: minSize });
      engine.startSeason();
      const a = newPlayer(engine, 'Ada');
      const b = newPlayer(engine, 'Bo');
      const info = engine.createBrigade(a, 'Les Foreurs');
      engine.joinBrigade(b, info.inviteCode);
      for (let i = 0; i < 6; i++) {
        clock.advance(10);
        engine.mine(i % 2 ? a : b, { actionId: aid('q'), layer: 0, block: i });
      }
      engine.endSeason('admin');
      return engine.lastArchive()!;
    };
    expect(run(5)).toMatchObject({ championBrigade: null, brigadeMinSize: 5 });
    expect(run(2).championBrigade).toMatchObject({ name: 'Les Foreurs', hits: 6, members: 2 });
    expect(run(2).championBrigade!.emblem.length).toBeGreaterThan(0);
  });

  it('archive figée : un champion qui change de pseudo ensuite ne réécrit pas l\'histoire', () => {
    const { engine, clock } = makeEngine({ ...RULES, baseHp: 1000 });
    const s = engine.startSeason();
    const a = newPlayer(engine, 'Ancien');
    clock.advance(10);
    engine.mine(a, { actionId: aid('n'), layer: 0, block: 0 });
    engine.endSeason('admin');
    engine.setName(a, 'Nouveau');
    expect(engine.seasonArchive(s.id)!.champion!.name).toBe('Ancien');
  });

  it('nouvelle saison après l\'ancienne : Hall des deux saisons, archive de la première inchangée', () => {
    const { engine, clock } = makeEngine({ ...RULES, baseHp: 1000 });
    const s1 = engine.startSeason({ name: 'Saison 1' });
    const a = newPlayer(engine, 'Ada');
    clock.advance(10);
    engine.mine(a, { actionId: aid('h'), layer: 0, block: 0 });
    engine.endSeason('admin');
    const arc1 = engine.seasonArchive(s1.id);
    const s2 = engine.startSeason({ name: 'Saison 2' });
    for (let i = 0; i < 4; i++) {
      clock.advance(10);
      engine.mine(a, { actionId: aid('h'), layer: 0, block: i });
    }
    expect(engine.seasonArchive(s1.id)).toEqual(arc1);
    expect(engine.seasonArchive(s2.id)).toBeNull(); // encore en cours
    engine.endSeason('admin');
    expect(engine.hall().map((x) => [x.seasonName, x.champion?.hits])).toEqual([
      ['Saison 2', 4],
      ['Saison 1', 1],
    ]);
  });

  it('cause de la saison : association de la configuration, montant « à confirmer » puis confirmé par l\'administration', () => {
    const clock = new FakeClock();
    const engine = new GameEngine(new SqliteStore(':memory:'), { ...DEFAULT_RULES, ...RULES, autoStartSeason: false }, {
      now: clock.now,
      donation: { enabled: true, associationName: 'Association Exemple', associationUrl: 'https://exemple.org', note: 'Projet futur.' },
    });
    const s = engine.startSeason();
    expect(() => engine.setDonationAmount(s.id, '100 €')).toThrow(/encore en cours/);
    engine.endSeason('admin');
    expect(engine.seasonArchive(s.id)!.donation).toEqual({ associationName: 'Association Exemple', associationUrl: 'https://exemple.org', note: 'Projet futur.', amountLabel: null });
    expect(engine.setDonationAmount(s.id, ' 500 € ').donation.amountLabel).toBe('500 €');
    expect(engine.setDonationAmount(s.id, null).donation.amountLabel).toBeNull();
    for (const bad of ['', 'x'.repeat(61), '<script>', 42]) expect(() => engine.setDonationAmount(s.id, bad)).toThrow(/invalide/);
    // Sans association configurée : rien d'inventé.
    const { engine: e2 } = makeEngine(RULES);
    const s2 = e2.startSeason();
    e2.endSeason('admin');
    expect(e2.seasonArchive(s2.id)!.donation).toMatchObject({ associationName: null, associationUrl: null, amountLabel: null });
  });

  it('saison close avant les archives : archive construite une fois depuis les résultats enregistrés', () => {
    const { engine, clock, store } = makeEngine({ ...RULES, ...NO_DISCOVERIES, baseHp: 1000 });
    const s = engine.startSeason();
    const a = newPlayer(engine, 'Ada');
    clock.advance(10);
    engine.mine(a, { actionId: aid('l'), layer: 0, block: 0 });
    engine.endSeason('admin');
    const before = engine.seasonArchive(s.id)!;
    (store as unknown as { db: DatabaseSync }).db.prepare('DELETE FROM season_archives').run();
    const rebuilt = engine.seasonArchive(s.id)!;
    expect(rebuilt.champion).toEqual(before.champion);
    expect(store.countArchives(s.id)).toBe(1);
    expect(engine.seasonArchive(s.id)).toEqual(rebuilt);
  });
});

describe('cérémonie : redémarrage', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  it('archives conservées après redémarrage ; dernier bloc enregistré mais clôture non faite : clôturée une seule fois au démarrage', () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const clock = new FakeClock();
    const mk = () => new GameEngine(new SqliteStore(db.path), { ...DEFAULT_RULES, ...RULES, autoStartSeason: false }, { now: clock.now });
    const e1 = mk();
    const s = e1.startSeason();
    const a = newPlayer(e1, 'Ada');
    mineAll(e1, clock, [a]);
    const hall = e1.hall();
    expect(mk().hall()).toEqual(hall);
    // Fenêtre de crash : coup final validé mais clôture absente (simulée en annulant la clôture).
    const s2 = mk().startSeason({ name: 'Saison 2' });
    const e3 = mk();
    mineAll(e3, clock, [a]);
    const raw = new DatabaseSync(db.path);
    raw.prepare("UPDATE seasons SET status = 'active', ended_at = NULL, end_reason = NULL, final_stone_player_id = NULL WHERE id = ?").run(s2.id);
    raw.prepare('DELETE FROM season_archives WHERE season_id = ?').run(s2.id);
    raw.prepare('DELETE FROM season_results WHERE season_id = ?').run(s2.id);
    raw.close();
    clock.advance(60_000);
    const e4 = mk(); // reprise : la saison complète est clôturée au démarrage
    const arc = e4.seasonArchive(s2.id)!;
    expect(arc).toMatchObject({ endReason: 'completed', finalStone: { name: 'Ada' }, closedAt: clock.t });
    expect(e4.store.countArchives(s2.id)).toBe(1);
    expect(mk().seasonArchive(s2.id)).toEqual(arc);
    expect(e4.seasonArchive(s.id)).toEqual(hall[0]);
  });
});

describe('cérémonie : WebSocket et HTTP', () => {
  let server: GameServer | null = null;
  let cleanup: (() => void) | null = null;
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await server?.close();
    server = null;
    cleanup?.();
  });

  it('mêmes résultats pour tous, reconnexion pendant la cérémonie, Hall et don via l\'administration', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DB_PATH: db.path, STATIC_DIR: '/nonexistent', ADMIN_TOKEN: 'jeton-admin-de-test-1234567890' });
    config.rules = { ...config.rules, autoStartSeason: false, ...RULES, baseHp: 1000 };
    server = await startGameServer({ config, manualTick: true });
    const season = server.engine.startSeason();
    const A = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
    const B = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(A, B);
    await A.connect(undefined, 'Alice');
    await B.connect(undefined, 'Bob');
    for (let i = 0; i < 3; i++) await A.mine(0, i);
    const ea = A.waitFor((m) => m.t === 'seasonEnded');
    const eb = B.waitFor((m) => m.t === 'seasonEnded');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/admin/season/end`, { method: 'POST', headers: { authorization: 'Bearer jeton-admin-de-test-1234567890' } });
    expect(res.status).toBe(200);
    const [ma, mb] = (await Promise.all([ea, eb])) as Extract<ServerMessage, { t: 'seasonEnded' }>[];
    expect(ma.archive).toEqual(mb.archive);
    expect(ma.archive).toMatchObject({ endReason: 'admin', champion: { name: 'Alice', hits: 3, rank: 1 } });
    // Reconnexion pendant la cérémonie : même archive, même instant de clôture (synchronisation).
    await B.close();
    const wb = await B.connect();
    expect(wb.ceremony).toEqual(ma.archive);
    // Hall des champions (HTTP), consultable à tout moment.
    const hall = await (await fetch(`http://127.0.0.1:${server.port}/api/hall`)).json();
    expect(hall.seasons).toEqual([ma.archive]);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/hall/${season.id}`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/hall/999`)).status).toBe(404);
    // Confirmation du montant du don par l'administration (seul champ modifiable).
    const auth = { authorization: 'Bearer jeton-admin-de-test-1234567890', 'content-type': 'application/json' };
    const don = await fetch(`http://127.0.0.1:${server.port}/api/admin/season/${season.id}/donation`, { method: 'POST', headers: auth, body: JSON.stringify({ amount: '250 €' }) });
    expect((await don.json()).season.donation.amountLabel).toBe('250 €');
    expect((await fetch(`http://127.0.0.1:${server.port}/api/admin/season/${season.id}/donation`, { method: 'POST', headers: { authorization: 'Bearer faux' }, body: '{}' })).status).toBe(401);
    // Une seconde clôture est refusée.
    const again = await fetch(`http://127.0.0.1:${server.port}/api/admin/season/end`, { method: 'POST', headers: { authorization: 'Bearer jeton-admin-de-test-1234567890' } });
    expect(again.status).toBe(400);
  }, 20_000);
});

describe('brigade championne : règle de qualification de production (5 membres)', () => {
  /** Règles de production pour la qualification : rien n'est abaissé ici. */
  const PROD = { ...RULES, baseHp: 100_000, brigadeMinSize: DEFAULT_RULES.brigadeMinSize };

  function brigade(engine: GameEngine, name: string, size: number) {
    const ids = Array.from({ length: size }, (_, i) => newPlayer(engine, `${name.slice(0, 6)}-${i}`));
    const info = engine.createBrigade(ids[0], name);
    for (const id of ids.slice(1)) engine.joinBrigade(id, info.inviteCode);
    return { ids, id: info.id, code: info.inviteCode };
  }
  function mine(engine: GameEngine, clock: FakeClock, ids: string[], hitsEach: number) {
    for (let i = 0; i < hitsEach; i++) {
      for (const id of ids) {
        clock.advance(5);
        expect(engine.mine(id, { actionId: aid('q'), layer: 0, block: i % 16 }).ok).toBe(true);
      }
    }
  }

  it('production : seuil de 5 membres (configuration par défaut, moteur, .env.example)', () => {
    expect(DEFAULT_RULES.brigadeMinSize).toBe(5);
    expect(loadConfig({}).rules.brigadeMinSize).toBe(5);
  });

  it('brigades de 2 et 4 membres non qualifiées, même avec bien plus de coups ; brigade de 5 qualifiée', () => {
    const { engine, clock } = makeEngine(PROD);
    engine.startSeason();
    const deux = brigade(engine, 'Duo', 2);
    const quatre = brigade(engine, 'Quatuor', 4);
    const cinq = brigade(engine, 'Quintette', 5);
    mine(engine, clock, deux.ids, 30); // 60 coups
    mine(engine, clock, quatre.ids, 20); // 80 coups
    mine(engine, clock, cinq.ids, 2); // 10 coups
    const board = engine.brigadeBoard();
    expect(board.map((b) => [b.name, b.members, b.eligible, b.hits])).toEqual([
      ['Quatuor', 4, false, 80],
      ['Duo', 2, false, 60],
      ['Quintette', 5, true, 10],
    ]);
    expect(engine.brigadeInfo(deux.ids[0])!.minSize).toBe(5);
    engine.endSeason('admin');
    const arc = engine.lastArchive()!;
    expect(arc.championBrigade).toMatchObject({ name: 'Quintette', members: 5, hits: 10 });
    expect(arc.brigadeMinSize).toBe(5);
  });

  it('saison sans brigade qualifiée : aucune brigade championne', () => {
    const { engine, clock } = makeEngine(PROD);
    engine.startSeason();
    const b2 = brigade(engine, 'Duo', 2);
    const b4 = brigade(engine, 'Quatuor', 4);
    mine(engine, clock, [...b2.ids, ...b4.ids], 3);
    engine.endSeason('admin');
    expect(engine.lastArchive()).toMatchObject({ championBrigade: null, brigadeMinSize: 5 });
  });

  it('départ d\'un membre avant la clôture : la brigade retombe à 4 et perd sa qualification', () => {
    const { engine, clock } = makeEngine(PROD);
    engine.startSeason();
    const a = brigade(engine, 'Alpha', 5);
    const b = brigade(engine, 'Beta', 5);
    mine(engine, clock, a.ids, 10); // Alpha en tête
    mine(engine, clock, b.ids, 2);
    engine.leaveBrigade(a.ids[4]); // départ juste avant la clôture
    expect(engine.brigadeBoard().find((x) => x.name === 'Alpha')).toMatchObject({ members: 4, eligible: false });
    engine.endSeason('admin');
    // Les coups d'Alpha restent les siens (objectifs, classement des brigades), mais le titre exige 5 membres À LA CLÔTURE.
    expect(engine.lastArchive()!.championBrigade).toMatchObject({ name: 'Beta', members: 5 });
  });

  it('l\'archive conserve le nombre de membres constaté à la clôture, malgré les départs ultérieurs', () => {
    const { engine, clock } = makeEngine(PROD);
    const s = engine.startSeason();
    const a = brigade(engine, 'Alpha', 6);
    mine(engine, clock, a.ids, 2);
    engine.endSeason('admin');
    for (const id of a.ids.slice(3)) engine.leaveBrigade(id);
    expect(engine.brigadeBoard()[0].members).toBe(3);
    expect(engine.seasonArchive(s.id)!.championBrigade).toMatchObject({ name: 'Alpha', members: 6 });
    expect(engine.hall()[0].championBrigade!.members).toBe(6);
  });
});
