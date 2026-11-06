import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  CLOSE_CODES,
  PROTOCOL_VERSION,
  type BlockDelta,
  type ClientMessage,
  type ServerMessage,
  type WelcomeMessage,
} from '../../shared/protocol.js';
import { createIdentityProviders } from '../auth/providers.js';
import type { AppConfig } from '../config.js';
import { SqliteStore } from '../db/sqlite.js';
import type { GameStore } from '../db/store.js';
import { GameEngine, type EngineEvent } from '../game/engine.js';
import { SlidingWindowLimiter } from '../game/rateLimiter.js';
import { GameError } from '../game/validation.js';
import { createHttpHandler } from './http.js';
import { clientIp } from './ip.js';

export { clientIp };

interface Conn {
  ws: WebSocket;
  playerId: string | null;
  alive: boolean;
  id: number;
  ip: string;
}

const DELTA_FLUSH_MS = 50;
const BOARD_INTERVAL_MS = 1000;
const HEARTBEAT_MS = 30_000;
const HELLO_TIMEOUT_MS = 10_000;
/** Garde-fou anti-flood par connexion (tous messages confondus). */
const CONN_MSG_PER_SEC = 40;
const CONN_FLOOD_STRIKES = 50;
/** Actions « sociales » (profil, brigade, jeton) par compte : 20 par 10 s. */
const SOCIAL_ACTIONS = 20;
const SOCIAL_WINDOW_MS = 10_000;


export interface GameServer {
  http: Server;
  engine: GameEngine;
  store: GameStore;
  port: number;
  close(): Promise<void>;
  stats(): Record<string, unknown>;
}

export interface GameServerOptions {
  config: AppConfig;
  store?: GameStore;
  now?: () => number;
  /** Désactive les minuteries d'arrière-plan (tests). */
  manualTick?: boolean;
}

export async function startGameServer(opts: GameServerOptions): Promise<GameServer> {
  const { config } = opts;
  const store = opts.store ?? new SqliteStore(config.dbPath, { synchronous: config.security.sqliteSynchronous });
  const engine = new GameEngine(store, config.rules, { now: opts.now });
  const providers = createIdentityProviders(config.auth);
  engine.tick();

  const conns = new Set<Conn>();
  const byPlayer = new Map<string, Set<Conn>>();
  const connLimiter = new SlidingWindowLimiter(CONN_MSG_PER_SEC, 1000);
  const socialLimiter = new SlidingWindowLimiter(SOCIAL_ACTIONS, SOCIAL_WINDOW_MS);
  const accountLimiter = new SlidingWindowLimiter(config.security.newAccountsPerIpPerHour, 3600_000);
  const ipConns = new Map<string, number>();
  let seq = 0;
  let pending: BlockDelta[] = [];
  let pendingSeason = 0;
  let boardDirty = true;
  let nextConnId = 1;
  const counters = {
    mineAccepted: 0,
    mineRejected: 0,
    mineDuplicate: 0,
    messages: 0,
    floodKicks: 0,
    connectionsRefused: 0,
    accountsRefused: 0,
    invalidTokens: 0,
    sessionsReplaced: 0,
  };

  const stats = () => ({
    online: byPlayer.size,
    connections: conns.size,
    seq,
    seasonId: engine.activeSeason?.id ?? null,
    destroyedBlocks: engine.destroyedBlocks,
    ...counters,
    memoryMb: Math.round(process.memoryUsage().rss / 1e6),
  });

  const httpServer = createServer(createHttpHandler({ config, engine, stats }));
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 2048,
    verifyClient: (info: { origin: string; req: IncomingMessage }, cb: (ok: boolean, code?: number, message?: string) => void) => {
      if (config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(info.origin)) {
        counters.connectionsRefused++;
        return cb(false, 403, 'Origin not allowed');
      }
      const ip = clientIp(info.req, config.security.trustProxy);
      if ((ipConns.get(ip) ?? 0) >= config.security.maxConnectionsPerIp) {
        counters.connectionsRefused++;
        return cb(false, 429, 'Too many connections');
      }
      cb(true);
    },
  });

  function send(c: Conn, msg: ServerMessage) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  function broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const c of conns) if (c.playerId && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }

  function toPlayer(playerId: string, make: () => ServerMessage) {
    const set = byPlayer.get(playerId);
    if (!set) return;
    const msg = make();
    for (const c of set) send(c, msg);
  }

  function flushDeltas() {
    if (pending.length === 0) return;
    seq++;
    broadcast({ t: 'delta', seq, seasonId: pendingSeason, updates: pending });
    pending = [];
  }

  function flushBoard() {
    if (!boardDirty) return;
    boardDirty = false;
    broadcast({
      t: 'leaderboard',
      leaderboard: engine.leaderboard(),
      brigades: engine.brigadeBoard(),
      online: byPlayer.size,
      destroyedBlocks: engine.destroyedBlocks,
      projection: engine.projection(),
      presence: engine.presence(),
    });
  }

  function welcome(playerId: string, token?: string): WelcomeMessage {
    const season = engine.activeSeason;
    return {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      token,
      player: engine.publicPlayer(playerId),
      season: season ? engine.seasonInfo(season) : null,
      nextSeasonAt: engine.upcomingSeasonAt,
      cube: engine.cubeSnapshot(),
      seq,
      leaderboard: engine.leaderboard(),
      brigades: engine.brigadeBoard(),
      me: engine.myStats(playerId, 0),
      playtime: engine.playtime(playerId),
      brigade: engine.brigadeInfo(playerId),
      online: byPlayer.size,
      serverTime: engine.now(),
      projection: engine.projection(),
      presence: engine.presence(),
      presenceVisible: engine.presenceVisible(playerId),
      discoveries: engine.discoveryLog(),
    };
  }

  function resyncAll() {
    flushDeltas();
    for (const c of conns) if (c.playerId) send(c, welcome(c.playerId));
  }

  engine.on((e: EngineEvent) => {
    switch (e.type) {
      case 'block':
        if (pendingSeason !== e.seasonId) flushDeltas();
        pendingSeason = e.seasonId;
        pending.push([e.layer, e.block, e.hp]);
        boardDirty = true;
        break;
      case 'discovery':
        // Le coup qui achève la couche part d'abord, puis la découverte, à tous.
        flushDeltas();
        broadcast({ t: 'discovery', seasonId: e.seasonId, fragment: e.fragment, discoveries: engine.discoveryLog(e.seasonId)! });
        break;
      case 'layer': {
        flushDeltas();
        seq++;
        const cube = engine.cubeSnapshot();
        if (cube) broadcast({ t: 'layer', seq, seasonId: e.seasonId, cube });
        break;
      }
      case 'seasonEnded':
        flushDeltas();
        broadcast({ t: 'seasonEnded', season: e.season, nextSeasonAt: e.nextSeasonAt });
        // Renvoi d'un état complet (sans cube actif) à tout le monde.
        queueMicrotask(resyncAll);
        break;
      case 'seasonStarted':
        broadcast({ t: 'seasonStarted' });
        queueMicrotask(resyncAll);
        break;
      case 'brigadeChanged':
        boardDirty = true;
        for (const pid of e.playerIds) toPlayer(pid, () => ({ t: 'brigade', brigade: engine.brigadeInfo(pid) }));
        break;
      case 'profileChanged':
        boardDirty = true;
        toPlayer(e.playerId, () => ({ t: 'profile', player: engine.publicPlayer(e.playerId), presenceVisible: engine.presenceVisible(e.playerId) }));
        break;
    }
  });

  function attach(c: Conn, playerId: string) {
    c.playerId = playerId;
    let set = byPlayer.get(playerId);
    if (!set) {
      set = new Set();
      byPlayer.set(playerId, set);
      boardDirty = true;
    }
    // Trop de sessions pour ce compte : on ferme les plus anciennes.
    const max = config.security.maxConnectionsPerAccount;
    if (set.size >= max) {
      const oldest = [...set].sort((a, b) => a.id - b.id).slice(0, set.size - max + 1);
      for (const o of oldest) {
        counters.sessionsReplaced++;
        set.delete(o);
        o.playerId = null;
        o.ws.close(CLOSE_CODES.replaced, 'session replaced');
      }
    }
    set.add(c);
  }

  /** Ferme toutes les sessions d'un compte (sauf `except`). */
  function closePlayer(playerId: string, code: number, reason: string, except?: Conn) {
    for (const o of [...(byPlayer.get(playerId) ?? [])]) {
      if (o === except) continue;
      detach(o);
      o.ws.close(code, reason);
    }
  }

  function detach(c: Conn) {
    if (!conns.delete(c)) return;
    const n = (ipConns.get(c.ip) ?? 1) - 1;
    if (n <= 0) ipConns.delete(c.ip);
    else ipConns.set(c.ip, n);
    if (!c.playerId) return;
    const set = byPlayer.get(c.playerId);
    if (set) {
      set.delete(c);
      if (set.size === 0) {
        byPlayer.delete(c.playerId);
        boardDirty = true;
      }
    }
  }

  function handle(c: Conn, msg: ClientMessage) {
    if (msg.t === 'hello') {
      if (c.playerId) return send(c, { t: 'error', code: 'already_authenticated', message: 'Session déjà ouverte.' });
      if (msg.auth !== undefined) {
        const name = typeof msg.auth === 'object' && msg.auth !== null ? (msg.auth as { provider?: unknown }).provider : undefined;
        const provider = typeof name === 'string' && Object.hasOwn(providers, name) ? providers[name as 'google' | 'apple'] : null;
        if (!provider || !provider.isAvailable()) {
          return send(c, { t: 'error', code: 'auth_unavailable', message: 'Connexion Google/Apple non disponible dans ce prototype. Utilisez un compte invité.' });
        }
      }
      // Reprise : le jeton est la SEULE preuve d'identité acceptée.
      if (msg.token !== undefined && msg.token !== null) {
        const player = engine.resumeGuest(msg.token);
        if (!player) {
          counters.invalidTokens++;
          send(c, { t: 'error', code: 'invalid_token', message: 'Session invalide ou révoquée.' });
          return c.ws.close(CLOSE_CODES.invalidToken, 'invalid token');
        }
        attach(c, player.id);
        return send(c, welcome(player.id));
      }
      // Création : limitée par adresse IP.
      if (accountLimiter.tryTake(c.ip, Date.now()) > 0) {
        counters.accountsRefused++;
        send(c, { t: 'error', code: 'too_many_accounts', message: 'Trop de comptes créés depuis cette adresse. Réessayez plus tard.' });
        return c.ws.close(1008, 'too many accounts');
      }
      const { player, token } = engine.createGuest(msg.name);
      attach(c, player.id);
      return send(c, welcome(player.id, token));
    }

    const playerId = c.playerId;
    if (!playerId) return send(c, { t: 'error', code: 'not_authenticated', message: 'Envoyez hello d\'abord.' });

    if (msg.t !== 'mine' && msg.t !== 'ping' && socialLimiter.tryTake(playerId, Date.now()) > 0) {
      return send(c, { t: 'error', code: 'too_many_requests', message: 'Trop d\'actions, patientez quelques secondes.' });
    }

    switch (msg.t) {
      case 'mine': {
        const r = engine.mine(playerId, msg);
        const actionId = typeof msg.actionId === 'string' ? msg.actionId.slice(0, 64) : '';
        if (r.ok) {
          if (r.duplicate) counters.mineDuplicate++;
          else counters.mineAccepted++;
          return send(c, {
            t: 'mineResult',
            actionId,
            ok: true,
            duplicate: r.duplicate || undefined,
            layer: r.layer,
            block: r.block,
            hpAfter: r.hpAfter,
            destroyed: r.destroyed,
            me: engine.myStats(playerId),
            playtime: engine.playtime(playerId),
          });
        }
        counters.mineRejected++;
        return send(c, {
          t: 'mineResult',
          actionId,
          ok: false,
          reason: r.reason,
          retryAfterMs: r.retryAfterMs,
          playtime: r.reason === 'daily_limit' ? engine.playtime(playerId) : undefined,
        });
      }
      case 'setName':
        engine.setName(playerId, msg.name);
        return;
      case 'setSkin':
        engine.setSkin(playerId, msg.skin);
        return;
      case 'setPresence':
        engine.setPresenceVisible(playerId, msg.visible);
        boardDirty = true;
        return;
      case 'brigadeCreate':
        engine.createBrigade(playerId, msg.name);
        return;
      case 'brigadeJoin':
        engine.joinBrigade(playerId, msg.code);
        return;
      case 'brigadeLeave':
        engine.leaveBrigade(playerId);
        return;
      case 'rotateToken': {
        const token = engine.rotateToken(playerId);
        closePlayer(playerId, CLOSE_CODES.rotated, 'token rotated', c);
        return send(c, { t: 'token', token });
      }
      case 'logout':
        engine.revokeToken(playerId);
        return closePlayer(playerId, CLOSE_CODES.invalidToken, 'logout');
      case 'ping':
        return send(c, { t: 'pong', ts: Number(msg.ts) || 0, serverTime: engine.now() });
      default:
        return send(c, { t: 'error', code: 'unknown_message', message: 'Type de message inconnu.' });
    }
  }

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req, config.security.trustProxy);
    const c: Conn = { ws, playerId: null, alive: true, id: nextConnId++, ip };
    conns.add(c);
    ipConns.set(ip, (ipConns.get(ip) ?? 0) + 1);
    let strikes = 0;
    let lastStrikeAt = 0;
    const helloTimer = setTimeout(() => {
      if (!c.playerId) ws.close(CLOSE_CODES.helloTimeout, 'hello timeout');
    }, HELLO_TIMEOUT_MS);

    ws.on('pong', () => (c.alive = true));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      counters.messages++;
      if (isBinary) return ws.close(1003, 'binary not supported');
      const nowReal = Date.now();
      if (connLimiter.tryTake(String(c.id), nowReal) > 0) {
        // Les avertissements s'effacent après 10 s sans abus.
        if (nowReal - lastStrikeAt > 10_000) strikes = 0;
        lastStrikeAt = nowReal;
        if (++strikes > CONN_FLOOD_STRIKES) {
          counters.floodKicks++;
          ws.close(1008, 'flood');
        } else if (strikes === 1 || strikes % 10 === 0) {
          // Signal (limité) : les messages au-delà du seuil sont ignorés.
          send(c, { t: 'error', code: 'flood', message: 'Trop de messages : certains ont été ignorés.' });
        }
        return;
      }
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
        if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') throw new Error();
      } catch {
        return send(c, { t: 'error', code: 'bad_json', message: 'Message illisible.' });
      }
      try {
        handle(c, msg);
      } catch (err) {
        if (err instanceof GameError) return send(c, { t: 'error', code: err.code, message: err.message });
        console.error('[ws]', err);
        send(c, { t: 'error', code: 'internal_error', message: 'Erreur interne.' });
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      detach(c);
    });
    ws.on('error', () => detach(c));
  });

  const timers: NodeJS.Timeout[] = [];
  if (!opts.manualTick) {
    timers.push(setInterval(flushDeltas, DELTA_FLUSH_MS));
    timers.push(setInterval(flushBoard, BOARD_INTERVAL_MS));
    timers.push(
      setInterval(() => {
        try {
          engine.tick();
        } catch (err) {
          console.error('[tick]', err);
        }
        connLimiter.prune(Date.now());
        socialLimiter.prune(Date.now());
        accountLimiter.prune(Date.now());
      }, 1000),
    );
    timers.push(
      setInterval(() => {
        for (const c of conns) {
          if (!c.alive) {
            c.ws.terminate();
            detach(c);
            continue;
          }
          c.alive = false;
          c.ws.ping();
        }
      }, HEARTBEAT_MS),
    );
  } else {
    // En mode test on garde un flush rapide des deltas mais pas de tick de saison.
    timers.push(setInterval(flushDeltas, DELTA_FLUSH_MS));
    timers.push(setInterval(flushBoard, 200));
  }

  await new Promise<void>((resolveListen) => httpServer.listen(config.port, config.host, resolveListen));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    http: httpServer,
    engine,
    store,
    port,
    stats,
    async close() {
      for (const t of timers) clearInterval(t);
      flushDeltas();
      for (const c of conns) c.ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
      store.close();
    },
  };
}
