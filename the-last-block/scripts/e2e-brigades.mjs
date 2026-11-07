// Test réel des objectifs de brigade avec DEUX navigateurs Chromium distincts
// (téléphone tactile émulé + ordinateur) et trois robots WebSocket membres de
// la même brigade, à la cadence de production (5 coups/s par compte).
//
//   npm run build && node scripts/e2e-brigades.mjs [--rendu monolithe|classique] [--out ./e2e-output]
//
// Cube de 10 couches de 10 × 10 blocs à 1 PV, saison explicitement sans découverte.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
console.log(`Objectifs de brigade — rendu testé : ${RENDU}`);

const dir = mkdtempSync(join(tmpdir(), 'tlb-e2e-brigades-'));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await new Promise((resolveStart, reject) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/server/server/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: join(dir, 'brigades.sqlite'),
      CUBE_SIZE: '10',
      BLOCK_BASE_HP: '1',
      BLOCK_HP_PER_LAYER: '0',
      DISCOVERY_PROFILE: 'none',
      SEASON_DURATION_HOURS: '720',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  p.stdout.on('data', (d) => d.toString().includes('serveur prêt') && resolveStart(p));
  p.once('exit', (c) => reject(new Error(`serveur arrêté (${c})`)));
});

/** Robot WebSocket réel : un compte invité qui rejoint la brigade et mine par le protocole du jeu. */
async function bot(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const waiters = new Map();
  let cube;
  let brigade = null;
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  const welcome = new Promise((r) => {
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.t === 'welcome') {
        cube = m.cube;
        r(m);
      }
      if (m.t === 'layer') cube = m.cube;
      if (m.t === 'brigade') brigade = m.brigade;
      if (m.t === 'delta') for (const [l, b, hp] of m.updates) if (cube && l === cube.currentLayer) cube.currentHp[b] = hp;
      if (m.t === 'mineResult') {
        waiters.get(m.actionId)?.(m);
        waiters.delete(m.actionId);
        if (m.ok && cube && m.layer === cube.currentLayer) cube.currentHp[m.block] = m.hpAfter;
      }
    });
  });
  ws.send(JSON.stringify({ t: 'hello', v: 1, name }));
  const w = await welcome;
  return {
    id: w.player.id,
    get brigade() {
      return brigade;
    },
    send: (m) => ws.send(JSON.stringify(m)),
    /** Mine `n` coups validés, au rythme d'un joueur (un coup toutes les 210 ms). */
    async mine(n) {
      let done = 0;
      while (done < n) {
        const alive = cube.currentHp.map((h, i) => (h > 0 ? i : -1)).filter((i) => i >= 0);
        const target = alive[Math.floor(Math.random() * alive.length)];
        const actionId = randomUUID();
        const res = await new Promise((r) => {
          waiters.set(actionId, r);
          ws.send(JSON.stringify({ t: 'mine', actionId, layer: cube.currentLayer, block: target }));
        });
        if (res.ok) done++;
        await sleep(210);
      }
    },
    close: () => ws.close(),
  };
}

const ready = (p) =>
  p.waitForFunction(() => window.tlb?.state.player && window.tlb.state.cube && document.querySelector('#conn-status').dataset.state === 'online', null, { timeout: 15000 });
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(`${who}: ${m.text()}`);
  });
};
const objectives = (p) => p.evaluate(() => window.tlb.state.brigade?.objectives ?? null);
async function mineVia(page, isTouch, n) {
  for (let i = 0; i < n; i++) {
    const hits = await page.evaluate(() => window.tlb.state.me.hits);
    await page.evaluate(() => {
      const c = window.tlb.state.cube;
      const alive = c.currentHp.map((h, j) => (h > 0 ? j : -1)).filter((j) => j >= 0);
      window.tlb.state.selected = alive[Math.floor(Math.random() * alive.length)];
    });
    if (isTouch) await page.tap('#mine-btn');
    else await page.click('#mine-btn');
    await page.waitForFunction((h) => window.tlb.state.me.hits > h, hits, { timeout: 5000 }).catch(() => {});
    await sleep(220);
  }
}

const browsers = [];
const bots = [];
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
  await A.goto(`${BASE}/?${Q}&profil=brigade-mobile`);
  await B.goto(`${BASE}/?${Q}&profil=brigade-bureau`);
  await ready(A);
  await ready(B);
  // Journal des notifications (elles disparaissent au bout de quelques secondes).
  for (const p of [A, B]) {
    await p.evaluate(() => {
      window.__toasts = [];
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => window.__toasts.push(n.textContent)))).observe(document.querySelector('#toasts'), { childList: true });
    });
  }

  // 1. Le téléphone crée la brigade par le menu ; l'ordinateur la rejoint avec le code.
  await A.tap('#menu-btn');
  await A.tap('.tabs button[data-tab="brigade"]');
  await A.fill('#brigade-create input[name="name"]', 'Les Foreurs');
  await A.tap('#brigade-create button[type="submit"]');
  await A.waitForFunction(() => window.tlb.state.brigade?.name === 'Les Foreurs', null, { timeout: 5000 });
  const code = await A.evaluate(() => window.tlb.state.brigade.inviteCode);
  await A.tap('#panel-close');
  await B.click('.tabs button[data-tab="brigade"]');
  await B.fill('#brigade-join input[name="code"]', code);
  await B.click('#brigade-join button[type="submit"]');
  await B.waitForFunction(() => window.tlb.state.brigade?.name === 'Les Foreurs', null, { timeout: 5000 });
  const id0 = await B.evaluate(() => ({ emblem: document.querySelector('#brigade-emblem').textContent, title: document.querySelector('#brigade-title').textContent, n: window.tlb.state.brigade.objectives.objectives.length }));
  check('brigade de 2 (non qualifiée) : identité et trois objectifs affichés', id0.emblem.length > 0 && id0.n === 3 && /Aucun titre/.test(id0.title), JSON.stringify(id0));

  // 2. Trois robots rejoignent : brigade de 5 membres.
  for (const n of ['Robot-Un', 'Robot-Deux', 'Robot-Trois']) {
    const b = await bot(n);
    b.send({ t: 'brigadeJoin', code });
    bots.push(b);
  }
  await sleep(500);
  await B.waitForFunction(() => window.tlb.state.brigade.members.length === 5, null, { timeout: 5000 });
  check('brigade de 5 membres visible sur les deux navigateurs', (await A.evaluate(() => window.tlb.state.brigade.members.length)) === 5);

  // 3. Contributions simultanées : robots et joueurs minent en même temps.
  const t0 = Date.now();
  await Promise.all([...bots.map((b) => b.mine(160)), mineVia(A, true, 12), mineVia(B, false, 12)]);
  const elapsed = Date.now() - t0;
  await sleep(1500);
  const [oa, ob] = [await objectives(A), await objectives(B)];
  const val = (o, id) => o.objectives.find((x) => x.id === id);
  check(
    'progression synchronisée sur les deux navigateurs (mêmes valeurs, mêmes distinctions)',
    JSON.stringify(oa.objectives) === JSON.stringify(ob.objectives) && JSON.stringify(oa.distinctions) === JSON.stringify(ob.distinctions),
    `effort ${val(oa, 'effort').value}, ensemble ${val(oa, 'together').value}, signal ${val(oa, 'signal').value} (${Math.round(elapsed / 1000)} s)`,
  );
  check('« Effort collectif I » atteint (palier à 500 coups)', val(oa, 'effort').value === oa.totals.hits && oa.totals.hits >= 500 && val(oa, 'effort').reached === 1, String(oa.totals.hits));
  check('brigade de 5 : « Tous ensemble » compte les trois membres au-dessus de 100 coups (palier II)', val(oa, 'together').value === 3 && val(oa, 'together').reached === 2);
  check('« Exploration du Signal » : couches terminées avec 50 coups de la brigade', val(oa, 'signal').value >= 1 && val(oa, 'signal').reached >= 1, String(val(oa, 'signal').value));
  const labels = oa.distinctions.map((d) => d.label);
  check('distinctions débloquées et titre honorifique', ['Effort collectif I', 'Tous ensemble II', 'Exploration du Signal I'].every((l) => labels.includes(l)) && oa.title !== null && oa.frame >= 1, `${labels.join(', ')} · ${oa.title}`);
  const toastsA = await A.evaluate(() => window.__toasts.filter((t) => t.includes('Distinction de brigade')));
  const toastsB = await B.evaluate(() => window.__toasts.filter((t) => t.includes('Distinction de brigade')));
  check('notifications « Distinction de brigade » reçues par les deux navigateurs, une par distinction', toastsA.length === labels.length && toastsB.length === labels.length, `${toastsA.length} / ${toastsB.length} / ${labels.length}`);
  const contrib = oa.contributors.map((c) => c.hits).reduce((s, h) => s + h, 0);
  check('contribution de chaque membre = contribution collective', contrib === oa.totals.hits, `${contrib} / ${oa.totals.hits}`);

  // 4. Rejoindre un membre récemment actif (fonction existante, depuis la liste des membres).
  const busy = bots[0].mine(6);
  await sleep(700);
  await B.click('.tabs button[data-tab="brigade"]');
  await B.waitForFunction(() => [...document.querySelectorAll('#brigade-members .join-mate')].some((b) => !b.hidden), null, { timeout: 5000 }).catch(() => {});
  const cam0 = await B.evaluate(() => ({ x: window.tlb.world.camera.x, y: window.tlb.world.camera.y }));
  const visibleJoin = await B.evaluate(() => [...document.querySelectorAll('#brigade-members .join-mate')].filter((b) => !b.hidden).length);
  await B.click('#brigade-members .join-mate:not([hidden])');
  await sleep(800);
  const cam1 = await B.evaluate(() => ({ x: window.tlb.world.camera.x, y: window.tlb.world.camera.y }));
  check('« Rejoindre » un membre actif : la caméra se déplace vers lui', visibleJoin >= 1 && (cam0.x !== cam1.x || cam0.y !== cam1.y), `${visibleJoin} bouton(s)`);
  await busy;
  await B.screenshot({ path: join(OUT, `brigade-bureau-${RENDU}.png`) });
  await A.tap('#menu-btn');
  await A.tap('.tabs button[data-tab="brigade"]');
  await sleep(300);
  await A.screenshot({ path: join(OUT, `brigade-mobile-${RENDU}.png`) });
  await A.evaluate(() => document.querySelector('#brigade-objectives').scrollIntoView());
  await sleep(200);
  await A.screenshot({ path: join(OUT, `brigade-objectifs-mobile-${RENDU}.png`) });
  await A.tap('#panel-close');

  // 5. Départ d'un membre : sa contribution reste acquise ; la progression ne baisse pas.
  const before = await objectives(A);
  const leaver = bots[2];
  leaver.send({ t: 'brigadeLeave' });
  await A.waitForFunction(() => window.tlb.state.brigade.members.length === 4, null, { timeout: 5000 });
  const after = await objectives(A);
  const gone = after.contributors.find((c) => c.id === leaver.id);
  check(
    'départ d\'un membre : contribution conservée (« parti »), progression inchangée',
    gone && !gone.member && gone.hits === before.contributors.find((c) => c.id === leaver.id).hits && val(after, 'together').value === val(before, 'together').value && after.totals.hits === before.totals.hits,
    gone ? `${gone.name} ${gone.hits}` : 'absent',
  );

  // 6. Reconnexion : même état.
  await B.reload();
  await ready(B);
  await B.waitForFunction(() => window.tlb.state.brigade?.objectives, null, { timeout: 5000 });
  const reloaded = await objectives(B);
  check('reconnexion : objectifs et distinctions identiques', JSON.stringify(reloaded.objectives) === JSON.stringify(after.objectives) && JSON.stringify(reloaded.distinctions) === JSON.stringify(after.distinctions));

  // 7. Surface dégagée : rien n'est posé sur la scène.
  const clear = await A.evaluate(() => {
    const v = document.querySelector('#viewport').getBoundingClientRect();
    return document.elementFromPoint(v.left + v.width / 2, v.top + v.height / 2)?.id === 'world';
  });
  check('surface de minage dégagée', clear);
  check('aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('scénario exécuté sans exception', false, e.stack ?? String(e));
} finally {
  for (const b of bots) b.close();
  for (const b of browsers) await b.close().catch(() => {});
  server.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
const ok = results.filter((r) => r.ok).length;
console.log(`${ok}/${results.length} vérifications réussies. Captures : ${OUT}`);
process.exit(ok === results.length ? 0 : 1);
