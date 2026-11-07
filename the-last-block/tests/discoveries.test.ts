import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_RULES, loadConfig, type GameRules } from '../server/config.js';
import { SqliteStore } from '../server/db/sqlite.js';
import { GameEngine, type EngineEvent } from '../server/game/engine.js';
import { buildDiscoveryPlan, DISCOVERY_CONTENT, validateDiscoveryContent } from '../server/game/discoveries.js';
import { startGameServer, type GameServer } from '../server/net/gameServer.js';
import { discoveryHint, planDiscoveryLayers, type DiscoveryLog } from '../shared/discoveries.js';
import type { ServerMessage } from '../shared/protocol.js';
import { aid, FakeClock, makeEngine, newPlayer, tempDbPath } from './helpers.js';
import { TestClient } from './wsClient.js';

const TEXTS = DISCOVERY_CONTENT.fragments.map((f) => f.text);
const TITLES = DISCOVERY_CONTENT.fragments.map((f) => f.title);

/** Cube de 6 couches de 6 × 6 blocs à 1 PV : une couche = 36 coups, un fragment par couche. */
const SMALL: Partial<GameRules> = { cubeSize: 6, baseHp: 1, hpPerLayer: 0, maxActionsPerSecond: 100, discoveryProfile: 'standard' };

function events(engine: GameEngine) {
  const list: EngineEvent[] = [];
  engine.on((e) => list.push(e));
  return list;
}

/** Détruit tous les blocs vivants de la couche courante sauf `keep` (le dernier est laissé). */
function mineLayer(engine: GameEngine, clock: FakeClock, players: string[], keep = 0) {
  const cube = engine.cubeSnapshot()!;
  const L = cube.currentLayer;
  const alive = cube.currentHp.map((hp, i) => (hp > 0 ? i : -1)).filter((i) => i >= 0);
  const todo = alive.slice(0, alive.length - keep);
  let k = 0;
  for (const idx of todo) {
    for (let h = cube.currentHp[idx]; h > 0; h--) {
      const r = engine.mine(players[k++ % players.length], { actionId: aid('d'), layer: L, block: idx });
      expect(r.ok).toBe(true);
      clock.advance(20);
    }
  }
  return alive.slice(alive.length - keep);
}

function revealedIds(log: DiscoveryLog | null) {
  return (log?.fragments ?? []).filter((f) => f.revealed).map((f) => f.id);
}

describe('découvertes : plan des couches', () => {
  it('saison standard : repères 10/25/45/65/85 % et dernière couche, strictement croissants', () => {
    const t = [0.1, 0.25, 0.45, 0.65, 0.85, 'last'] as const;
    expect(planDiscoveryLayers([...t], 32)).toEqual({ ok: true, layers: [3, 8, 14, 21, 27, 32] });
    expect(planDiscoveryLayers([...t], 48)).toEqual({ ok: true, layers: [5, 12, 22, 31, 41, 48] });
    expect(planDiscoveryLayers([...t], 6)).toEqual({ ok: true, layers: [1, 2, 3, 4, 5, 6] });
  });

  it('moins de couches que de fragments : configuration refusée (jamais deux fragments sur une couche)', () => {
    const p = planDiscoveryLayers([0.1, 0.25, 0.45, 0.65, 0.85, 'last'], 5);
    expect(p.ok).toBe(false);
    const b = buildDiscoveryPlan('standard', 5);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toMatch(/5 couche/);
  });

  it('repères rapprochés : décalés sans collision, en reculant si nécessaire', () => {
    expect(planDiscoveryLayers([0.1, 0.11, 0.12, 'last'], 10)).toEqual({ ok: true, layers: [1, 2, 3, 10] });
    expect(planDiscoveryLayers([0.9, 0.95, 'last'], 10)).toEqual({ ok: true, layers: [8, 9, 10] });
    for (let n = 6; n <= 64; n++) {
      const p = planDiscoveryLayers([0.1, 0.25, 0.45, 0.65, 0.85, 'last'], n);
      expect(p.ok).toBe(true);
      if (p.ok) {
        for (let i = 1; i < p.layers.length; i++) expect(p.layers[i]).toBeGreaterThan(p.layers[i - 1]);
        expect(p.layers[5]).toBe(n);
      }
    }
  });

  it('profil de démonstration « mini-48h » : quatre fragments répartis sur le cube', () => {
    const p = buildDiscoveryPlan('mini-48h', 8);
    expect(p.ok && p.fragments.map((f) => [f.id, f.layer + 1])).toEqual([
      ['echo', 2],
      ['predecessors', 4],
      ['warning', 6],
      ['final-transmission', 8],
    ]);
    expect(buildDiscoveryPlan('mini-48h', 4).ok).toBe(true);
    expect(buildDiscoveryPlan('mini-48h', 3).ok).toBe(false);
  });

  it('contenu : six fragments dans l\'ordre, textes du cahier des charges, fichier validé', () => {
    expect(DISCOVERY_CONTENT.fragments.map((f) => `${f.code} ${f.title}`)).toEqual([
      "01 L'Écho",
      '02 Les Coordonnées',
      '03 Les Prédécesseurs',
      "04 L'Avertissement",
      '05 La Conscience',
      '06 La Transmission finale',
    ]);
    expect(DISCOVERY_CONTENT.fragments[3].text).toContain("N'OUVREZ PAS LE CŒUR SEULS.");
    expect(DISCOVERY_CONTENT.fragments[5].text).toBe("Transmission complète. Le premier cube n'était qu'un signal.");
    const ok = { fragments: [{ id: 'a', code: '1', title: 'A', text: 'x' }], profiles: { p: { steps: [{ fragment: 'a', at: 'last' }] } } };
    expect(() => validateDiscoveryContent(ok)).not.toThrow();
    expect(() => validateDiscoveryContent({ ...ok, fragments: [...ok.fragments, ok.fragments[0]] })).toThrow(/double/);
    expect(() => validateDiscoveryContent({ ...ok, profiles: { p: { steps: [{ fragment: 'zz', at: 0.5 }] } } })).toThrow(/inconnu/);
    expect(() => validateDiscoveryContent({ ...ok, profiles: { p: { steps: [{ fragment: 'a', at: 1.5 }] } } })).toThrow(/repère/);
    expect(() => validateDiscoveryContent({ ...ok, profiles: { none: { steps: [{ fragment: 'a', at: 'last' }] } } })).toThrow(/réservé/);
    expect(() => validateDiscoveryContent({ ...ok, fragments: [{ id: 'a', code: '1', title: '', text: 'x' }] })).toThrow(/titre/);
  });

  it('DISCOVERY_PROFILE inconnu : le serveur refuse de démarrer', () => {
    expect(() => loadConfig({ DISCOVERY_PROFILE: 'inexistant' })).toThrow(/DISCOVERY_PROFILE/);
    expect(loadConfig({}).rules.discoveryProfile).toBe('standard');
    expect(loadConfig({ DISCOVERY_PROFILE: 'mini-48h' }).rules.discoveryProfile).toBe('mini-48h');
  });
});

describe('découvertes : révélation par le moteur', () => {
  it('révélée exactement à la destruction complète de la couche, pas avant', () => {
    const { engine, clock } = makeEngine(SMALL);
    engine.startSeason();
    const ev = events(engine);
    const a = newPlayer(engine, 'Ada');
    const b = newPlayer(engine, 'Bo');
    const [last] = mineLayer(engine, clock, [a, b], 1);
    // 35 blocs sur 36 détruits : aucune révélation, aucun texte envoyé.
    const before = engine.discoveryLog()!;
    expect(revealedIds(before)).toEqual([]);
    expect(ev.filter((e) => e.type === 'discovery')).toHaveLength(0);
    for (const t of [...TEXTS, ...TITLES]) expect(JSON.stringify(before)).not.toContain(t);
    expect(before.fragments.map((f) => f.layer)).toEqual([1, 2, 3, 4, 5, 6]);

    clock.advance(1000);
    const r = engine.mine(b, { actionId: aid('d'), layer: 0, block: last });
    expect(r.ok && r.destroyed).toBe(true);
    const disc = ev.filter((e) => e.type === 'discovery');
    expect(disc).toHaveLength(1);
    expect(disc[0]).toMatchObject({ type: 'discovery', fragment: { id: 'echo', code: '01', layer: 1, revealed: true, title: "L'Écho", revealedAt: clock.t } });
    // L'événement de découverte précède le changement de couche.
    expect(ev.findIndex((e) => e.type === 'discovery')).toBeLessThan(ev.findIndex((e) => e.type === 'layer'));
    const log = engine.discoveryLog()!;
    expect(revealedIds(log)).toEqual(['echo']);
    expect(log.fragments[0].text).toBe(TEXTS[0]);
    // Les fragments suivants restent sans titre ni texte.
    for (const t of [...TEXTS.slice(1), ...TITLES.slice(1)]) expect(JSON.stringify(log)).not.toContain(t);
  });

  it('indices : « Anomalie détectée » à 80 %, « Signal presque accessible » à 95 %, rien sans fragment', () => {
    const log = { seasonStatus: 'active' as const, fragments: [{ id: 'x', order: 1, code: '01', layer: 3, revealed: false }] };
    expect(discoveryHint(log, 2, 36 - 28, 36)).toBeNull(); // 77,8 %
    expect(discoveryHint(log, 2, 36 - 29, 36)).toEqual({ level: 'anomaly', layer: 3 }); // 80,6 %
    expect(discoveryHint(log, 2, 36 - 34, 36)).toEqual({ level: 'anomaly', layer: 3 }); // 94,4 %
    expect(discoveryHint(log, 2, 36 - 35, 36)).toEqual({ level: 'near', layer: 3 }); // 97,2 %
    expect(discoveryHint(log, 1, 0, 36)).toBeNull(); // couche sans fragment
    expect(discoveryHint({ ...log, fragments: [{ ...log.fragments[0], revealed: true }] }, 2, 1, 36)).toBeNull();
    expect(discoveryHint({ ...log, seasonStatus: 'ended' }, 2, 1, 36)).toBeNull();
  });

  it('deux joueurs frappent le dernier bloc au même instant : une seule découverte', () => {
    const { engine, clock, store } = makeEngine(SMALL);
    engine.startSeason();
    const ev = events(engine);
    const a = newPlayer(engine, 'Ada');
    const b = newPlayer(engine, 'Bo');
    const [last] = mineLayer(engine, clock, [a, b], 1);
    const r1 = engine.mine(a, { actionId: aid('x'), layer: 0, block: last });
    const r2 = engine.mine(b, { actionId: aid('y'), layer: 0, block: last });
    expect(r1.ok && r1.destroyed).toBe(true);
    expect(r2).toMatchObject({ ok: false });
    expect(ev.filter((e) => e.type === 'discovery')).toHaveLength(1);
    const id = engine.activeSeason!.id;
    expect(store.listDiscoveries(id).filter((d) => d.revealed_at !== null)).toHaveLength(1);
    // La base refuse toute seconde révélation de la même couche.
    expect(store.revealDiscovery(id, 0, clock.t + 5, b)).toBeUndefined();
    expect(store.reconcileDiscoveries(id)).toEqual([]);
  });

  it('aucun avantage pour l\'auteur du dernier bloc : score inchangé, aucun titre', () => {
    const { engine, clock } = makeEngine(SMALL);
    engine.startSeason();
    const a = newPlayer(engine, 'Ada');
    const profileBefore = engine.publicPlayer(a);
    const playBefore = engine.playtime(a).limitMs;
    mineLayer(engine, clock, [a]);
    const me = engine.myStats(a, 0);
    // Exactement un coup et un bloc par coup donné : rien de plus pour la découverte.
    expect(me.hits).toBe(36);
    expect(me.blocks).toBe(36);
    expect(engine.publicPlayer(a)).toEqual(profileBefore);
    expect(engine.playtime(a).limitMs).toBe(playBefore);
    expect(JSON.stringify(engine.discoveryLog())).not.toContain('Ada');
  });

  it('cube terminé : la Transmission finale est révélée avant la clôture, archives consultables ensuite', () => {
    const { engine, clock } = makeEngine(SMALL);
    engine.startSeason();
    const ev = events(engine);
    const a = newPlayer(engine);
    const b = newPlayer(engine);
    for (let l = 0; l < 6; l++) mineLayer(engine, clock, [a, b]);
    const types = ev.filter((e) => e.type === 'discovery' || e.type === 'seasonEnded').map((e) => (e.type === 'discovery' ? e.fragment.id : e.type));
    expect(types).toEqual(['echo', 'coordinates', 'predecessors', 'warning', 'consciousness', 'final-transmission', 'seasonEnded']);
    expect(engine.activeSeason).toBeNull();
    const log = engine.discoveryLog()!;
    expect(log.seasonStatus).toBe('ended');
    expect(log.fragments.every((f) => f.revealed && f.text)).toBe(true);
    expect(log.fragments.map((f) => f.layer)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('fin de saison avant la fin du cube : fragments non découverts verrouillés, textes jamais envoyés', () => {
    const { engine, clock } = makeEngine(SMALL);
    engine.startSeason();
    const a = newPlayer(engine);
    mineLayer(engine, clock, [a]);
    mineLayer(engine, clock, [a]);
    engine.endSeason('timeout');
    const log = engine.discoveryLog()!;
    expect(log.seasonStatus).toBe('ended');
    expect(revealedIds(log)).toEqual(['echo', 'coordinates']);
    for (const f of log.fragments.slice(2)) expect(f).toEqual({ id: f.id, order: f.order, code: f.code, layer: f.layer, revealed: false });
    for (const t of TEXTS.slice(2)) expect(JSON.stringify(log)).not.toContain(t);
  });

  it('nouvelle saison : archives indépendantes, l\'ancienne reste consultable', () => {
    const { engine, clock } = makeEngine(SMALL);
    const s1 = engine.startSeason();
    const a = newPlayer(engine);
    mineLayer(engine, clock, [a]);
    engine.endSeason('admin');
    const s2 = engine.startSeason({ name: 'Saison 2' });
    expect(revealedIds(engine.discoveryLog())).toEqual([]);
    expect(engine.discoveryLog()!.seasonId).toBe(s2.id);
    expect(revealedIds(engine.discoveryLog(s1.id))).toEqual(['echo']);
    mineLayer(engine, clock, [a]);
    expect(revealedIds(engine.discoveryLog())).toEqual(['echo']);
    expect(engine.discoveryLog()!.fragments[0].revealedAt).not.toBe(engine.discoveryLog(s1.id)!.fragments[0].revealedAt);
  });

  it('profil incompatible : création de saison refusée avec explication (configuration ou administration)', () => {
    const { engine } = makeEngine({ ...SMALL, cubeSize: 4 });
    expect(() => engine.startSeason()).toThrow(/Saison non créée.*4 couche.*« none »/);
    expect(engine.activeSeason).toBeNull();
    expect(() => engine.startSeason({ discoveryProfile: 'standard' })).toThrow(/incompatible/);
    expect(() => engine.startSeason({ discoveryProfile: 'inconnu' })).toThrow(/inconnu/);
    // Profil adapté ou saison sans découverte explicite : acceptés.
    engine.startSeason({ discoveryProfile: 'mini-48h' });
    expect(engine.discoveryLog()!.fragments.map((f) => [f.id, f.layer])).toEqual([
      ['echo', 1],
      ['predecessors', 2],
      ['warning', 3],
      ['final-transmission', 4],
    ]);
    engine.endSeason('admin');
    engine.startSeason({ discoveryProfile: 'none' });
    expect(engine.discoveryLog()).toMatchObject({ profile: 'none', fragments: [] });
  });

  it('démarrage automatique refusé : le moteur ne plante pas, l\'erreur est exposée, puis tout repart une fois corrigé', () => {
    const { engine, clock } = makeEngine({ ...SMALL, cubeSize: 4, autoStartSeason: true });
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      expect(() => engine.tick()).not.toThrow();
      clock.advance(1000);
      engine.tick();
    } finally {
      console.error = orig;
    }
    expect(engine.activeSeason).toBeNull();
    expect(engine.seasonStartError).toMatch(/Saison non créée/);
    expect(errors).toHaveLength(1); // journalisée une seule fois
    (engine.rules as { discoveryProfile: string }).discoveryProfile = 'mini-48h';
    engine.tick();
    expect(engine.activeSeason).not.toBeNull();
    expect(engine.seasonStartError).toBeNull();
  });

  it('profil « none » : aucune découverte, aucun signalement', () => {
    const { engine } = makeEngine({ ...SMALL, discoveryProfile: 'none' });
    engine.startSeason();
    expect(engine.discoveryLog()).toMatchObject({ profile: 'none', fragments: [] });
    expect(engine.discoveryLog()!.invalidProfile).toBeUndefined();
  });
});

describe('découvertes : persistance et redémarrage brutal', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  function engineOn(path: string, clock: FakeClock) {
    return new GameEngine(new SqliteStore(path), { ...DEFAULT_RULES, ...SMALL, autoStartSeason: false }, { now: clock.now });
  }

  it('après un redémarrage (sans fermeture propre), les découvertes confirmées sont conservées à l\'identique', () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const clock = new FakeClock();
    const e1 = engineOn(db.path, clock);
    e1.startSeason();
    const a = newPlayer(e1);
    mineLayer(e1, clock, [a]);
    mineLayer(e1, clock, [a]);
    const before = e1.discoveryLog();
    // Nouveau moteur sur le même fichier, l'ancien n'ayant jamais été fermé.
    const e2 = engineOn(db.path, clock);
    expect(e2.discoveryLog()).toEqual(before);
    const e3 = engineOn(db.path, clock);
    expect(e3.discoveryLog()).toEqual(before);
  });

  it('couche détruite mais découverte non marquée (base antérieure, incident) : réconciliée une seule fois au démarrage', () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const clock = new FakeClock();
    const e1 = engineOn(db.path, clock);
    const s = e1.startSeason();
    const a = newPlayer(e1);
    mineLayer(e1, clock, [a]);
    const revealedAt = e1.discoveryLog()!.fragments[0].revealedAt;
    // Simule l'incident : la couche 1 est vide en base, mais le fragment n'est pas marqué.
    const raw = new DatabaseSync(db.path);
    raw.prepare('UPDATE discoveries SET revealed_at = NULL, closing_player_id = NULL WHERE season_id = ?').run(s.id);
    raw.close();
    clock.advance(3_600_000);
    const e2 = engineOn(db.path, clock);
    const log = e2.discoveryLog()!;
    expect(revealedIds(log)).toEqual(['echo']);
    // Date retrouvée : celle du dernier bloc détruit de la couche, pas l'heure du redémarrage.
    expect(log.fragments[0].revealedAt).toBe(revealedAt);
    const e3 = engineOn(db.path, clock);
    expect(e3.discoveryLog()).toEqual(log);
    expect(e3.store.listDiscoveries(s.id).filter((d) => d.revealed_at !== null)).toHaveLength(1);
  });

  it('saison créée avant les découvertes : plan créé au chargement, couches déjà achevées révélées', () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const clock = new FakeClock();
    const e1 = new GameEngine(new SqliteStore(db.path), { ...DEFAULT_RULES, ...SMALL, discoveryProfile: 'none', autoStartSeason: false }, { now: clock.now });
    const s = e1.startSeason();
    const a = newPlayer(e1);
    mineLayer(e1, clock, [a]);
    // Comme une base antérieure : ni profil ni plan.
    const raw = new DatabaseSync(db.path);
    raw.prepare('UPDATE seasons SET discovery_profile = NULL WHERE id = ?').run(s.id);
    raw.close();
    const e2 = engineOn(db.path, clock);
    expect(revealedIds(e2.discoveryLog())).toEqual(['echo']);
    expect(e2.discoveryLog()!.profile).toBe('standard');
  });

  it('le plan est figé au démarrage de la saison : il ne dépend plus de la configuration ensuite', () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const clock = new FakeClock();
    const e1 = engineOn(db.path, clock);
    e1.startSeason();
    const plan = e1.discoveryLog()!.fragments.map((f) => f.layer);
    const e2 = new GameEngine(new SqliteStore(db.path), { ...DEFAULT_RULES, ...SMALL, discoveryProfile: 'mini-48h', autoStartSeason: false }, { now: clock.now });
    expect(e2.discoveryLog()!.fragments.map((f) => f.layer)).toEqual(plan);
    expect(e2.discoveryLog()!.profile).toBe('standard');
  });
});

describe('découvertes : WebSocket (diffusion, reconnexion, nouveau joueur)', () => {
  let server: GameServer | null = null;
  let cleanup: (() => void) | null = null;
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await server?.close();
    server = null;
    cleanup?.();
  });

  async function boot() {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DB_PATH: db.path, STATIC_DIR: '/nonexistent' });
    config.rules = { ...config.rules, autoStartSeason: false, ...SMALL };
    server = await startGameServer({ config, manualTick: true });
    server.engine.startSeason();
  }
  function client() {
    const c = new TestClient(`ws://127.0.0.1:${server!.port}/ws`);
    clients.push(c);
    return c;
  }

  it('configuration incompatible : le serveur démarre quand même et /api/health explique le refus', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DB_PATH: db.path, STATIC_DIR: '/nonexistent', CUBE_SIZE: '4' });
    const orig = console.error;
    console.error = () => {};
    try {
      server = await startGameServer({ config, manualTick: true });
    } finally {
      console.error = orig;
    }
    const health = await (await fetch(`http://127.0.0.1:${server.port}/api/health`)).json();
    expect(health.ok).toBe(true);
    expect(health.seasonStartError).toMatch(/standard.*4 couche/);
    expect(server.engine.activeSeason).toBeNull();
  });

  it('les deux joueurs reçoivent la même découverte ; reconnexion et nouveau joueur retrouvent le même historique', async () => {
    await boot();
    const A = client();
    const B = client();
    const wa = await A.connect(undefined, 'Alice');
    await B.connect(undefined, 'Bob');
    expect(wa.discoveries?.fragments.every((f) => !f.revealed && f.title === undefined && f.text === undefined)).toBe(true);
    for (const t of TEXTS) expect(JSON.stringify(wa)).not.toContain(t);

    // Le navigateur ne peut pas déclencher de découverte : messages forgés ignorés ou refusés.
    A.send({ t: 'discovery', seasonId: 1, fragment: { id: 'echo' } });
    A.send({ t: 'reveal', layer: 0 });
    await A.waitFor((m) => m.t === 'error').catch(() => null);
    expect(revealedIds(server!.engine.discoveryLog())).toEqual([]);

    // Alice détruit toute la couche 1 (36 blocs à 1 PV), au rythme autorisé.
    const gotA = A.waitFor((m) => m.t === 'discovery', 20_000);
    const gotB = B.waitFor((m) => m.t === 'discovery', 20_000);
    for (let i = 0; i < 36; i++) {
      const r = await A.mine(0, i);
      expect(r.ok).toBe(true);
    }
    const [da, db] = (await Promise.all([gotA, gotB])) as Extract<ServerMessage, { t: 'discovery' }>[];
    expect(da.fragment).toEqual(db.fragment);
    expect(da.fragment).toMatchObject({ id: 'echo', revealed: true, title: "L'Écho", text: TEXTS[0], layer: 1 });
    expect(da.discoveries).toEqual(db.discoveries);
    // La couche suivante est annoncée après la découverte.
    const iDisc = B.received.findIndex((m) => m.t === 'discovery');
    const iLayer = B.received.findIndex((m) => m.t === 'layer');
    expect(iDisc).toBeGreaterThanOrEqual(0);
    expect(iLayer).toBeGreaterThan(iDisc);

    // Reconnexion de Bob et arrivée d'un nouveau joueur : même historique, mêmes dates.
    await B.close();
    const wb = await B.connect();
    const C = client();
    const wc = await C.connect(undefined, 'Chloé');
    expect(wb.discoveries).toEqual(da.discoveries);
    expect(wc.discoveries).toEqual(da.discoveries);

    // Archives publiques par HTTP, y compris pour une saison terminée.
    const http = await (await fetch(`http://127.0.0.1:${server!.port}/api/discoveries`)).json();
    expect(http.discoveries).toEqual(da.discoveries);
    const sid = da.discoveries.seasonId;
    server!.engine.endSeason('admin');
    const ended = await (await fetch(`http://127.0.0.1:${server!.port}/api/discoveries?season=${sid}`)).json();
    expect(ended.discoveries.seasonStatus).toBe('ended');
    expect(revealedIds(ended.discoveries)).toEqual(['echo']);
    for (const t of TEXTS.slice(1)) expect(JSON.stringify(ended)).not.toContain(t);
    expect((await fetch(`http://127.0.0.1:${server!.port}/api/discoveries?season=abc`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${server!.port}/api/discoveries?season=999`)).status).toBe(404);
  }, 30_000);
});
