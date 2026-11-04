import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { hashToken } from '../server/auth/guest.js';
import { loadConfig, type GameRules } from '../server/config.js';
import { startGameServer, type GameServer } from '../server/net/gameServer.js';
import { clientIp } from '../server/net/ip.js';
import { CLOSE_CODES, type ServerMessage } from '../shared/protocol.js';
import { tempDbPath } from './helpers.js';
import { TestClient } from './wsClient.js';

let server: GameServer | null = null;
let cleanups: (() => void)[] = [];
const clients: TestClient[] = [];
const raws: WebSocket[] = [];

async function boot(rules: Partial<GameRules> = {}, env: Record<string, string> = {}) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DB_PATH: db.path, STATIC_DIR: '/nonexistent', ...env });
  config.rules = { ...config.rules, autoStartSeason: false, cubeSize: 3, baseHp: 50, ...rules };
  server = await startGameServer({ config, manualTick: true });
  server.engine.startSeason();
  return server;
}

const wsUrl = (query = '') => `ws://127.0.0.1:${server!.port}/ws${query}`;

function client(query = ''): TestClient {
  const c = new TestClient(wsUrl(query));
  clients.push(c);
  return c;
}

/** Connexion brute : renvoie les messages reçus et la fermeture. */
async function raw(query = '') {
  const ws = new WebSocket(wsUrl(query));
  raws.push(ws);
  const msgs: ServerMessage[] = [];
  const waiters: [(m: ServerMessage) => boolean, (m: ServerMessage) => void][] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as ServerMessage;
    msgs.push(m);
    for (const w of [...waiters]) if (w[0](m)) waiters.splice(waiters.indexOf(w), 1) && w[1](m);
  });
  const closed = new Promise<{ code: number }>((r) => ws.once('close', (code) => r({ code })));
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  return {
    ws,
    msgs,
    closed,
    send: (x: unknown) => ws.send(typeof x === 'string' ? x : JSON.stringify(x)),
    next: (pred: (m: ServerMessage) => boolean = () => true, ms = 3000) =>
      new Promise<ServerMessage>((resolve, reject) => {
        const found = msgs.find(pred);
        if (found) {
          msgs.splice(msgs.indexOf(found), 1);
          return resolve(found);
        }
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        waiters.push([pred, (m) => (clearTimeout(t), msgs.splice(msgs.indexOf(m), 1), resolve(m))]);
      }),
  };
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const w of raws.splice(0)) w.terminate();
  await server?.close();
  server = null;
  for (const c of cleanups.splice(0)) c();
});

// ---------------------------------------------------------------------------
// 1. Usurpation d'identité
// ---------------------------------------------------------------------------

describe('identité : impossible d\'usurper un autre compte', () => {
  it('un identifiant de joueur fourni dans hello, l\'URL ou un message est ignoré', async () => {
    await boot();
    const victim = client();
    const vw = await victim.connect(undefined, 'Victime');
    const vid = vw.player.id;

    // Paramètres d'URL et champs supplémentaires dans hello.
    const aw = await (async () => {
      const r = await raw(`?playerId=${vid}`);
      r.send({ t: 'hello', v: 1, playerId: vid, id: vid, player: { id: vid } });
      return (await r.next((m) => m.t === 'welcome')) as Extract<ServerMessage, { t: 'welcome' }> & { _r: typeof r };
    })();
    expect(aw.player.id).not.toBe(vid);
    expect(aw.token).toBeDefined();

    // Un message de minage ou de profil portant l'id de la victime agit sur l'attaquant.
    const atk = client();
    await atk.connect(aw.token);
    atk.send({ t: 'setName', name: 'Pirate', playerId: vid, id: vid });
    await atk.waitFor((m) => m.t === 'profile');
    atk.send({ t: 'mine', actionId: 'spoof-mine-001', layer: 0, block: 0, playerId: vid });
    expect(await atk.waitFor((m) => m.t === 'mineResult')).toMatchObject({ ok: true, me: { hits: 1 } });
    expect(server!.engine.publicPlayer(vid).name).toBe('Victime');
    expect(server!.engine.myStats(vid, 0).hits).toBe(0);
    expect(server!.engine.publicPlayer(aw.player.id).name).toBe('Pirate');
  });

  it('un jeton inconnu est refusé explicitement (aucun compte créé en silence)', async () => {
    await boot();
    const before = server!.store.countPlayers();
    for (const token of ['A'.repeat(43), 'court', 'A'.repeat(44), 42, { $ne: null }, ['x'], 'é'.repeat(43)]) {
      const r = await raw();
      r.send({ t: 'hello', v: 1, token });
      expect(await r.next()).toMatchObject({ t: 'error', code: 'invalid_token' });
      expect((await r.closed).code).toBe(CLOSE_CODES.invalidToken);
    }
    expect(server!.store.countPlayers()).toBe(before);
  });

  it('aucune réponse HTTP ou WebSocket ne divulgue un jeton ou son empreinte', async () => {
    await boot();
    const victim = client();
    await victim.connect(undefined, 'Victime');
    victim.send({ t: 'brigadeCreate', name: 'Coffre Fort' });
    await victim.waitFor((m) => m.t === 'brigade' && m.brigade !== null);
    await victim.mine(0, 0);
    const secret = victim.token!;
    const hash = hashToken(secret);

    const spy = client();
    await spy.connect();
    await new Promise((r) => setTimeout(r, 300)); // reçoit un classement
    const base = `http://127.0.0.1:${server!.port}`;
    const bodies = await Promise.all(['/api/config', '/api/seasons', '/api/seasons/1', '/api/stats', '/api/season/projection'].map(async (p) => (await fetch(base + p)).text()));
    const everything = JSON.stringify(spy.received) + bodies.join('');
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(hash);
    expect(everything).not.toContain('token_hash');
    // Le code d'invitation d'une brigade privée n'est pas exposé aux non-membres.
    const code = server!.engine.brigadeInfo(victim.welcome.player.id)!.inviteCode;
    expect(everything).not.toContain(code);
  });

  it('second hello sur une connexion authentifiée : refusé, identité inchangée', async () => {
    await boot();
    const a = client();
    const b = client();
    await a.connect();
    await b.connect();
    a.send({ t: 'hello', v: 1, token: b.token });
    expect(await a.waitFor((m) => m.t === 'error')).toMatchObject({ code: 'already_authenticated' });
    expect((await a.mine(0, 1)).ok).toBe(true);
    expect(server!.engine.myStats(a.welcome.player.id, 0).hits).toBe(1);
    expect(server!.engine.myStats(b.welcome.player.id, 0).hits).toBe(0);
  });

  it('rotation du jeton : les autres sessions sont fermées et l\'ancien jeton ne vaut plus rien', async () => {
    await boot();
    const phone = client();
    await phone.connect();
    const stolen = phone.token!;
    const thief = client();
    await thief.connect(stolen);
    expect(thief.welcome.player.id).toBe(phone.welcome.player.id);

    phone.send({ t: 'rotateToken' });
    const fresh = await phone.waitFor((m) => m.t === 'token');
    expect((await thief.closed).code).toBe(CLOSE_CODES.rotated);
    if (fresh.t !== 'token') throw new Error();
    expect(fresh.token).not.toBe(stolen);

    const retry = await raw();
    retry.send({ t: 'hello', v: 1, token: stolen });
    expect(await retry.next()).toMatchObject({ code: 'invalid_token' });
    const ok = client();
    expect((await ok.connect(fresh.token)).player.id).toBe(phone.welcome.player.id);
    // La session à l'origine de la rotation reste ouverte.
    expect((await phone.mine(0, 2)).ok).toBe(true);
  });

  it('déconnexion (logout) : jeton révoqué, toutes les sessions fermées', async () => {
    await boot();
    const a = client();
    await a.connect();
    const a2 = client();
    await a2.connect(a.token);
    a.send({ t: 'logout' });
    expect((await a.closed).code).toBe(CLOSE_CODES.invalidToken);
    expect((await a2.closed).code).toBe(CLOSE_CODES.invalidToken);
    const r = await raw();
    r.send({ t: 'hello', v: 1, token: a.token });
    expect(await r.next()).toMatchObject({ code: 'invalid_token' });
  });

  it('au plus 4 sessions par compte : la plus ancienne est fermée', async () => {
    await boot();
    const sessions = [client(), client(), client(), client(), client()];
    await sessions[0].connect();
    for (const s of sessions.slice(1)) await s.connect(sessions[0].token);
    expect((await sessions[0].closed).code).toBe(CLOSE_CODES.replaced);
    expect((await sessions[4].mine(0, 0)).ok).toBe(true);
  });

  it('fournisseurs externes : prototype et noms exotiques refusés proprement', async () => {
    await boot();
    for (const provider of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'google', 'apple', 42, null]) {
      const r = await raw();
      r.send({ t: 'hello', v: 1, auth: { provider, idToken: 'eyJhbGciOiJub25lIn0.e30.' } });
      expect(await r.next()).toMatchObject({ t: 'error', code: 'auth_unavailable' });
    }
    for (const auth of ['google', 1, true, []]) {
      const r = await raw();
      r.send({ t: 'hello', v: 1, auth });
      expect(await r.next()).toMatchObject({ t: 'error', code: 'auth_unavailable' });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Limites par adresse IP
// ---------------------------------------------------------------------------

describe('limites par adresse IP', () => {
  it('création de comptes limitée ; la reprise d\'un compte existant reste possible', async () => {
    await boot({}, { NEW_ACCOUNTS_PER_IP_PER_HOUR: '3' });
    const made: TestClient[] = [];
    for (let i = 0; i < 3; i++) {
      const c = client();
      await c.connect();
      made.push(c);
    }
    const r = await raw();
    r.send({ t: 'hello', v: 1 });
    expect(await r.next()).toMatchObject({ code: 'too_many_accounts' });
    expect((await r.closed).code).toBe(1008);
    await made[0].close();
    const back = client();
    expect((await back.connect(made[0].token)).player.id).toBe(made[0].welcome.player.id);
  });

  it('nombre de connexions simultanées limité', async () => {
    await boot({}, { MAX_CONNECTIONS_PER_IP: '3' });
    const open = [await raw(), await raw(), await raw()];
    const refused = new WebSocket(wsUrl());
    raws.push(refused);
    const status = await new Promise<number>((resolve) => {
      refused.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      refused.on('open', () => resolve(101));
      refused.on('error', () => {});
    });
    expect(status).toBe(429);
    open[0].ws.close();
    await open[0].closed;
    await new Promise((r) => setTimeout(r, 50));
    const again = await raw();
    expect(again.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('X-Forwarded-For n\'est lu que derrière un proxy déclaré de confiance', () => {
    const req = { socket: { remoteAddress: '::ffff:10.0.0.1' }, headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' } } as unknown as IncomingMessage;
    expect(clientIp(req, false)).toBe('10.0.0.1');
    // La dernière valeur est celle ajoutée par notre proxy ; la première est falsifiable.
    expect(clientIp(req, true)).toBe('203.0.113.9');
  });
});

// ---------------------------------------------------------------------------
// 3. Messages malformés
// ---------------------------------------------------------------------------

describe('messages malformés', () => {
  it('chaque message invalide reçoit une erreur, la connexion reste utilisable', async () => {
    await boot();
    const a = client();
    await a.connect();
    const cases: [unknown, string][] = [
      ['pas du json', 'bad_json'],
      ['123', 'bad_json'],
      ['null', 'bad_json'],
      ['[]', 'bad_json'],
      ['"mine"', 'bad_json'],
      ['{}', 'bad_json'],
      [{ t: 5 }, 'bad_json'],
      [{ t: '__proto__' }, 'unknown_message'],
      [{ t: 'constructor' }, 'unknown_message'],
      [{ t: 'setName', name: { toString: 'x' } }, 'invalid_name'],
      [{ t: 'setName', name: 'a'.repeat(500) }, 'invalid_name'],
      [{ t: 'setName', name: 'Admin‮txt' }, 'invalid_name'],
      [{ t: 'setName', name: 'Ali​ce' }, 'invalid_name'],
      [{ t: 'setName', name: '<img src=x onerror=alert(1)>' }, 'invalid_name'],
      [{ t: 'setSkin', skin: 'toString' }, 'invalid_skin'],
      [{ t: 'setSkin', skin: ['classic'] }, 'invalid_skin'],
      [{ t: 'brigadeCreate', name: null }, 'invalid_brigade_name'],
      [{ t: 'brigadeLeave' }, 'not_in_brigade'],
    ];
    for (const [payload, code] of cases) {
      const err = a.waitFor((m) => m.t === 'error');
      if (typeof payload === 'string') a.sendRaw(payload);
      else a.send(payload as object);
      expect(await err, JSON.stringify(payload)).toMatchObject({ code });
    }
    expect((await a.mine(0, 0)).ok).toBe(true);
  });

  it('coups mal formés : tous refusés sans effet', async () => {
    await boot();
    const a = client();
    await a.connect();
    const bad = [
      { actionId: 'short', layer: 0, block: 0 },
      { actionId: 'x'.repeat(65), layer: 0, block: 0 },
      { actionId: 'ünïcødé-actiön', layer: 0, block: 0 },
      { actionId: ['valid-id-123'], layer: 0, block: 0 },
      { actionId: 'valid-id-0001', layer: '0', block: 0 },
      { actionId: 'valid-id-0002', layer: 0, block: 1.5 },
      { actionId: 'valid-id-0003', layer: 0, block: null },
      { actionId: 'valid-id-0004', layer: 0 },
    ];
    for (const b of bad) {
      a.send({ t: 'mine', ...b } as Record<string, unknown>);
      expect(await a.waitFor((m) => m.t === 'mineResult'), JSON.stringify(b)).toMatchObject({ ok: false, reason: 'invalid_action' });
    }
    // JSON 1e999 = Infinity ; indices hors limites.
    a.sendRaw('{"t":"mine","actionId":"valid-id-0005","layer":1e999,"block":0}');
    expect(await a.waitFor((m) => m.t === 'mineResult')).toMatchObject({ ok: false, reason: 'invalid_action' });
    expect(await a.mine(0, 9)).toMatchObject({ ok: false, reason: 'out_of_bounds' });
    expect(await a.mine(0, 2 ** 53)).toMatchObject({ ok: false, reason: 'out_of_bounds' });
    expect(await a.mine(99, 0)).toMatchObject({ ok: false, reason: 'out_of_bounds' });
    expect(server!.engine.cubeSnapshot()!.destroyedBlocks).toBe(0);
    expect(server!.engine.myStats(a.welcome.player.id, 0).hits).toBe(0);
  });

  it('message trop volumineux et trame binaire : connexion fermée', async () => {
    await boot();
    const a = client();
    await a.connect();
    a.send({ t: 'setName', name: 'x'.repeat(5000) });
    expect((await a.closed).code).toBe(1009);
    const b = client();
    await b.connect();
    b.ws.send(Buffer.from([1, 2, 3]));
    expect((await b.closed).code).toBe(1003);
  });

  it('message avant hello : refusé', async () => {
    await boot();
    const r = await raw();
    r.send({ t: 'mine', actionId: 'before-hello-01', layer: 0, block: 0 });
    expect(await r.next()).toMatchObject({ code: 'not_authenticated' });
  });
});

// ---------------------------------------------------------------------------
// 4. Doublons et courses
// ---------------------------------------------------------------------------

describe('doublons et courses concurrentes', () => {
  it('un actionId réutilisé avec d\'autres coordonnées renvoie le coup d\'origine', async () => {
    await boot();
    const a = client();
    await a.connect();
    await a.mine(0, 1, 'reused-action-01');
    const again = await a.mine(0, 5, 'reused-action-01');
    expect(again).toMatchObject({ ok: true, duplicate: true, block: 1 });
    expect(server!.engine.cubeSnapshot()!.currentHp[5]).toBe(50);
  });

  it('même actionId envoyé simultanément sur deux sessions du même compte : appliqué une fois', async () => {
    await boot();
    const a = client();
    await a.connect();
    const a2 = client();
    await a2.connect(a.token);
    const [r1, r2] = await Promise.all([a.mine(0, 0, 'twin-action-0001'), a2.mine(0, 0, 'twin-action-0001')]);
    expect([r1.duplicate ?? false, r2.duplicate ?? false].sort()).toEqual([false, true]);
    expect(server!.engine.cubeSnapshot()!.currentHp[0]).toBe(49);
  });

  it('course pour le dernier bloc : une seule Pierre finale, une seule fin de saison', async () => {
    await boot({ cubeSize: 2, baseHp: 1, hpPerLayer: 0, maxActionsPerSecond: 100 });
    const cs = Array.from({ length: 8 }, () => client());
    await Promise.all(cs.map((c, i) => c.connect(undefined, `Joueur ${i}`)));
    const ends = cs.map((c) => c.waitFor((m) => m.t === 'seasonEnded'));
    // Chaque client tente tous les blocs de chaque couche dans un ordre différent.
    const results = [];
    for (let layer = 0; layer < 2; layer++) {
      results.push(...(await Promise.all(cs.flatMap((c, i) => [0, 1, 2, 3].map((k) => c.mine(layer, (k + i) % 4))))));
      await new Promise((r) => setTimeout(r, 30));
    }
    const destroyed = results.filter((r) => r.ok && r.destroyed);
    expect(destroyed).toHaveLength(8);
    const seasons = await Promise.all(ends);
    const names = new Set(seasons.map((e) => (e.t === 'seasonEnded' ? e.season.finalStoneName : null)));
    expect(names.size).toBe(1);
    expect([...names][0]).toMatch(/^Joueur \d$/);
    expect(server!.store.listSeasons(5).filter((s) => s.status === 'ended')).toHaveLength(1);
    expect(server!.engine.activeSeason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Profils et invitations
// ---------------------------------------------------------------------------

describe('profils et invitations', () => {
  it('pseudos uniques (casse, pleine chasse) : impossible de se faire passer pour un autre sur le panneau', async () => {
    await boot();
    const a = client();
    await a.connect(undefined, 'Alice');
    const b = client();
    const bw = await b.connect(undefined, 'alice'); // demandé à la création : remplacé
    expect(bw.player.name).not.toBe('alice');
    for (const n of ['Alice', 'ALICE', 'Ａｌｉｃｅ', ' alice ']) {
      b.send({ t: 'setName', name: n });
      expect(await b.waitFor((m) => m.t === 'error'), n).toMatchObject({ code: 'name_taken' });
    }
    // Le propriétaire peut changer la casse de son propre pseudo.
    a.send({ t: 'setName', name: 'ALICE' });
    expect(await a.waitFor((m) => m.t === 'profile')).toMatchObject({ player: { name: 'ALICE' } });
  });

  it('actions de profil limitées à 20 par 10 s et par compte', async () => {
    await boot();
    const a = client();
    await a.connect();
    for (let i = 0; i < 25; i++) a.send({ t: 'setSkin', skin: i % 2 ? 'frost' : 'ember' });
    const err = await a.waitFor((m) => m.t === 'error');
    expect(err).toMatchObject({ code: 'too_many_requests' });
    // Le minage n'est pas affecté.
    expect((await a.mine(0, 0)).ok).toBe(true);
  });

  it('invitations invalides : refusées, puis blocage après 10 échecs (recherche exhaustive)', async () => {
    await boot();
    const owner = client();
    await owner.connect();
    owner.send({ t: 'brigadeCreate', name: 'Les Discrets' });
    const created = await owner.waitFor((m) => m.t === 'brigade' && m.brigade !== null);
    const code = created.t === 'brigade' ? created.brigade!.inviteCode : '';

    const guesser = client();
    await guesser.connect();
    const tries: [unknown, string][] = [
      [{}, 'invalid_code'],
      ['ABC', 'invalid_code'],
      ['ABCDEFGHI', 'invalid_code'],
      ['ABCD-EFG', 'invalid_code'],
      ['ZZZZZZZZ', 'invalid_code'],
    ];
    for (const [c, expected] of tries) {
      guesser.send({ t: 'brigadeJoin', code: c } as Record<string, unknown>);
      expect(await guesser.waitFor((m) => m.t === 'error')).toMatchObject({ code: expected });
    }
    for (let i = 0; i < 5; i++) {
      guesser.send({ t: 'brigadeJoin', code: `QQQQQQQ${i + 2}` });
      await guesser.waitFor((m) => m.t === 'error');
    }
    guesser.send({ t: 'brigadeJoin', code });
    expect(await guesser.waitFor((m) => m.t === 'error')).toMatchObject({ code: 'too_many_attempts' });
    expect(server!.engine.brigadeInfo(guesser.welcome.player.id)).toBeNull();

    // Un joueur légitime avec le bon code entre normalement (minuscules acceptées).
    const friend = client();
    await friend.connect();
    friend.send({ t: 'brigadeJoin', code: code.toLowerCase() });
    expect(await friend.waitFor((m) => m.t === 'brigade' && m.brigade !== null)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 6. HTTP
// ---------------------------------------------------------------------------

describe('HTTP', () => {
  it('administration : 10 échecs bloquent l\'adresse, même avec le bon jeton ensuite', async () => {
    const s = await boot({}, { ADMIN_TOKEN: 'correct-horse-battery-staple' });
    const url = `http://127.0.0.1:${s.port}/api/admin/season/end`;
    for (let i = 0; i < 10; i++) expect((await fetch(url, { method: 'POST', headers: { authorization: `Bearer guess-${i}` } })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer correct-horse-battery-staple' } })).status).toBe(429);
  });

  it('page servie avec CSP stricte ; chemins malformés ou traversants refusés', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlb-static-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
    const s = await boot({}, { STATIC_DIR: dir });
    const base = `http://127.0.0.1:${s.port}`;
    const page = await fetch(base + '/');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect((await fetch(base + '/%E0%A4%A')).status).toBe(400);
    expect((await fetch(base + '/a%00b')).status).toBe(400);
    const trav = await fetch(base + '/..%2f..%2f..%2fetc%2fpasswd');
    expect(await trav.text()).not.toContain('root:');
  });
});
