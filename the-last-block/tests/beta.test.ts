import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkBetaConfig, DEFAULT_RULES, loadConfig, type GameRules } from '../server/config.js';
import { SqliteStore } from '../server/db/sqlite.js';
import { GameEngine, type EngineEvent } from '../server/game/engine.js';
import { BetaStats, csvCell, pseudonymizer } from '../server/game/betaStats.js';
import { generateBetaInviteCode, normalizeBetaInvite } from '../server/auth/invites.js';
import { backupDatabaseFile, checkDatabaseFile, restoreDatabaseFile } from '../server/ops/backup.js';
import { startGameServer, type GameServer } from '../server/net/gameServer.js';
import { CLOSE_CODES } from '../shared/protocol.js';
import { aid, FakeClock, NO_DISCOVERIES, tempDbPath } from './helpers.js';
import { TestClient } from './wsClient.js';

const ADMIN = 'a'.repeat(20) + 'jeton-admin-beta-0123456789';
const SECRET = 's'.repeat(20) + 'secret-pseudonymes-0123456789';
/** Environnement de bêta valide (tous les contrôles passent). */
const BETA_ENV = {
  BETA_MODE: 'true',
  ACCESS_MODE: 'invite',
  ADMIN_TOKEN: ADMIN,
  STATS_PSEUDONYM_SECRET: SECRET,
  DB_PATH: './data/beta-48h.sqlite',
  ALLOWED_ORIGINS: 'https://beta.example.org',
  DISCOVERY_PROFILE: 'mini-48h',
  SEASON_DURATION_HOURS: '48',
  AUTO_START_SEASON: 'false',
  HOST: '127.0.0.1',
  TRUST_PROXY: 'true',
};
const RULES: Partial<GameRules> = { cubeSize: 4, baseHp: 100_000, hpPerLayer: 0, maxActionsPerSecond: 1000, ...NO_DISCOVERIES, autoStartSeason: false };

function inviteEngine(clock = new FakeClock(), path = ':memory:') {
  const store = new SqliteStore(path);
  const engine = new GameEngine(store, { ...DEFAULT_RULES, ...RULES }, { now: clock.now, inviteOnly: true });
  return { engine, store, clock };
}

describe('bêta : configuration', () => {
  it('BETA_MODE refuse de démarrer avec une configuration dangereuse, et liste les erreurs', () => {
    expect(() => loadConfig({ BETA_MODE: 'true' })).toThrow(/ACCESS_MODE[\s\S]*ADMIN_TOKEN[\s\S]*STATS_PSEUDONYM_SECRET[\s\S]*DB_PATH[\s\S]*ALLOWED_ORIGINS[\s\S]*mini-48h/);
    const ok = loadConfig(BETA_ENV);
    expect(ok.beta).toMatchObject({ enabled: true, accessMode: 'invite' });
    expect(checkBetaConfig(ok)).toEqual({ errors: [], warnings: [] });
  });

  it('les limites de production ne peuvent pas être assouplies en bêta', () => {
    for (const [k, v, re] of [
      ['MAX_ACTIONS_PER_SECOND', '10', /MAX_ACTIONS_PER_SECOND/],
      ['DAILY_ACTIVE_LIMIT_MINUTES', '300', /DAILY_ACTIVE_LIMIT_MINUTES/],
      ['BRIGADE_MIN_SIZE', '3', /BRIGADE_MIN_SIZE/],
      ['DISCOVERY_PROFILE', 'standard', /mini-48h/],
      ['ALLOWED_ORIGINS', 'http://beta.example.org', /https/],
      ['DB_PATH', './data/lastblock.sqlite', /DB_PATH/],
      ['STATS_PSEUDONYM_SECRET', ADMIN, /différent/],
      ['ACCESS_MODE', 'open', /invite/],
    ] as const) {
      expect(() => loadConfig({ ...BETA_ENV, [k]: v }), k).toThrow(re);
    }
    expect(() => loadConfig({ ACCESS_MODE: 'public' })).toThrow(/ACCESS_MODE/);
  });

  it('avertissements : saison automatique, écoute sur toutes les interfaces, proxy', () => {
    const c = loadConfig({ ...BETA_ENV, AUTO_START_SEASON: 'true', HOST: '0.0.0.0', TRUST_PROXY: 'false', SEASON_DURATION_HOURS: '72' });
    const w = checkBetaConfig(c).warnings.join('\n');
    expect(w).toMatch(/AUTO_START_SEASON/);
    expect(w).toMatch(/HOST=0.0.0.0/);
    expect(w).toMatch(/TRUST_PROXY/);
    expect(w).toMatch(/48/);
  });

  it('hors bêta : rien ne change (accès ouvert par défaut)', () => {
    expect(loadConfig({}).beta).toMatchObject({ enabled: false, accessMode: 'open' });
  });
});

describe('bêta : invitations', () => {
  it('format lisible, normalisation tolérante, refus des formes invalides', () => {
    const code = generateBetaInviteCode();
    expect(code).toMatch(/^TLB-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const n = normalizeBetaInvite(code)!;
    expect(normalizeBetaInvite(code.toLowerCase())).toBe(n);
    expect(normalizeBetaInvite(` ${code.slice(4).replace('-', ' ')} `)).toBe(n);
    for (const bad of ['', 'TLB-0000-0000', 'TLB-ABCD-EFG', 42, null, 'x'.repeat(50), 'TLB-ABCD-EFGI']) expect(normalizeBetaInvite(bad)).toBeNull();
  });

  it('sans invitation valide, aucun compte n\'est créé ; avec, un seul compte par utilisation', () => {
    const { engine, store } = inviteEngine();
    expect(() => engine.createGuest('Ada')).toThrow(/invitation/);
    expect(() => engine.createGuest('Ada', 'TLB-ZZZZ-ZZZZ')).toThrow(/invalide/);
    expect(store.countPlayers()).toBe(0);
    const [inv] = engine.createInvites({ count: 1, label: 'Brigade A' });
    const { player, token } = engine.createGuest('Ada', inv.code.toLowerCase());
    expect(player.name).toBe('Ada');
    expect(() => engine.createGuest('Bo', inv.code)).toThrow(/déjà utilisé/);
    expect(store.countPlayers()).toBe(1);
    // Le compte existant reprend sans invitation (jeton), avec ses protections inchangées.
    expect(engine.resumeGuest(token)?.id).toBe(player.id);
    expect(engine.listInvites()[0]).toMatchObject({ label: 'Brigade A', uses: 1, maxUses: 1, revoked: false });
  });

  it('plusieurs utilisations, révocation, expiration ; seule l\'empreinte du code est stockée', () => {
    const { engine, store, clock } = inviteEngine();
    const [multi] = engine.createInvites({ label: 'Groupe', maxUses: 3 });
    const [revoked] = engine.createInvites({ label: 'Révoquée' });
    const [expiring] = engine.createInvites({ label: 'Courte', expiresInHours: 1 });
    for (let i = 0; i < 3; i++) engine.createGuest(undefined, multi.code);
    expect(() => engine.createGuest(undefined, multi.code)).toThrow();
    expect(engine.revokeInvite(revoked.id)).toBe(true);
    expect(engine.revokeInvite(revoked.id)).toBe(false);
    expect(() => engine.createGuest(undefined, revoked.code)).toThrow();
    clock.advance(2 * 3600_000);
    expect(() => engine.createGuest(undefined, expiring.code)).toThrow();
    const raw = JSON.stringify(store.query('SELECT * FROM invites'));
    for (const c of [multi, revoked, expiring]) expect(raw).not.toContain(normalizeBetaInvite(c.code)!);
    expect(JSON.stringify(engine.listInvites())).not.toContain(normalizeBetaInvite(multi.code)!);
  });

  it('validation des paramètres de création', () => {
    const { engine } = inviteEngine();
    expect(() => engine.createInvites({ count: 0, label: 'x' })).toThrow(/1 à 100/);
    expect(() => engine.createInvites({ count: 101, label: 'x' })).toThrow(/1 à 100/);
    expect(() => engine.createInvites({ label: '' })).toThrow(/Libellé/);
    expect(() => engine.createInvites({ label: 'x', kind: 'admin' })).toThrow(/Type/);
    expect(() => engine.createInvites({ label: 'x', maxUses: 0 })).toThrow(/Utilisations/);
    expect(() => engine.createInvites({ label: 'x', expiresInHours: -1 })).toThrow(/Expiration/);
    expect(() => engine.revokeInvite('inv_nope')).toThrow(/Identifiant/);
  });

  it('comptes de test (invitation « test ») marqués et exclus des statistiques', () => {
    const { engine, store, clock } = inviteEngine();
    engine.startSeason();
    const [t] = engine.createInvites({ label: 'Smoke test', kind: 'test' });
    const [p] = engine.createInvites({ label: 'Joueurs', maxUses: 2 });
    const robot = engine.createGuest(undefined, t.code).player.id;
    const human = engine.createGuest(undefined, p.code).player.id;
    for (const id of [robot, human]) {
      clock.advance(300);
      expect(engine.mine(id, { actionId: aid('t'), layer: 0, block: 0 }).ok).toBe(true);
    }
    expect(store.query<{ is_test: number }>('SELECT is_test FROM players WHERE id = ?', robot)[0].is_test).toBe(1);
    const sum = new BetaStats(store, SECRET, clock.now, 5).summary();
    expect(sum.participants).toMatchObject({ registered: 1, testAccountsExcluded: 1 });
    expect(sum.season).toMatchObject({ acceptedHits: 1, miners: 1 });
  });
});

describe('bêta : pause d\'urgence', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  it('coups refusés pendant la pause, doublons inchangés, persistance au redémarrage, levée', () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const clock = new FakeClock();
    const mk = () => new GameEngine(new SqliteStore(db.path), { ...DEFAULT_RULES, ...RULES }, { now: clock.now });
    const e1 = mk();
    e1.startSeason();
    const a = e1.connectGuest(undefined, 'Ada').player.id;
    const id = aid('p');
    expect(e1.mine(a, { actionId: id, layer: 0, block: 0 }).ok).toBe(true);
    const ev: EngineEvent[] = [];
    e1.on((e) => ev.push(e));
    e1.setPause('Maintenance de 10 minutes.');
    expect(ev).toContainEqual({ type: 'pause', message: 'Maintenance de 10 minutes.' });
    clock.advance(300);
    expect(e1.mine(a, { actionId: aid('p'), layer: 0, block: 1 })).toEqual({ ok: false, reason: 'paused' });
    expect(e1.mine(a, { actionId: id, layer: 0, block: 0 })).toMatchObject({ ok: true, duplicate: true });
    const e2 = mk();
    expect(e2.pause).toBe('Maintenance de 10 minutes.');
    expect(e2.mine(a, { actionId: aid('p'), layer: 0, block: 1 }).ok).toBe(false);
    expect(() => e2.setPause('<script>')).toThrow();
    expect(() => e2.setPause('')).toThrow();
    e2.setPause(null);
    clock.advance(300);
    expect(e2.mine(a, { actionId: aid('p'), layer: 0, block: 1 }).ok).toBe(true);
    expect(mk().pause).toBeNull();
  });
});

describe('bêta : statistiques', () => {
  it('joueurs actifs par jour, sessions, retour le lendemain et sous 24 h, refus agrégés', () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 10, 9));
    const store = new SqliteStore(':memory:');
    const engine = new GameEngine(store, { ...DEFAULT_RULES, ...RULES, seasonDurationMs: 7 * 24 * 3600_000 }, { now: clock.now });
    engine.startSeason();
    const a = engine.connectGuest(undefined, 'Ada').player.id;
    const b = engine.connectGuest(undefined, 'Bo').player.id;
    const play = (p: string) => {
      const sid = store.startSession(p, clock.t);
      for (let i = 0; i < 5; i++) {
        clock.advance(1000);
        engine.mine(p, { actionId: aid('s'), layer: 0, block: i });
      }
      clock.advance(60_000);
      store.endSession(sid, clock.t);
    };
    play(a); // jour 1, 9 h
    play(b);
    clock.t = Date.UTC(2026, 10, 10, 15); // jour 1, 15 h : Ada revient (6 h plus tard)
    play(a);
    clock.t = Date.UTC(2026, 10, 11, 10); // jour 2 : seule Ada revient
    play(a);
    store.addDailyCounters('2026-11-11', { 'refused:rate_limited': 4, 'refused:daily_limit': 1, duplicate: 2 });
    const stats = new BetaStats(store, SECRET, clock.now, 5);
    const s = stats.summary();
    expect(s.participants.registered).toBe(2);
    expect(s.activePlayersByDay).toEqual([
      { day: '2026-11-10', activePlayers: 2, activeMinutes: expect.any(Number) },
      { day: '2026-11-11', activePlayers: 1, activeMinutes: expect.any(Number) },
    ]);
    expect(s.sessions.count).toBe(4);
    expect(s.sessions.medianMinutes).toBeGreaterThan(0);
    expect(s.retention.nextDay).toEqual({ eligible: 2, returned: 1, ratePct: 50 });
    expect(s.retention.within24h).toMatchObject({ returned: 1 });
    expect(s.hitsCounters).toMatchObject({ refused: 5, duplicates: 2, refusedByReason: { rate_limited: 4, daily_limit: 1 } });
    expect(s.season).toMatchObject({ acceptedHits: 20, miners: 2, cube: { totalBlocks: 64 } });
  });

  it('export CSV pseudonymisé : aucun pseudo, identifiant, jeton ni adresse ; pseudonymes stables', () => {
    const clock = new FakeClock();
    const store = new SqliteStore(':memory:');
    const engine = new GameEngine(store, { ...DEFAULT_RULES, ...RULES }, { now: clock.now });
    engine.startSeason();
    const g = engine.connectGuest(undefined, 'Pseudo-Secret');
    const info = engine.createBrigade(g.player.id, 'Brigade-Secrète');
    store.startSession(g.player.id, clock.t);
    clock.advance(500);
    engine.mine(g.player.id, { actionId: aid('x'), layer: 0, block: 0 });
    const stats = new BetaStats(store, SECRET, clock.now, 5);
    for (const t of ['players', 'sessions', 'daily', 'cube', 'brigades']) {
      const csv = stats.exportCsv(t);
      expect(csv.split('\n')[0].length).toBeGreaterThan(5);
      for (const secret of ['Pseudo-Secret', 'Brigade-Secrète', g.player.id, info.id, g.token!, info.inviteCode]) expect(csv, `${t}`).not.toContain(secret);
    }
    const p = pseudonymizer(SECRET);
    expect(stats.exportCsv('players')).toContain(p('J', g.player.id));
    expect(p('J', g.player.id)).toBe(pseudonymizer(SECRET)('J', g.player.id));
    expect(p('J', g.player.id)).not.toBe(pseudonymizer(`${SECRET}x`)('J', g.player.id));
    expect(() => stats.exportCsv('players; DROP TABLE')).toThrow();
  });

  it('cellules CSV : guillemets et neutralisation des formules', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(-2)).toBe('-2');
    expect(csvCell(null)).toBe('');
  });
});

describe('bêta : sauvegarde et restauration', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  it('sauvegarde à chaud cohérente pendant l\'écriture, restauration qui conserve l\'ancienne base', () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const dir = join(db.path, '..', 'sauvegardes');
    const clock = new FakeClock();
    const engine = new GameEngine(new SqliteStore(db.path), { ...DEFAULT_RULES, ...RULES }, { now: clock.now });
    engine.startSeason();
    const a = engine.connectGuest(undefined, 'Ada').player.id;
    for (let i = 0; i < 10; i++) {
      clock.advance(300);
      engine.mine(a, { actionId: aid('b'), layer: 0, block: i });
    }
    const b = backupDatabaseFile(db.path, dir, clock.t);
    expect(b.check).toMatchObject({ ok: true, integrity: 'ok', hits: 10, players: 1, seasons: 1 });
    for (let i = 0; i < 5; i++) {
      clock.advance(300);
      engine.mine(a, { actionId: aid('b'), layer: 0, block: i });
    }
    expect(() => backupDatabaseFile(db.path, dir, clock.t - 1500)).toThrow(/existe déjà/);
    engine.store.close();
    const r = restoreDatabaseFile(b.path, db.path, clock.t);
    expect(r.check.hits).toBe(10);
    expect(r.previous.length).toBeGreaterThanOrEqual(1);
    expect(checkDatabaseFile(r.previous[0]).hits).toBe(15);
    // Une sauvegarde abîmée est refusée, la base en place n'est pas touchée.
    const bad = join(dir, 'abimee.sqlite');
    writeFileSync(bad, 'pas une base');
    expect(() => restoreDatabaseFile(bad, db.path)).toThrow();
    expect(checkDatabaseFile(db.path).hits).toBe(10);
  });
});

describe('bêta : serveur en mode invitation (WebSocket et HTTP)', () => {
  let server: GameServer | null = null;
  let cleanup: (() => void) | null = null;
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await server?.close();
    server = null;
    cleanup?.();
  });

  it('création sur invitation seulement, essais limités, reprise par jeton, API protégées, administration', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const config = loadConfig({ ...BETA_ENV, PORT: '0', DB_PATH: db.path, STATIC_DIR: '/nonexistent', BACKUP_DIR: join(db.path, '..', 'sauvegardes') });
    config.allowedOrigins = []; // le client de test n'envoie pas d'en-tête Origin
    config.rules = { ...config.rules, ...RULES, discoveryProfile: 'mini-48h' };
    server = await startGameServer({ config, manualTick: true });
    const base = `http://127.0.0.1:${server.port}`;
    const admin = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
      fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await admin('/api/admin/status')).status).toBe(200);
    expect((await fetch(`${base}/api/admin/status`)).status).toBe(401);
    await admin('/api/admin/season/start', { name: 'Bêta 48 h', cubeSize: 4, durationHours: 48 });

    // Sans invitation : refus explicite, fermeture 4004 (pas de reconnexion automatique).
    const intrus = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(intrus);
    await expect(intrus.connect()).rejects.toBeTruthy();
    expect((await intrus.closed).code).toBe(CLOSE_CODES.inviteRequired);
    expect(intrus.received.some((m) => m.t === 'error' && m.code === 'invite_required')).toBe(true);

    // Codes faux : 10 essais par 10 minutes et par IP, puis blocage même avec un bon code.
    const { invites } = await (await admin('/api/admin/invites', { count: 2, label: 'Brigade A' })).json();
    expect(invites).toHaveLength(2);
    expect(JSON.stringify(await (await admin('/api/admin/invites')).json())).not.toContain(invites[0].code);

    const joueur = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(joueur);
    const w = await joueur.connectWith({ invite: invites[0].code, name: 'Alice' });
    expect(w.t).toBe('welcome');
    expect(w.token).toBeTruthy();
    // Reprise par jeton, sans invitation.
    await joueur.close();
    const w2 = await joueur.connect();
    expect(w2.player.id).toBe(w.player.id);

    for (let i = 0; i < 10; i++) {
      const c = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
      clients.push(c);
      await c.connectWith({ invite: 'TLB-ZZZZ-ZZZ2' }).catch(() => null);
    }
    const bloque = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(bloque);
    await expect(bloque.connectWith({ invite: invites[1].code })).rejects.toBeTruthy();
    expect(bloque.received.some((m) => m.t === 'error' && m.code === 'too_many_attempts')).toBe(true);

    // API de lecture : réservées aux participants ; santé et configuration publiques.
    expect((await fetch(`${base}/api/hall`)).status).toBe(401);
    expect((await fetch(`${base}/api/hall`, { headers: { 'x-tlb-token': w.token! } })).status).toBe(200);
    expect((await fetch(`${base}/api/seasons`, { headers: { 'x-tlb-token': 'faux' } })).status).toBe(401);
    expect((await fetch(`${base}/api/stats`)).status).toBe(401);
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ ok: true, db: 'ok' });
    expect((await fetch(`${base}/api/config`)).status).toBe(200);

    // Pause d'urgence : diffusée, présente à la reconnexion, coups refusés.
    const paused = joueur.waitFor((m) => m.t === 'pause' && m.message !== null);
    await admin('/api/admin/pause', { message: 'Maintenance courte.' });
    await paused;
    expect(await joueur.mine(0, 0)).toMatchObject({ ok: false, reason: 'paused' });
    await joueur.close();
    expect((await joueur.connect()).pause).toBe('Maintenance courte.');
    await admin('/api/admin/pause', { message: null });
    expect((await joueur.mine(0, 0)).ok).toBe(true);

    // Statistiques et export (administration).
    server.flushCounters();
    const sum = await (await admin('/api/admin/beta/summary')).json();
    expect(sum.participants.registered).toBe(1);
    expect(sum.hitsCounters.refusedByReason.paused).toBe(1);
    expect(sum.sessions.count).toBeGreaterThanOrEqual(2);
    const csv = await (await admin('/api/admin/beta/export?table=players')).text();
    expect(csv).not.toContain('Alice');
    expect(csv).not.toContain(w.player.id);
    expect((await admin('/api/admin/beta/export?table=inconnue')).status).toBe(400);

    // Sauvegarde à chaud par l'administration.
    const bk = await (await admin('/api/admin/backup', {})).json();
    expect(bk.backup.check).toMatchObject({ ok: true, integrity: 'ok' });
    expect(existsSync(join(db.path, '..', 'sauvegardes', bk.backup.file))).toBe(true);
    expect((await (await admin('/api/admin/status')).json()).lastBackup.file).toBe(bk.backup.file);

    // Clôture : joueurs présents enregistrés.
    const ended = joueur.waitFor((m) => m.t === 'seasonEnded');
    await admin('/api/admin/season/end', {});
    await ended;
    const after = await (await admin('/api/admin/beta/summary')).json();
    expect(after.season.closure).toMatchObject({ connectedPlayers: 1 });
    // Le client ne reçoit jamais les secrets d'administration.
    const all = JSON.stringify(joueur.received);
    expect(all).not.toContain(ADMIN);
    expect(all).not.toContain(SECRET);
  }, 30_000);

  it('aucun secret d\'administration dans le client compilé', () => {
    const dir = 'dist/client/assets';
    if (!existsSync(dir)) return; // client non compilé dans cet environnement
    const files = readdirSync(dir);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text).not.toMatch(/ADMIN_TOKEN|STATS_PSEUDONYM_SECRET|api\/admin/);
    }
  });
});

