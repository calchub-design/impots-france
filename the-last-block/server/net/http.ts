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

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/api/health') return json(res, 200, { ok: true, time: engine.now() });

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
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        const body = (await readBody(req)) as { name?: unknown; cubeSize?: unknown; durationHours?: unknown; baseHp?: unknown; hpPerLayer?: unknown };
        if (path === '/api/admin/season/start') {
          const s = engine.startSeason({
            name: typeof body.name === 'string' ? body.name.slice(0, 40) : undefined,
            cubeSize: typeof body.cubeSize === 'number' ? body.cubeSize : undefined,
            durationMs: typeof body.durationHours === 'number' ? body.durationHours * 3600_000 : undefined,
            baseHp: typeof body.baseHp === 'number' ? body.baseHp : undefined,
            hpPerLayer: typeof body.hpPerLayer === 'number' ? body.hpPerLayer : undefined,
          });
          return json(res, 200, { season: engine.seasonInfo(s) });
        }
        if (path === '/api/admin/season/end') {
          return json(res, 200, { season: engine.endSeason('admin') });
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
