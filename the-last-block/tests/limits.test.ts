import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RULES, loadConfig, type GameRules } from '../server/config.js';
import { SqliteStore } from '../server/db/sqlite.js';
import { GameEngine } from '../server/game/engine.js';
import { activeCredit } from '../server/game/playtime.js';
import { startGameServer, type GameServer } from '../server/net/gameServer.js';
import { aid, FakeClock, makeEngine, newPlayer, tempDbPath } from './helpers.js';
import { TestClient } from './wsClient.js';

const H = 3600_000;

describe('temps actif : modèle « réunion des fenêtres »', () => {
  it('crédit élémentaire', () => {
    const noon = Date.UTC(2026, 0, 15, 12);
    expect(activeCredit(null, noon, 5000)).toBe(5000); // premier coup : une fenêtre
    expect(activeCredit(noon - 300, noon, 5000)).toBe(300); // jeu continu : temps réel
    expect(activeCredit(noon - 60_000, noon, 5000)).toBe(5000); // pause : plafonnée à W
    expect(activeCredit(noon, noon, 5000)).toBe(0); // même milliseconde
    expect(activeCredit(noon + 10, noon, 5000)).toBe(0); // horloge reculée : rien
    const midnight = Date.UTC(2026, 0, 16);
    expect(activeCredit(midnight - 2000, midnight + 1000, 5000)).toBe(1000); // seule la part du nouveau jour
  });

  it('jeu continu : le temps compté suit le temps réel', () => {
    const { engine, clock } = makeEngine({ cubeSize: 4, baseHp: 1e6 });
    engine.startSeason();
    const p = newPlayer(engine);
    for (let i = 0; i < 273; i++) {
      engine.mine(p, { actionId: aid(), layer: 0, block: i % 16 });
      clock.advance(220);
    }
    // 272 intervalles de 220 ms (59,84 s) + la fenêtre du premier coup (5 s).
    expect(engine.playtime(p).usedMs).toBe(272 * 220 + 5000);
  });

  it('l\'inactivité n\'est pas comptée au-delà de la fenêtre de 5 s', () => {
    const { engine, clock } = makeEngine({ cubeSize: 4, baseHp: 1e6 });
    engine.startSeason();
    const p = newPlayer(engine);
    engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
    clock.advance(1000);
    engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
    const before = engine.playtime(p).usedMs;
    clock.advance(45 * 60_000); // 45 min de pause
    engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
    expect(engine.playtime(p).usedMs - before).toBe(5000);
  });

  it('régression : espacer ses coups de 21 s ne contourne plus la limite de 4 h', () => {
    const { engine, clock } = makeEngine({ cubeSize: 4, baseHp: 1e6, seasonDurationMs: 30 * 24 * H });
    engine.startSeason();
    const p = newPlayer(engine);
    clock.t = Date.UTC(2026, 0, 15, 0, 0, 30);
    let accepted = 0;
    let refusal: string | undefined;
    for (let i = 0; i < 4000 && !refusal; i++) {
      const r = engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
      if (r.ok) accepted++;
      else refusal = r.reason;
      clock.advance(21_000);
    }
    // Chaque coup isolé coûte 5 s : 4 h / 5 s = 2 880 coups, puis refus.
    expect(accepted).toBe(2880);
    expect(refusal).toBe('daily_limit');
    expect(engine.playtime(p).usedMs).toBe(4 * H);
  });

  // Rythmes « adversariaux » : avec 5 coups/s et une limite L (s), aucun
  // rythme ne doit permettre plus de 5 × L + 5 coups dans la journée.
  const patterns: Record<string, (i: number) => number> = {
    'rafales de 5 coups simultanés chaque seconde': (i) => (i % 5 === 4 ? 1000 : 0),
    'un coup toutes les 200 ms': () => 200,
    'un coup toutes les 5,01 s': () => 5010,
    'rafales de 5 puis pause de 4,9 s': (i) => (i % 5 === 4 ? 4900 : 0),
    'intervalles pseudo-aléatoires 0–8 s': (i) => Math.floor(((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 8000),
  };
  for (const [label, gap] of Object.entries(patterns)) {
    it(`borne quotidienne respectée : ${label}`, () => {
      const limitS = 600; // limite réduite à 10 min pour la vitesse du test
      const { engine, clock } = makeEngine({ cubeSize: 4, baseHp: 1e6, dailyActiveLimitMs: limitS * 1000, seasonDurationMs: 30 * 24 * H });
      engine.startSeason();
      const p = newPlayer(engine);
      clock.t = Date.UTC(2026, 0, 15, 1);
      const dayEnd = Date.UTC(2026, 0, 16);
      let accepted = 0;
      let limited = false;
      for (let i = 0; clock.t < dayEnd && !limited; i++) {
        const r = engine.mine(p, { actionId: aid(), layer: 0, block: i % 16 });
        if (r.ok) accepted++;
        else if (r.reason === 'daily_limit') limited = true;
        clock.advance(gap(i));
      }
      expect(accepted).toBeLessThanOrEqual(5 * limitS + 5);
      expect(engine.playtime(p).usedMs).toBeLessThanOrEqual(limitS * 1000);
      // Les rythmes rapides atteignent la limite dans la journée.
      expect(limited).toBe(true);
    });
  }

  it('changement de jour : refus à 23:59:59, reprise à minuit UTC', () => {
    const { engine, clock } = makeEngine({ cubeSize: 4, baseHp: 1e6, dailyActiveLimitMs: 60_000, seasonDurationMs: 30 * 24 * H });
    engine.startSeason();
    const p = newPlayer(engine);
    clock.t = Date.UTC(2026, 0, 15, 23, 58, 0);
    while (engine.mine(p, { actionId: aid(), layer: 0, block: 0 }).ok) clock.advance(250);
    clock.t = Date.UTC(2026, 0, 15, 23, 59, 59, 999);
    const refused = engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
    expect(refused).toMatchObject({ ok: false, reason: 'daily_limit', retryAfterMs: 1 });
    clock.t = Date.UTC(2026, 0, 16, 0, 0, 0, 500);
    expect(engine.mine(p, { actionId: aid(), layer: 0, block: 0 }).ok).toBe(true);
    expect(engine.playtime(p).usedMs).toBe(500);
  });

  it('redémarrage : le temps consommé et la limite sont conservés (base persistante)', () => {
    const db = tempDbPath();
    try {
      const clock = new FakeClock(Date.UTC(2026, 0, 15, 10));
      const rules: GameRules = { ...DEFAULT_RULES, autoStartSeason: false, cubeSize: 4, baseHp: 1e6, dailyActiveLimitMs: 60_000 };
      const s1 = new SqliteStore(db.path);
      const e1 = new GameEngine(s1, rules, { now: clock.now });
      e1.startSeason();
      const { player } = e1.createGuest();
      while (e1.mine(player.id, { actionId: aid(), layer: 0, block: 0 }).ok) clock.advance(250);
      s1.close();

      clock.advance(10 * 60_000);
      const s2 = new SqliteStore(db.path);
      const e2 = new GameEngine(s2, rules, { now: clock.now });
      expect(e2.playtime(player.id).usedMs).toBe(60_000);
      expect(e2.mine(player.id, { actionId: aid(), layer: 0, block: 0 })).toMatchObject({ ok: false, reason: 'daily_limit' });
      clock.t = Date.UTC(2026, 0, 16, 8);
      expect(e2.mine(player.id, { actionId: aid(), layer: 0, block: 0 }).ok).toBe(true);
      s2.close();
    } finally {
      db.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Contournements via le réseau (horloge simulée partagée par le serveur)
// ---------------------------------------------------------------------------

describe('limites via WebSocket : reconnexions et sessions multiples', () => {
  let server: GameServer | null = null;
  let cleanup: (() => void) | null = null;
  const clients: TestClient[] = [];
  const clock = new FakeClock();

  async function boot(rules: Partial<GameRules>, dbPath?: string) {
    let path = dbPath;
    if (!path) {
      const db = tempDbPath();
      cleanup = db.cleanup;
      path = db.path;
    }
    const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DB_PATH: path, STATIC_DIR: '/nonexistent' });
    config.rules = { ...config.rules, autoStartSeason: false, cubeSize: 4, baseHp: 1e6, ...rules };
    server = await startGameServer({ config, manualTick: true, now: clock.now });
    if (!server.engine.activeSeason) server.engine.startSeason();
    return { server, path };
  }
  const client = () => {
    const c = new TestClient(`ws://127.0.0.1:${server!.port}/ws`);
    clients.push(c);
    return c;
  };

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await server?.close();
    server = null;
    cleanup?.();
    cleanup = null;
  });

  it('se reconnecter ne remet pas à zéro la limite de 5 coups/s', async () => {
    await boot({});
    const a = client();
    await a.connect();
    for (let i = 0; i < 5; i++) expect((await a.mine(0, i)).ok).toBe(true);
    await a.close();
    const again = client();
    await again.connect(a.token);
    expect(await again.mine(0, 7)).toMatchObject({ ok: false, reason: 'rate_limited' });
    clock.advance(1000);
    expect((await again.mine(0, 7)).ok).toBe(true);
  });

  it('4 sessions simultanées d\'un compte partagent la même limite de 5 coups/s', async () => {
    await boot({});
    const first = client();
    await first.connect();
    const others = [client(), client(), client()];
    for (const o of others) await o.connect(first.token);
    const all = await Promise.all([first, ...others].flatMap((c) => [c.mine(0, 1), c.mine(0, 2), c.mine(0, 3)]));
    expect(all.filter((r) => r.ok)).toHaveLength(5);
    expect(all.filter((r) => r.reason === 'rate_limited')).toHaveLength(7);
  });

  it('limite quotidienne conservée après reconnexion et après redémarrage du serveur', async () => {
    const { path } = await boot({ dailyActiveLimitMs: 30_000 });
    const a = client();
    await a.connect();
    let r;
    // Un coup par seconde simulée (crédit 1 s) : ~26 messages, sous le seuil anti-flood.
    do {
      clock.advance(1000);
      r = await a.mine(0, 0);
    } while (r.ok);
    expect(r.reason).toBe('daily_limit');
    await a.close();

    const b = client();
    const w = await b.connect(a.token);
    expect(w.playtime.usedMs).toBe(30_000);
    expect(await b.mine(0, 0)).toMatchObject({ ok: false, reason: 'daily_limit' });
    await b.close();

    // Redémarrage sur la même base.
    await server!.close();
    await boot({ dailyActiveLimitMs: 30_000 }, path);
    const c = client();
    await c.connect(a.token);
    expect(await c.mine(0, 0)).toMatchObject({ ok: false, reason: 'daily_limit' });
    clock.t = Date.UTC(2026, 0, 16, 9);
    expect((await c.mine(0, 0)).ok).toBe(true);
  });

  it('les champs envoyés par le client (temps, horodatage) sont ignorés', async () => {
    await boot({ dailyActiveLimitMs: 30_000 });
    const a = client();
    await a.connect();
    a.send({ t: 'mine', actionId: 'forged-fields-01', layer: 0, block: 0, playtime: { usedMs: 0 }, at: 0, hits: 999 } as Record<string, unknown>);
    const r = await a.waitFor((m) => m.t === 'mineResult');
    expect(r).toMatchObject({ ok: true, me: { hits: 1 } });
  });
});
