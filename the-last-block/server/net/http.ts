import { timingSafeEqual, createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { SKINS } from '../../shared/skins.js';
import type { AppConfig } from '../config.js';
import type { GameEngine } from '../game/engine.js';
import { SlidingWindowLimiter } from '../game/rateLimiter.js';
import { GameError } from '../game/validation.js';
import { clientIp } from './ip.js';
import { BetaStats, EXPORT_TABLES } from '../game/betaStats.js';
import { backupWith } from '../ops/backup.js';

/**
 * Politique de sécurité du contenu de la page servie en production : aucun
 * script ou style inline, pas d'intégration dans un cadre tiers. Limite
 * l'impact d'une éventuelle injection (le jeton invité est en localStorage).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const ADMIN_FAILURES = 10;
const ADMIN_FAILURE_WINDOW_MS = 10 * 60_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

async function readBody(req: IncomingMessage, limit = 4096): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new GameError('payload_too_large', 'Corps de requête trop volumineux.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GameError('invalid_json', 'JSON invalide.');
  }
}

export interface HttpDeps {
  config: AppConfig;
  engine: GameEngine;
  stats: () => Record<string, unknown>;
}

export function createHttpHandler({ config, engine, stats }: HttpDeps) {
  const staticRoot = resolve(config.staticDir);
  const adminFailures = new SlidingWindowLimiter(ADMIN_FAILURES, ADMIN_FAILURE_WINDOW_MS);
  const betaStats = new BetaStats(engine.store, config.beta.pseudonymSecret, engine.now, config.rules.brigadeMinSize);
  const startedAt = Date.now();
  const inviteOnly = config.beta.accessMode === 'invite';
  /**
   * Bêta privée : ces lectures exigent le jeton d'un compte existant (en-tête
   * x-tlb-token). Restent publics : /api/health (supervision) et /api/config
   * (règles affichées avant la connexion). /api/stats devient réservé à l'administration.
   */
  const memberOnly = (p: string) => /^\/api\/(seasons(\/\d+)?|hall(\/\d+)?|discoveries|season\/projection)$/.test(p);

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/api/health') {
        // Contrôle de santé public et minimal : processus vivant et base joignable.
        let db = false;
        try {
          db = engine.store.ping();
        } catch {
          db = false;
        }
        return json(res, db ? 200 : 503, { ok: db, time: engine.now(), db: db ? 'ok' : 'error', ...(engine.seasonStartError ? { seasonStartError: engine.seasonStartError } : {}) });
      }

      if (inviteOnly && memberOnly(path)) {
        const t = req.headers['x-tlb-token'];
        if (typeof t !== 'string' || !engine.resumeGuest(t)) return json(res, 401, { error: 'invite_only', message: 'Bêta privée : réservé aux participants.' });
      }
      if (inviteOnly && path === '/api/stats') return json(res, 401, { error: 'admin_only', message: 'Utilisez /api/admin/status.' });

      if (path === '/api/config' && req.method === 'GET') {
        return json(res, 200, {
          rules: {
            maxActionsPerSecond: engine.rules.maxActionsPerSecond,
            dailyActiveLimitMs: engine.rules.dailyActiveLimitMs,
            idleGapMs: engine.rules.idleGapMs,
            brigadeMinSize: engine.rules.brigadeMinSize,
            brigadeMaxSize: engine.rules.brigadeMaxSize,
          },
          skins: SKINS,
          donation: config.donation,
          auth: { guest: true, google: false, apple: false },
        });
      }

      if (path === '/api/stats' && req.method === 'GET') return json(res, 200, stats());

      if (path === '/api/season/projection' && req.method === 'GET') {
        return json(res, 200, { projection: engine.projection() });
      }

      if (path === '/api/seasons' && req.method === 'GET') {
        return json(res, 200, { seasons: engine.listSeasons(50), nextSeasonAt: engine.upcomingSeasonAt });
      }

      // Archives du cube : saison active (ou dernière terminée), ou ?season=<id>.
      // Les fragments verrouillés n'ont ni titre ni texte.
      if (path === '/api/discoveries' && req.method === 'GET') {
        const raw = url.searchParams.get('season');
        if (raw !== null && !/^\d{1,9}$/.test(raw)) return json(res, 400, { error: 'invalid_season' });
        const log = engine.discoveryLog(raw === null ? undefined : Number(raw));
        return log ? json(res, 200, { discoveries: log }) : json(res, 404, { error: 'not_found' });
      }

      // Hall des champions : archives stables des saisons terminées.
      if (path === '/api/hall' && req.method === 'GET') return json(res, 200, { seasons: engine.hall(50) });
      const ha = /^\/api\/hall\/(\d{1,9})$/.exec(path);
      if (ha && req.method === 'GET') {
        const a = engine.seasonArchive(Number(ha[1]));
        return a ? json(res, 200, { season: a }) : json(res, 404, { error: 'not_found' });
      }

      const m = /^\/api\/seasons\/(\d+)$/.exec(path);
      if (m && req.method === 'GET') {
        const r = engine.seasonResults(Number(m[1]));
        return r ? json(res, 200, r) : json(res, 404, { error: 'not_found' });
      }

      if (path.startsWith('/api/admin/')) {
        if (!config.adminToken) return json(res, 403, { error: 'admin_disabled', message: 'ADMIN_TOKEN non défini.' });
        const ip = clientIp(req, config.security.trustProxy);
        const now = Date.now();
        if (adminFailures.isBlocked(ip, now)) return json(res, 429, { error: 'too_many_attempts' });
        const auth = req.headers.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!token || !safeEqual(token, config.adminToken)) {
          adminFailures.tryTake(ip, now);
          return json(res, 401, { error: 'unauthorized' });
        }
        // --- Lectures d'administration (GET) ---------------------------------
        if (req.method === 'GET') {
          if (path === '/api/admin/status') {
            const season = engine.activeSeason;
            return json(res, 200, {
              uptimeS: Math.round((Date.now() - startedAt) / 1000),
              db: engine.store.ping() ? 'ok' : 'error',
              accessMode: config.beta.accessMode,
              betaMode: config.beta.enabled,
              season: season ? engine.seasonInfo(season) : null,
              projection: engine.projection(),
              pause: engine.pause,
              seasonStartError: engine.seasonStartError,
              lastBackup: engine.store.getMeta('last_backup') ? JSON.parse(engine.store.getMeta('last_backup')!) : null,
              ...stats(),
            });
          }
          if (path === '/api/admin/invites') return json(res, 200, { invites: engine.listInvites() });
          const seasonParam = url.searchParams.get('season');
          if (seasonParam !== null && !/^\d{1,9}$/.test(seasonParam)) return json(res, 400, { error: 'invalid_season' });
          const sid = seasonParam === null ? undefined : Number(seasonParam);
          if (path === '/api/admin/beta/summary') return json(res, 200, betaStats.summary(sid));
          if (path === '/api/admin/beta/export') {
            const table = url.searchParams.get('table') ?? '';
            if (!(EXPORT_TABLES as readonly string[]).includes(table)) return json(res, 400, { error: 'invalid_table', tables: EXPORT_TABLES });
            res.writeHead(200, {
              'content-type': 'text/csv; charset=utf-8',
              'content-disposition': `attachment; filename="beta-${table}.csv"`,
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            });
            return res.end(betaStats.exportCsv(table, sid));
          }
          return json(res, 404, { error: 'not_found' });
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        const body = (await readBody(req)) as { name?: unknown; cubeSize?: unknown; durationHours?: unknown; baseHp?: unknown; hpPerLayer?: unknown; discoveryProfile?: unknown };
        if (path === '/api/admin/season/start') {
          const s = engine.startSeason({
            name: typeof body.name === 'string' ? body.name.slice(0, 40) : undefined,
            cubeSize: typeof body.cubeSize === 'number' ? body.cubeSize : undefined,
            durationMs: typeof body.durationHours === 'number' ? body.durationHours * 3600_000 : undefined,
            baseHp: typeof body.baseHp === 'number' ? body.baseHp : undefined,
            hpPerLayer: typeof body.hpPerLayer === 'number' ? body.hpPerLayer : undefined,
            discoveryProfile: typeof body.discoveryProfile === 'string' ? body.discoveryProfile : undefined,
          });
          return json(res, 200, { season: engine.seasonInfo(s), discoveries: engine.discoveryLog(s.id) });
        }
        const don = /^\/api\/admin\/season\/(\d{1,9})\/donation$/.exec(path);
        if (don) {
          // Confirmation du montant du don de l'éditeur (texte) ; null : « à confirmer ».
          return json(res, 200, { season: engine.setDonationAmount(Number(don[1]), (body as { amount?: unknown }).amount ?? null) });
        }
        if (path === '/api/admin/season/end') {
          return json(res, 200, { season: engine.endSeason('admin') });
        }
        // --- Bêta privée -------------------------------------------------------
        if (path === '/api/admin/invites') {
          // Les codes ne sont renvoyés qu'ici, une seule fois (seule leur empreinte est conservée).
          return json(res, 200, { invites: engine.createInvites(body as Record<string, unknown>) });
        }
        const rev = /^\/api\/admin\/invites\/(inv_[0-9a-f]{12})\/revoke$/.exec(path);
        if (rev) return json(res, 200, { revoked: engine.revokeInvite(rev[1]) });
        if (path === '/api/admin/pause') {
          // Pause d'urgence : { "message": "…" } pour l'activer, { "message": null } pour la lever.
          return json(res, 200, { pause: engine.setPause((body as { message?: unknown }).message ?? null) });
        }
        if (path === '/api/admin/backup') {
          const at = Date.now();
          const b = backupWith((p) => engine.store.backupTo(p), config.beta.backupDir, at);
          const info = { file: b.path.split(/[\\/]/).pop(), bytes: b.bytes, at, check: b.check };
          engine.store.setMeta('last_backup', JSON.stringify(info));
          return json(res, 200, { backup: info });
        }
        return json(res, 404, { error: 'not_found' });
      }

      if (path.startsWith('/api/')) return json(res, 404, { error: 'not_found' });

      // Fichiers statiques du client compilé (production).
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
      let decoded: string;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        return json(res, 400, { error: 'bad_path' });
      }
      if (decoded.includes('\0')) return json(res, 400, { error: 'bad_path' });
      const rel = normalize(decoded).replace(/^([/\\])+/, '');
      let file = join(staticRoot, rel);
      if (!file.startsWith(staticRoot + sep) && file !== staticRoot) return json(res, 400, { error: 'bad_path' });
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(staticRoot, 'index.html');
      if (!existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Client non compilé. Lancez `npm run build` ou utilisez `npm run dev`.');
      }
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...(file.endsWith('.html') ? { 'content-security-policy': CSP, 'x-frame-options': 'DENY' } : {}),
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
    } catch (err) {
      if (err instanceof GameError) return json(res, 400, { error: err.code, message: err.message });
      console.error('[http]', err);
      return json(res, 500, { error: 'internal_error' });
    }
  };
}
