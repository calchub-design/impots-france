// Test réel de bout en bout avec DEUX navigateurs Chromium distincts.
//
//   npm run build && npm run e2e [-- --out ./captures]
//
// Nécessite le paquet `playwright` et un Chromium installés (non inclus dans
// les dépendances du projet). Démarre le serveur compilé sur une base
// temporaire, le tue avec SIGKILL en cours de partie puis le relance.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  console.error('Playwright introuvable. Installez-le (npm i -D playwright && npx playwright install chromium) puis relancez.');
  process.exit(2);
}
if (!existsSync('dist/server/server/index.js') || !existsSync('dist/client/index.html')) {
  console.error('Lancez d\'abord `npm run build`.');
  process.exit(2);
}
const outIdx = process.argv.indexOf('--out');
const OUT = resolve(outIdx > 0 ? process.argv[outIdx + 1] : 'e2e-output');
mkdirSync(OUT, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), 'tlb-e2e-'));
const DB = join(dir, 'e2e.sqlite');
const port = await new Promise((r) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const BASE = `http://127.0.0.1:${port}`;
let server;
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
};

function startServer() {
  return new Promise((resolveStart, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/server/server/index.js'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: DB, CUBE_SIZE: '3', BLOCK_BASE_HP: '2', BLOCK_HP_PER_LAYER: '0', SEASON_DURATION_HOURS: '720' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    p.stdout.on('data', (d) => d.toString().includes('serveur prêt') && resolveStart(p));
    p.once('exit', (c) => reject(new Error(`serveur arrêté (${c})`)));
  });
}

const browsers = [];
try {
  server = await startServer();
  // Deux navigateurs distincts : un téléphone et un ordinateur.
  const bMobile = await playwright.chromium.launch();
  const bDesktop = await playwright.chromium.launch();
  browsers.push(bMobile, bDesktop);
  const ctxA = await bMobile.newContext({ ...playwright.devices['iPhone 13'] });
  const ctxB = await bDesktop.newContext({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  const watch = (page, who) => {
    page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
    page.on('console', (m) => {
      const t = m.text();
      // Les échecs de connexion WebSocket pendant l'arrêt volontaire du serveur sont attendus.
      if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(t)) errors.push(`${who}: ${t}`);
    });
  };
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  watch(A, 'mobile');
  watch(B, 'bureau');
  await A.goto(BASE);
  await B.goto(BASE);
  const ready = (p) => p.waitForFunction(() => window.tlb?.state.player && document.querySelector('#conn-status').dataset.state === 'online');
  await Promise.all([ready(A), ready(B)]);
  const idA = await A.evaluate(() => window.tlb.state.player.id);
  const idB = await B.evaluate(() => window.tlb.state.player.id);
  check('deux joueurs distincts connectés au même cube', idA !== idB);

  // Pseudos : unicité visible dans l'interface.
  const rename = async (p, name) => {
    await p.click('[data-tab=profile]');
    await p.fill('#name-input', name);
    await p.click('#name-form button');
  };
  await rename(A, 'Alice');
  await A.waitForFunction(() => window.tlb.state.player.name === 'Alice');
  await rename(B, 'alice');
  await B.waitForSelector('.toast.bad');
  const toast = await B.textContent('.toast.bad');
  check('homonyme refusé côté serveur et signalé', /déjà utilisé/.test(toast), toast.trim());
  await rename(B, 'Bob');
  await B.waitForFunction(() => window.tlb.state.player.name === 'Bob');
  for (const p of [A, B]) await p.click('[data-tab=board]');

  // Alice maintient le bouton Miner 2,5 s ; Bob clique sur le cube.
  const before = Date.now();
  await A.dispatchEvent('#mine-btn', 'pointerdown');
  const box = await B.locator('#scene').boundingBox();
  for (let i = 0; i < 8; i++) {
    await B.mouse.click(box.x + box.width * (0.42 + (i % 3) * 0.08), box.y + box.height * 0.62);
    await B.waitForTimeout(250);
  }
  await A.waitForTimeout(Math.max(0, 2500 - (Date.now() - before)));
  await A.dispatchEvent('#mine-btn', 'pointerup');
  await A.waitForTimeout(1500);
  const snap = (p) => p.evaluate(() => ({ hp: window.tlb.state.cube.currentHp.join(','), layer: window.tlb.state.cube.currentLayer, me: window.tlb.state.me, board: window.tlb.state.leaderboard.map((e) => `${e.name}:${e.hits}`).join('|') }));
  let sa = await snap(A);
  let sb = await snap(B);
  check('même état du cube dans les deux navigateurs', sa.hp === sb.hp && sa.layer === sb.layer, `couche ${sa.layer + 1}`);
  check('même classement dans les deux navigateurs', sa.board === sb.board, sa.board);
  check('maintien du bouton : débit sous 5 coups/s', sa.me.hits > 0 && sa.me.hits <= 5 * 2.5 + 5, `${sa.me.hits} coups en ~2,5 s`);
  check('clics sur le cube (aimantation) comptés', sb.me.hits > 0, `${sb.me.hits} coups`);
  await A.screenshot({ path: join(OUT, 'mobile-partie.png') });
  await B.screenshot({ path: join(OUT, 'bureau-partie.png') });

  // Brigade par code d'invitation.
  await A.click('[data-tab=brigade]');
  await A.fill('#brigade-create input', 'Les Foreurs');
  await A.click('#brigade-create button');
  await A.waitForSelector('#brigade-mine:not(.hidden)');
  const code = (await A.textContent('#brigade-code')).trim();
  await B.click('[data-tab=brigade]');
  await B.fill('#brigade-join input', code);
  await B.click('#brigade-join button');
  await B.waitForSelector('#brigade-mine:not(.hidden)');
  await A.waitForFunction(() => window.tlb.state.brigade?.members.length === 2);
  check('brigade créée et rejointe par code', true, code);

  // Arrêt brutal du serveur puis redémarrage : les navigateurs se reconnectent seuls.
  const hitsBefore = [sa.me.hits, sb.me.hits];
  server.kill('SIGKILL');
  await new Promise((r) => server.once('exit', r));
  await A.waitForFunction(() => document.querySelector('#conn-status').dataset.state !== 'online');
  server = await startServer();
  await Promise.all([ready(A), ready(B)]);
  sa = await snap(A);
  sb = await snap(B);
  const sameIds = idA === (await A.evaluate(() => window.tlb.state.player.id)) && idB === (await B.evaluate(() => window.tlb.state.player.id));
  check('reconnexion automatique après SIGKILL, mêmes comptes', sameIds);
  check('scores conservés après SIGKILL', sa.me.hits === hitsBefore[0] && sb.me.hits === hitsBefore[1], `${sa.me.hits} / ${sb.me.hits}`);
  check('brigade conservée après SIGKILL', (await B.evaluate(() => window.tlb.state.brigade?.name)) === 'Les Foreurs');

  // Rotation du jeton depuis un onglet : l'autre onglet du même navigateur se reconnecte avec le nouveau jeton.
  const A2 = await ctxA.newPage();
  watch(A2, 'mobile-onglet2');
  await A2.goto(BASE);
  await ready(A2);
  A.once('dialog', (d) => d.accept());
  await A.click('[data-tab=profile]');
  await A.click('#rotate-token');
  await A2.waitForFunction(() => document.querySelector('#conn-status').dataset.state !== 'online', null, { timeout: 5000 }).catch(() => {});
  await ready(A2);
  check('rotation du jeton : l\'autre onglet reprend le même compte', idA === (await A2.evaluate(() => window.tlb.state.player.id)));
  await A2.close();
  for (const p of [A, B]) await p.click('[data-tab=board]');

  // Jusqu'à la Pierre finale : les deux maintiennent le bouton.
  await A.dispatchEvent('#mine-btn', 'pointerdown');
  await B.dispatchEvent('#mine-btn', 'pointerdown');
  await Promise.all([A.waitForSelector('#season-dialog[open]', { timeout: 60_000 }), B.waitForSelector('#season-dialog[open]', { timeout: 60_000 })]);
  await A.dispatchEvent('#mine-btn', 'pointerup');
  await B.dispatchEvent('#mine-btn', 'pointerup');
  const dA = await A.textContent('#season-dialog-body');
  const dB = await B.textContent('#season-dialog-body');
  check('fin de saison affichée dans les deux navigateurs', dA === dB, dA.replace(/\s+/g, ' ').slice(0, 160));
  check('Pierre finale attribuée à un joueur', /Pierre finale : (Alice|Bob)/.test(dA));
  check('achèvement anticipé indiqué', /avant l'échéance/.test(dA));
  await A.screenshot({ path: join(OUT, 'mobile-fin.png') });
  await B.screenshot({ path: join(OUT, 'bureau-fin.png') });
  check('aucune erreur JavaScript ni violation CSP', errors.length === 0, errors.join(' ; '));
} catch (err) {
  console.error(err);
  results.push({ label: 'exception', ok: false });
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  server?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} vérifications réussies. Captures : ${OUT}`);
process.exit(failed ? 1 : 0);
