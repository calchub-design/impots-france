// Test réel des missions quotidiennes avec DEUX navigateurs Chromium distincts
// (téléphone tactile émulé + ordinateur), à la cadence de production (5 coups/s).
//
//   npm run build && node scripts/e2e-missions.mjs [--rendu monolithe|classique] [--out ./e2e-output]
//
// Cube de 4 couches de 4 × 4 blocs à 2 PV, saison explicitement sans découverte.
// Les coups passent par l'interface : sélection d'un bloc, puis bouton Miner.
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
  console.error("Lancez d'abord `npm run build`.");
  process.exit(2);
}
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const RENDU = arg('--rendu', 'monolithe');
const OUT = resolve(arg('--out', 'e2e-output'));
const Q = `rendu=${RENDU}`;
mkdirSync(OUT, { recursive: true });
console.log(`Missions — rendu testé : ${RENDU}`);

const dir = mkdtempSync(join(tmpdir(), 'tlb-e2e-missions-'));
const port = await new Promise((r) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const BASE = `http://127.0.0.1:${port}`;
const results = [];
const errors = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const server = await new Promise((resolveStart, reject) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/server/server/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: join(dir, 'missions.sqlite'),
      CUBE_SIZE: '4',
      BLOCK_BASE_HP: '2',
      BLOCK_HP_PER_LAYER: '0',
      DISCOVERY_PROFILE: 'none',
      SEASON_DURATION_HOURS: '720',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  p.stdout.on('data', (d) => d.toString().includes('serveur prêt') && resolveStart(p));
  p.once('exit', (c) => reject(new Error(`serveur arrêté (${c})`)));
});

const ready = (p) =>
  p.waitForFunction(() => window.tlb?.state.player && window.tlb.state.cube && window.tlb.state.missions && document.querySelector('#conn-status').dataset.state === 'online', null, { timeout: 15000 });
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(`${who}: ${m.text()}`);
  });
};
const progress = (p) => p.evaluate(() => window.tlb.state.missions.missions.map((m) => `${m.id}:${m.progress}${m.done ? '✓' : ''}`).join(' '));
/** Un coup par l'interface : sélection du bloc, puis bouton Miner ; attend la confirmation du serveur. */
async function mineVia(page, block, isTouch) {
  const hits = await page.evaluate(() => window.tlb.state.me.hits);
  await page.evaluate((b) => {
    window.tlb.state.selected = b;
  }, block);
  if (isTouch) await page.tap('#mine-btn');
  else await page.click('#mine-btn');
  await page.waitForFunction((h) => window.tlb.state.me.hits > h, hits, { timeout: 5000 });
  await page.waitForTimeout(230); // reste sous 5 coups/s
}

const browsers = [];
try {
  const bMobile = await playwright.chromium.launch();
  const bDesktop = await playwright.chromium.launch();
  browsers.push(bMobile, bDesktop);
  const ctxA = await bMobile.newContext({ ...playwright.devices['iPhone 13'] });
  const ctxB = await bDesktop.newContext({ viewport: { width: 1280, height: 860 } });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  watch(A, 'mobile');
  watch(B, 'bureau');
  await A.goto(`${BASE}/?${Q}&profil=missions-mobile`);
  await B.goto(`${BASE}/?${Q}&profil=missions-bureau`);
  await ready(A);
  await ready(B);
  const kinds = await Promise.all([A, B].map((p) => p.evaluate(() => window.tlb.world.kind)));
  check(`rendu ${RENDU} actif dans les deux navigateurs`, kinds.every((k) => k === (RENDU === 'classique' ? 'classic' : 'monolith')), kinds.join(', '));

  // 1. État initial : trois missions à zéro, pastille du menu (téléphone) et de l'onglet.
  const badge0 = await A.evaluate(() => ({ menu: document.querySelector('#menu-missions').textContent, hidden: document.querySelector('#menu-missions').hidden }));
  check('téléphone : pastille « 0/3 » sur le bouton Menu', !badge0.hidden && badge0.menu === '0/3', badge0.menu);
  check('trois missions à zéro', (await progress(A)) === 'first-impacts:0 explorer:0 collective:0', await progress(A));

  // 2. Deux joueurs minent en même temps par l'interface.
  const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; // 20 coups, 10 blocs distincts (2 PV chacun)
  await Promise.all([
    (async () => {
      for (const b of order) await mineVia(A, b, true);
    })(),
    (async () => {
      for (const b of [10, 11, 12, 10, 11, 12]) await mineVia(B, b, false);
    })(),
  ]);
  await A.waitForTimeout(300);
  const pa = await progress(A);
  const pb = await progress(B);
  check('téléphone : « Premiers impacts » et « Explorateur » accomplies (20 coups, 10 blocs)', pa === 'first-impacts:20✓ explorer:10✓ collective:0', pa);
  check('ordinateur : progression personnelle indépendante (6 coups, 3 blocs)', pb === 'first-impacts:6 explorer:3 collective:0', pb);
  const hints = await Promise.all([A, B].map((p) => p.evaluate(() => document.querySelector('#mine-hint').textContent)));
  check('aide du bouton Miner : courte après 20 coups, complète pour un débutant (6 coups)', hints[0] === 'Maintenir = minage continu' && /^Touchez un bloc/.test(hints[1]), hints.join(' | '));
  const toasts = await A.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).join(' | '));
  const badge2 = await A.evaluate(() => document.querySelector('#menu-missions').textContent);
  check('téléphone : notification de mission accomplie et pastille « 2/3 »', /Mission accomplie/.test(toasts) && badge2 === '2/3', `${badge2} · ${toasts.slice(0, 90)}`);
  const early = await A.evaluate(() => ({ unlocks: window.tlb.state.missions.unlocks, layer: window.tlb.state.cube.currentLayer }));
  check('teinte « Signal » débloquée par les missions principales, sans attendre de couche terminée', early.unlocks.includes('skin:signal') && early.layer === 0, JSON.stringify(early));
  const me = await A.evaluate(() => window.tlb.state.me);
  check('aucun effet sur le score : 20 coups comptés comme 20 coups', me.hits === 20, JSON.stringify(me));

  // 3. Panneau « Missions du jour » dans le menu du téléphone, sans gêner le minage.
  await A.tap('#menu-btn');
  await A.tap('#missions-tab');
  await A.waitForTimeout(350);
  const panelA = await A.evaluate(() => ({
    items: [...document.querySelectorAll('#missions-list .mission')].map((li) => li.querySelector('.mission-count').textContent),
    reset: document.querySelector('#missions-reset').textContent,
    rank: document.querySelector('#missions-rank').textContent,
  }));
  check(
    'téléphone : « Missions du jour » dans le menu (progression, accomplies, réinitialisation 00 h UTC, rang)',
    panelA.items.join('|') === 'Accomplie|Accomplie|0 / 1' && /00 h UTC/.test(panelA.reset) && /Initié du Signal/.test(panelA.rank),
    `${panelA.items.join(' | ')} · ${panelA.reset}`,
  );
  await A.screenshot({ path: join(OUT, `missions-mobile-${RENDU}.png`) });
  await A.tap('#panel-close');
  await B.click('#missions-tab');
  await B.waitForTimeout(300);
  await B.screenshot({ path: join(OUT, `missions-bureau-${RENDU}.png`) });

  // 4. Contribution collective : l'ordinateur termine la couche ; les deux joueurs l'ont frappée aujourd'hui.
  for (;;) {
    const next = await B.evaluate(() => window.tlb.state.cube.currentLayer === 0 ? window.tlb.state.cube.currentHp.findIndex((h) => h > 0) : -1);
    if (next < 0) break;
    await mineVia(B, next, false);
  }
  await Promise.all([A, B].map((p) => p.waitForFunction(() => window.tlb.state.missions.missions[2].done, null, { timeout: 5000 }).catch(() => {})));
  const [ca, cb] = [await progress(A), await progress(B)];
  check('« Contribution collective » accomplie pour les deux joueurs à la fin de la couche', ca.endsWith('collective:1✓') && cb.endsWith('collective:1✓'), `${ca} / ${cb}`);
  const unlockedA = await A.evaluate(() => window.tlb.state.missions.unlocks);
  check('téléphone : teinte « Signal » toujours débloquée après le bonus', unlockedA.includes('skin:signal'), unlockedA.join(','));
  const lockedB = await B.evaluate(() => document.querySelector('.skin.locked') !== null && !window.tlb.state.missions.unlocks.includes('skin:signal'));
  check('ordinateur (missions principales incomplètes, bonus accompli) : teinte toujours verrouillée', lockedB);

  // 5. Choix de la teinte dans le Profil du téléphone.
  await A.tap('#menu-btn');
  await A.tap('.tabs button[data-tab="profile"]');
  await A.waitForTimeout(200);
  await A.tap('.skin[title="Signal"]');
  await A.waitForFunction(() => window.tlb.state.player.skin === 'signal', null, { timeout: 5000 }).catch(() => {});
  check('teinte « Signal » choisie dans le Profil', (await A.evaluate(() => window.tlb.state.player.skin)) === 'signal');
  await A.screenshot({ path: join(OUT, `missions-profil-mobile-${RENDU}.png`) });
  await A.tap('#panel-close');

  // 6. Reconnexion : même état, historique de la saison conservé.
  const before = await A.evaluate(() => JSON.stringify(window.tlb.state.missions.missions));
  await A.reload();
  await ready(A);
  const after = await A.evaluate(() => ({ m: JSON.stringify(window.tlb.state.missions.missions), h: window.tlb.state.missionHistory }));
  check('reconnexion : missions identiques, historique de la saison présent', after.m === before && after.h.length === 1 && after.h[0].missions.length === 3, JSON.stringify(after.h));

  // 7. Surface et panneau holographique non masqués : rien n'est ajouté sur la scène.
  const scene = await A.evaluate(() => {
    const v = document.querySelector('#viewport').getBoundingClientRect();
    const hit = document.elementFromPoint(v.left + v.width / 2, v.top + v.height / 2);
    return hit?.id === 'world';
  });
  check('surface de minage dégagée (aucun panneau de missions posé sur la scène)', scene);
  await A.screenshot({ path: join(OUT, `missions-surface-mobile-${RENDU}.png`) });

  check('aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('scénario exécuté sans exception', false, e.stack ?? String(e));
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  server.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
const ok = results.filter((r) => r.ok).length;
console.log(`${ok}/${results.length} vérifications réussies. Captures : ${OUT}`);
process.exit(ok === results.length ? 0 : 1);
