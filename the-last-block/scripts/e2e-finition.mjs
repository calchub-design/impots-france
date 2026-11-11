// Test réel des finitions du monolithe : une couche est terminée sous les yeux du joueur
// (vue monumentale, iPhone 13 émulé) ; la couche retirée doit s'effacer dans le pointillé
// du volume excavé en un peu plus d'une seconde, sans erreur, et jamais avec
// « mouvement réduit ». Captures de la séquence.
//
//   npm run build && node scripts/e2e-finition.mjs [--out ./e2e-output]
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
const WebSocket = require('ws');
if (!existsSync('dist/server/server/index.js')) {
  console.error("Lancez d'abord `npm run build`.");
  process.exit(2);
}
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const OUT = resolve(arg('--out', 'e2e-output'));
mkdirSync(OUT, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'tlb-e2e-finition-'));
const port = await new Promise((r) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const results = [];
const errors = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const SIZE = 6;
const server = await new Promise((ok, ko) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/server/server/index.js'], {
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DB_PATH: join(dir, 'f.sqlite'), CUBE_SIZE: String(SIZE), BLOCK_BASE_HP: '1', BLOCK_HP_PER_LAYER: '0', DISCOVERY_PROFILE: 'none', SEASON_DURATION_HOURS: '48', MAX_ACTIONS_PER_SECOND: '50' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  p.stdout.on('data', (d) => d.toString().includes('serveur prêt') && ok(p));
  p.once('exit', (c) => ko(new Error(`serveur arrêté (${c})`)));
});

/** Robot : détruit les blocs `from`..`to` (exclu) de la couche `layer`, un coup toutes les 40 ms. */
function dig(layer, from, to, name) {
  return new Promise((done, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let b = from;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, name })));
    ws.on('message', (raw) => {
      if (JSON.parse(raw.toString()).t !== 'welcome') return;
      const tick = () => {
        if (b >= to) return setTimeout(() => (ws.close(), done()), 200);
        ws.send(JSON.stringify({ t: 'mine', actionId: `${name}-${layer}-${String(b).padStart(4, '0')}`, layer, block: b }));
        b++;
        setTimeout(tick, 40);
      };
      tick();
    });
    ws.on('error', fail);
  });
}

const browser = await playwright.chromium.launch();
try {
  await new Promise((r) => setTimeout(r, 800));
  await dig(0, 0, SIZE * SIZE, 'Foreuse'); // couche 1 entièrement retirée
  await dig(1, 0, SIZE * SIZE - 1, 'Foreuse'); // couche 2 : il reste un bloc

  const open = async (reducedMotion) => {
    const ctx = await browser.newContext({ ...playwright.devices['iPhone 13'], reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/?rendu=monolithe&profil=finition-${reducedMotion ? 'reduit' : 'normal'}`);
    await page.waitForFunction(() => window.tlb?.state.cube && document.querySelector('#conn-status').dataset.state === 'online', null, { timeout: 15000 });
    await page.evaluate(() => document.querySelector('#overview-btn').click());
    await page.waitForTimeout(1500);
    return { ctx, page };
  };

  // 1. Vue monumentale, couche 2 en cours : le volume excavé (1 couche) est dessiné.
  const A = await open(false);
  const before = await A.page.evaluate(() => ({ layer: window.tlb.state.cube.currentLayer, drop: window.tlb.world.layerDrop }));
  check('avant : couche 2 en cours, aucune animation', before.layer === 1 && before.drop === null, JSON.stringify(before));
  await A.page.screenshot({ path: join(OUT, 'finition-chute-0-avant.png') });

  // 2. Le dernier bloc de la couche 2 tombe (par un autre joueur) : la couche s'efface dans le pointillé.
  const B = await open(true); // second joueur en « mouvement réduit », sur la même couche
  const last = SIZE * SIZE - 1;
  const t0 = Date.now();
  await dig(1, last, last + 1, 'Dernier');
  await A.page.waitForFunction(() => window.tlb.state.cube.currentLayer === 2, null, { timeout: 5000 });
  const started = await A.page.evaluate(() => window.tlb.world.layerDrop);
  check('couche terminée : la dalle retirée s\'anime (vue monumentale)', !!started && started.layer === 1, JSON.stringify(started));
  for (const [ms, name] of [[150, '1-debut'], [550, '2-milieu'], [950, '3-fin']]) {
    const wait = ms - (Date.now() - t0);
    if (wait > 0) await A.page.waitForTimeout(wait);
    await A.page.screenshot({ path: join(OUT, `finition-chute-${name}.png`) });
  }
  await A.page.waitForTimeout(900);
  const ended = await A.page.evaluate(() => ({ drop: window.tlb.world.layerDrop, layer: window.tlb.state.cube.currentLayer }));
  check('animation terminée en moins de 2 s, couche 3 en cours', ended.drop === null && ended.layer === 2, JSON.stringify(ended));
  await A.page.screenshot({ path: join(OUT, 'finition-chute-4-apres.png') });
  const reduced = await B.page.evaluate(() => ({ drop: window.tlb.world.layerDrop, layer: window.tlb.state.cube.currentLayer }));
  check('« mouvement réduit » : aucune animation, état final immédiat', reduced.drop === null && reduced.layer === 2, JSON.stringify(reduced));

  // 3. Rechargement : pas d'animation rejouée pour une couche déjà terminée.
  await A.page.reload();
  await A.page.waitForFunction(() => window.tlb?.state.cube && document.querySelector('#conn-status').dataset.state === 'online', null, { timeout: 15000 });
  await A.page.waitForTimeout(300);
  check('rechargement : aucune animation rejouée', (await A.page.evaluate(() => window.tlb.world.layerDrop)) === null);

  // 4. Vue de minage : parois des puits dessinées sans erreur (contrôle visuel par capture).
  await A.page.evaluate(() => document.querySelector('#recenter').click());
  await A.page.waitForTimeout(900);
  await A.page.screenshot({ path: join(OUT, 'finition-parois-minage.png') });
  check('aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));
  await A.ctx.close();
  await B.ctx.close();
} catch (e) {
  check('déroulé du scénario', false, e.message);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} vérifications réussies. Captures : ${OUT}`);
process.exit(failed.length ? 1 : 0);
