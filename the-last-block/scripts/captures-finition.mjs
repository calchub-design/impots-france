// Captures de contrôle visuel (finition) : cubes de 4, 12 et 40 couches, iPhone 13 et
// ordinateur, vue de minage, vue du panneau et vue monumentale. Trois mineurs nommés
// (robots WebSocket) remplissent le classement ; aucune vérification, seulement des images.
//
//   npm run build && node scripts/captures-finition.mjs [--rendu monolithe|classique] [--out ./e2e-output/finition] [--prefixe avant]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const playwright = require('playwright');
const WebSocket = require('ws');
if (!existsSync('dist/server/server/index.js')) {
  console.error("Lancez d'abord `npm run build`.");
  process.exit(2);
}
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const RENDU = arg('--rendu', 'monolithe');
const OUT = resolve(arg('--out', 'e2e-output/finition'));
const PREFIX = arg('--prefixe', 'capture');
mkdirSync(OUT, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'tlb-captures-'));

const freePort = () =>
  new Promise((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });

async function startServer(size) {
  const port = await freePort();
  const proc = await new Promise((ok, ko) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/server/server/index.js'], {
      env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DB_PATH: join(dir, `c${size}.sqlite`), CUBE_SIZE: String(size), BLOCK_BASE_HP: '3', BLOCK_HP_PER_LAYER: '0', DISCOVERY_PROFILE: 'none', SEASON_DURATION_HOURS: '48', MAX_ACTIONS_PER_SECOND: '50', NEW_ACCOUNTS_PER_IP_PER_HOUR: '1000' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    p.stdout.on('data', (d) => d.toString().includes('serveur prêt') && ok(p));
    p.once('exit', (c) => ko(new Error(`serveur arrêté (${c})`)));
  });
  return { port, proc };
}

/** Robot nommé : crée son compte, frappe `hits` coups, 3 par bloc de la liste (le dernier peut rester abîmé). */
function bot(port, name, hits, blocks) {
  return new Promise((done, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let n = 0;
    let layer = 0;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, name })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'welcome') {
        layer = m.cube?.currentLayer ?? 0;
        const tick = () => {
          if (n >= hits) return setTimeout(() => (ws.close(), done()), 200);
          ws.send(JSON.stringify({ t: 'mine', actionId: `${name}-coup-${String(n).padStart(4, '0')}`, layer, block: blocks[Math.floor(n / 3) % blocks.length] }));
          n++;
          setTimeout(tick, 25);
        };
        tick();
      }
    });
    ws.on('error', fail);
  });
}

const devices = [
  ['iphone', { ...playwright.devices['iPhone 13'] }],
  ['bureau', { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 }],
];
const browser = await playwright.chromium.launch();
try {
  for (const size of [4, 12, 40]) {
    const { port, proc } = await startServer(size);
    await new Promise((r) => setTimeout(r, 800)); // saison démarrée automatiquement
    // Trous et blocs abîmés autour du centre de la face (là où la caméra arrive).
    const c = Math.floor(size / 2);
    const at = (dx, dy) => (c + dy) * size + c + dx;
    await bot(port, 'Yuki', 22, [at(-2, -1), at(-1, -1), at(0, -1), at(1, -1), at(2, -1), at(-2, 1), at(2, 1), at(1, 2)]);
    await bot(port, 'Morgane', 16, [at(-3, 0), at(3, 0), at(-1, 2), at(0, 2), at(-2, -2), at(2, -2)]);
    await bot(port, 'Kofi', 10, [at(-1, -2), at(1, -2), at(0, -3), at(-3, 2)]);
    for (const [dev, opts] of devices) {
      const ctx = await browser.newContext(opts);
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/?rendu=${RENDU}&profil=cap-${dev}`);
      await page.waitForFunction(() => window.tlb?.state.cube && document.querySelector('#conn-status').dataset.state === 'online', null, { timeout: 15000 });
      await page.waitForTimeout(1200);
      const tag = `${PREFIX}-${RENDU}-cube${size}-${dev}`;
      await page.screenshot({ path: join(OUT, `${tag}-minage.png`) });
      await page.evaluate(() => document.querySelector('#board-btn').click());
      await page.waitForTimeout(1300);
      await page.screenshot({ path: join(OUT, `${tag}-panneau.png`) });
      await page.evaluate(() => document.querySelector('#recenter').click());
      await page.waitForTimeout(900);
      if (RENDU === 'monolithe') {
        await page.evaluate(() => document.querySelector('#overview-btn').click());
        await page.waitForTimeout(1400);
        await page.screenshot({ path: join(OUT, `${tag}-monument.png`) });
      }
      await ctx.close();
    }
    proc.kill('SIGTERM');
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Captures dans ${OUT}`);
