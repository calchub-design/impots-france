import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type GameRules } from '../server/config.js';
import { startGameServer, type GameServer } from '../server/net/gameServer.js';
import type { DeltaMessage, LayerMessage, ServerMessage } from '../shared/protocol.js';
import { tempDbPath, NO_DISCOVERIES } from './helpers.js';
import { TestClient } from './wsClient.js';

let server: GameServer | null = null;
let cleanup: (() => void) | null = null;
const clients: TestClient[] = [];

async function boot(rules: Partial<GameRules> = {}, env: Record<string, string> = {}) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DB_PATH: db.path, STATIC_DIR: '/nonexistent', ...env });
  config.rules = { ...config.rules, autoStartSeason: false, ...NO_DISCOVERIES, ...rules };
  server = await startGameServer({ config, manualTick: true });
  server.engine.startSeason();
  return server;
}

function client(): TestClient {
  const c = new TestClient(`ws://127.0.0.1:${server!.port}/ws`);
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await server?.close();
  server = null;
  cleanup?.();
});

describe('WebSocket : vertical slice', () => {
  it('deux joueurs minent le même cube et voient la progression de l\'autre', async () => {
    await boot({ cubeSize: 3, baseHp: 3 });
    const a = client();
    const b = client();
    const wa = await a.connect(undefined, 'Alice');
    const wb = await b.connect(undefined, 'Bob');
    expect(wa.player.id).not.toBe(wb.player.id);
    expect(wa.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(wa.cube).toMatchObject({ size: 3, currentLayer: 0 });

    const deltaSeenByB = b.waitFor<DeltaMessage>((m) => m.t === 'delta' && m.updates.some(([l, i, hp]) => l === 0 && i === 4 && hp === 2));
    const r = await a.mine(0, 4);
    expect(r).toMatchObject({ ok: true, hpAfter: 2, destroyed: false, me: { hits: 1 } });
    await deltaSeenByB;

    const board = await b.waitFor((m) => m.t === 'leaderboard' && m.leaderboard.length > 0);
    if (board.t !== 'leaderboard') throw new Error();
    expect(board.leaderboard[0]).toMatchObject({ name: 'Alice', hits: 1 });
    expect(board.online).toBe(2);
  });

  it('coups simultanés sur le dernier PV : un seul succès', async () => {
    await boot({ cubeSize: 2, baseHp: 1 });
    const a = client();
    const b = client();
    await a.connect();
    await b.connect();
    const [ra, rb] = await Promise.all([a.mine(0, 0), b.mine(0, 0)]);
    const oks = [ra, rb].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect(oks[0].destroyed).toBe(true);
    expect([ra, rb].find((r) => !r.ok)!.reason).toBe('already_destroyed');
  });

  it('rafale concurrente de 6 clients sur un bloc : total des coups = PV du bloc', async () => {
    await boot({ cubeSize: 2, baseHp: 20 });
    const cs = Array.from({ length: 6 }, () => client());
    await Promise.all(cs.map((c) => c.connect()));
    const all = await Promise.all(cs.flatMap((c) => Array.from({ length: 5 }, () => c.mine(0, 0))));
    const ok = all.filter((r) => r.ok);
    expect(ok).toHaveLength(20);
    expect(ok.filter((r) => r.destroyed)).toHaveLength(1);
    expect(all.filter((r) => !r.ok).every((r) => r.reason === 'already_destroyed')).toBe(true);
    expect(server!.engine.cubeSnapshot()!.currentHp[0]).toBe(0);
  });

  it('reconnexion : même compte, état repris, renvoi idempotent', async () => {
    await boot({ cubeSize: 2, baseHp: 5 });
    const a = client();
    const w1 = await a.connect(undefined, 'Alice');
    const actionId = 'reconnect-action-01';
    await a.mine(0, 1, actionId);
    await a.close();

    const w2 = await a.connect(); // réutilise le jeton
    expect(w2.player.id).toBe(w1.player.id);
    expect(w2.token).toBeUndefined();
    expect(w2.cube!.currentHp[1]).toBe(4);
    expect(w2.me.hits).toBe(1);

    const again = await a.mine(0, 1, actionId);
    expect(again).toMatchObject({ ok: true, duplicate: true, hpAfter: 4 });
    expect(server!.engine.cubeSnapshot()!.currentHp[1]).toBe(4);
  });

  it('limite de 5 actions/s appliquée côté serveur sur une rafale', async () => {
    await boot({ cubeSize: 4, baseHp: 1000 });
    const a = client();
    await a.connect();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => a.mine(0, i)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => r.reason === 'rate_limited')).toHaveLength(5);
  });

  it('les limites sont partagées entre deux connexions du même compte', async () => {
    await boot({ cubeSize: 4, baseHp: 1000 });
    const a1 = client();
    await a1.connect();
    const a2 = client();
    await a2.connect(a1.token);
    expect(a2.welcome.player.id).toBe(a1.welcome.player.id);
    const results = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => a1.mine(0, i)),
      ...Array.from({ length: 4 }, (_, i) => a2.mine(0, i + 4)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(5);
  });

  it('changement de couche diffusé avec un nouvel état', async () => {
    await boot({ cubeSize: 2, baseHp: 1, hpPerLayer: 1, maxActionsPerSecond: 100 });
    const a = client();
    const b = client();
    await a.connect();
    await b.connect();
    const layerMsg = b.waitFor<LayerMessage>((m) => m.t === 'layer');
    for (let i = 0; i < 4; i++) await a.mine(0, i);
    const l = await layerMsg;
    expect(l.cube).toMatchObject({ currentLayer: 1, currentHp: [2, 2, 2, 2], layerRemaining: [0, 4] });
    expect(await a.mine(0, 0)).toMatchObject({ ok: false, reason: 'already_destroyed' });
  });

  it('fin de saison diffusée quand la Pierre finale tombe', async () => {
    await boot({ cubeSize: 1, baseHp: 2 });
    const a = client();
    const b = client();
    await a.connect(undefined, 'Alice');
    await b.connect(undefined, 'Bob');
    const ended = b.waitFor((m) => m.t === 'seasonEnded');
    const resyncA = a.waitFor((m) => m.t === 'welcome');
    await a.mine(0, 0);
    await b.mine(0, 0);
    const e = (await ended) as Extract<ServerMessage, { t: 'seasonEnded' }>;
    expect(e.season).toMatchObject({ endReason: 'completed', finalStoneName: 'Bob' });
    expect(['Alice', 'Bob']).toContain(e.season.championName);
    const resync = await resyncA;
    expect(resync.t === 'welcome' && resync.cube).toBeNull();
  });

  it('robustesse : JSON invalide, message inconnu, non authentifié, Google non disponible', async () => {
    await boot();
    const a = client();
    await a.connect();
    a.sendRaw('{pas du json');
    expect(await a.waitFor((m) => m.t === 'error')).toMatchObject({ code: 'bad_json' });
    a.send({ t: 'teleport' });
    expect(await a.waitFor((m) => m.t === 'error' && m.code !== 'bad_json')).toMatchObject({ code: 'unknown_message' });
    // Connexion encore utilisable.
    expect(await a.mine(0, 0)).toMatchObject({ ok: true });

    const b = client();
    const ws = new (await import('ws')).default(`ws://127.0.0.1:${server!.port}/ws`);
    await new Promise((r) => ws.once('open', r));
    const got = new Promise<string>((r) => ws.once('message', (d) => r(d.toString())));
    ws.send(JSON.stringify({ t: 'mine', actionId: 'abcdefgh1', layer: 0, block: 0 }));
    expect(JSON.parse(await got)).toMatchObject({ t: 'error', code: 'not_authenticated' });
    const got2 = new Promise<string>((r) => ws.once('message', (d) => r(d.toString())));
    ws.send(JSON.stringify({ t: 'hello', v: 1, auth: { provider: 'google', idToken: 'forged' } }));
    expect(JSON.parse(await got2)).toMatchObject({ t: 'error', code: 'auth_unavailable' });
    ws.close();
    void b;
  });

  it('brigades via WebSocket : les membres reçoivent la mise à jour', async () => {
    await boot();
    const a = client();
    const b = client();
    await a.connect(undefined, 'Chef');
    await b.connect(undefined, 'Recrue');
    a.send({ t: 'brigadeCreate', name: 'Les Sapeurs' });
    const created = await a.waitFor((m) => m.t === 'brigade' && m.brigade !== null);
    if (created.t !== 'brigade' || !created.brigade) throw new Error();
    const aSeesJoin = a.waitFor((m) => m.t === 'brigade' && (m.brigade?.members.length ?? 0) === 2);
    b.send({ t: 'brigadeJoin', code: created.brigade.inviteCode });
    const joined = await b.waitFor((m) => m.t === 'brigade' && m.brigade !== null);
    expect(joined.t === 'brigade' && joined.brigade!.name).toBe('Les Sapeurs');
    await aSeesJoin;
  });
});

describe('API HTTP', () => {
  it('expose config, saisons et protège l\'administration', async () => {
    const s = await boot({}, { ADMIN_TOKEN: 'secret-admin-token' });
    const base = `http://127.0.0.1:${s.port}`;
    const cfg = await (await fetch(`${base}/api/config`)).json();
    expect(cfg.rules.maxActionsPerSecond).toBe(5);
    expect(cfg.auth).toEqual({ guest: true, google: false, apple: false });
    expect(cfg.skins.every((k: { price: unknown }) => k.price === null)).toBe(true);
    expect(cfg.donation.enabled).toBe(false);

    const seasons = await (await fetch(`${base}/api/seasons`)).json();
    expect(seasons.seasons).toHaveLength(1);

    expect((await fetch(`${base}/api/admin/season/end`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/api/admin/season/end`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await fetch(`${base}/api/admin/season/end`, { method: 'POST', headers: { authorization: 'Bearer secret-admin-token' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).season.endReason).toBe('admin');
    const start = await fetch(`${base}/api/admin/season/start`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Saison spéciale', cubeSize: 4, durationHours: 2 }),
    });
    expect((await start.json()).season).toMatchObject({ name: 'Saison spéciale', cubeSize: 4, status: 'active' });
  });

  it('administration désactivée sans ADMIN_TOKEN', async () => {
    const s = await boot();
    const r = await fetch(`http://127.0.0.1:${s.port}/api/admin/season/end`, { method: 'POST' });
    expect(r.status).toBe(403);
  });
});
