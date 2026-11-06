// Test réel des découvertes collectives (« Le Signal ») avec DEUX navigateurs
// Chromium distincts (téléphone tactile émulé + ordinateur), plus un navigateur
// en « animations réduites », un joueur absent pendant la révélation et un
// nouveau joueur arrivé après.
//
//   npm run build && node scripts/e2e-decouvertes.mjs [--rendu monolithe|classique] [--out ./e2e-output]
//
// Le serveur compilé tourne sur une base temporaire, avec un cube de 6 couches
// de 6 × 6 blocs à 1 PV (un fragment par couche, profil « standard ») et une
// cadence relevée à 100 coups/s pour que des robots WebSocket réels puissent
// préparer la couche rapidement. Le dernier bloc est miné par le téléphone.
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
console.log(`Découvertes — rendu testé : ${RENDU}`);

// Textes attendus (lus côté test uniquement : ils ne doivent jamais atteindre un navigateur avant la révélation).
const CONTENT = require('../server/content/discoveries.json');
const TEXT = Object.fromEntries(CONTENT.fragments.map((f) => [f.id, f.text]));
const TITLE = Object.fromEntries(CONTENT.fragments.map((f) => [f.id, f.title]));

const dir = mkdtempSync(join(tmpdir(), 'tlb-e2e-signal-'));
const DB = join(dir, 'signal.sqlite');
const SIZE = 6;
const PER_LAYER = SIZE * SIZE;
const port = await new Promise((r) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const BASE = `http://127.0.0.1:${port}`;
const results = [];
const metrics = {};
const errors = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
};

let server;
function startServer() {
  return new Promise((resolveStart, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/server/server/index.js'], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DB_PATH: DB,
        CUBE_SIZE: String(SIZE),
        BLOCK_BASE_HP: '1',
        BLOCK_HP_PER_LAYER: '0',
        MAX_ACTIONS_PER_SECOND: '100',
        DISCOVERY_PROFILE: 'standard',
        SEASON_DURATION_HOURS: '720',
        MAX_CONNECTIONS_PER_IP: '1000',
        NEW_ACCOUNTS_PER_IP_PER_HOUR: '1000',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    p.stdout.on('data', (d) => d.toString().includes('serveur prêt') && resolveStart(p));
    p.once('exit', (c) => reject(new Error(`serveur arrêté (${c})`)));
  });
}

/** Robot WebSocket réel : un compte invité qui mine par le même protocole que le jeu. */
async function bot(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const waiters = new Map();
  let welcome;
  let cube;
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  const gotWelcome = new Promise((r) => {
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.t === 'welcome') {
        welcome = m;
        cube = m.cube;
        r();
      }
      if (m.t === 'layer') cube = m.cube;
      if (m.t === 'delta') for (const [l, b, hp] of m.updates) if (cube && l === cube.currentLayer) cube.currentHp[b] = hp;
      if (m.t === 'mineResult') {
        waiters.get(m.actionId)?.(m);
        waiters.delete(m.actionId);
        if (m.ok && cube && m.layer === cube.currentLayer) cube.currentHp[m.block] = m.hpAfter;
      }
    });
  });
  ws.send(JSON.stringify({ t: 'hello', v: 1, name }));
  await gotWelcome;
  return {
    get cube() {
      return cube;
    },
    welcome,
    mine(layer, block) {
      const actionId = randomUUID();
      const p = new Promise((r) => waiters.set(actionId, r));
      ws.send(JSON.stringify({ t: 'mine', actionId, layer, block }));
      return p;
    },
    /** Détruit des blocs vivants de la couche courante jusqu'à en laisser `keep`. */
    async mineUntil(keep, avoid = new Set()) {
      const layer = cube.currentLayer;
      for (;;) {
        const c = cube;
        // La couche est tombée (layer reçu) : on s'arrête là, sans entamer la suivante.
        if (!c || c.currentLayer !== layer) return [];
        const alive = c.currentHp.map((hp, i) => (hp > 0 ? i : -1)).filter((i) => i >= 0);
        if (alive.length <= keep) return alive;
        const target = alive.find((i) => !avoid.has(i)) ?? alive[0];
        const r = await this.mine(c.currentLayer, target);
        if (!r.ok && r.reason !== 'already_destroyed') throw new Error(`robot refusé : ${r.reason}`);
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
    const t = m.text();
    if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(t)) errors.push(`${who}: ${t}`);
  });
};
/** Aucun texte de fragment verrouillé dans la page ni dans l'état reçu du serveur. */
const leaks = (p, ids) =>
  p.evaluate(
    (texts) => {
      const html = document.documentElement.outerHTML + JSON.stringify(window.tlb.state);
      return texts.filter((t) => html.includes(t));
    },
    ids.flatMap((id) => [TEXT[id], TITLE[id]]),
  );
const overlay = (p) =>
  p.evaluate(() => {
    const d = document.querySelector('#discovery');
    return {
      visible: !d.hidden,
      title: document.querySelector('#discovery-title').textContent,
      text: document.querySelector('#discovery-text').textContent,
      kicker: document.querySelector('#discovery-kicker').textContent,
      still: d.classList.contains('still'),
      cardAnim: getComputedStyle(document.querySelector('.discovery-card')).animationName,
      pulse: getComputedStyle(document.querySelector('.discovery-pulse')).display,
    };
  });
const chip = (p) => p.evaluate(() => (document.querySelector('#chip-signal').hidden ? null : document.querySelector('#chip-signal').textContent));

const browsers = [];
try {
  server = await startServer();
  const bMobile = await playwright.chromium.launch();
  const bDesktop = await playwright.chromium.launch();
  browsers.push(bMobile, bDesktop);
  const ctxA = await bMobile.newContext({ ...playwright.devices['iPhone 13'] });
  const ctxB = await bDesktop.newContext({ viewport: { width: 1280, height: 860 } });
  const ctxD = await bDesktop.newContext({ viewport: { width: 1280, height: 860 } });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  watch(A, 'mobile');
  watch(B, 'bureau');
  await A.goto(`${BASE}/?${Q}&profil=signal-mobile`);
  await B.goto(`${BASE}/?${Q}&profil=signal-bureau`);
  await ready(A);
  await ready(B);
  const kinds = await Promise.all([A, B].map((p) => p.evaluate(() => window.tlb.world.kind)));
  check(`rendu ${RENDU} actif dans les deux navigateurs`, kinds.every((k) => k === (RENDU === 'classique' ? 'classic' : 'monolith')), kinds.join(', '));

  // Joueur « absent » : vient une fois avant la révélation, puis revient après.
  const D = await ctxD.newPage();
  watch(D, 'absent');
  await D.goto(`${BASE}/?${Q}&profil=signal-absent`);
  await ready(D);
  await D.close();

  // 1. Avant toute révélation : six fragments verrouillés, aucun texte transmis.
  const init = await A.evaluate(() => window.tlb.state.discoveries);
  check(
    'six fragments verrouillés au départ, couches 1 à 6, sans titre ni texte',
    init?.fragments.length === 6 && init.fragments.every((f) => !f.revealed && !f.title && !f.text) && init.fragments.map((f) => f.layer).join() === '1,2,3,4,5,6',
  );
  check('aucun texte de fragment dans les pages avant la révélation', (await leaks(A, Object.keys(TEXT))).length === 0 && (await leaks(B, Object.keys(TEXT))).length === 0);

  // 2. Indices : un robot réel détruit la couche bloc par bloc.
  const R1 = await bot('Robot-Un');
  const R2 = await bot('Robot-Deux');
  const lastTarget = PER_LAYER - 1 - SIZE * 2 - 2; // bloc gardé pour le téléphone, au milieu de la face
  const keep = new Set([lastTarget]);
  await R1.mineUntil(PER_LAYER - 28, keep); // 28 / 36 = 77,8 %
  await A.waitForFunction((n) => window.tlb.state.cube.layerRemaining[0] === n, PER_LAYER - 28);
  const c78 = await chip(A);
  await R1.mineUntil(PER_LAYER - 29, keep); // 80,6 %
  await A.waitForFunction(() => !document.querySelector('#chip-signal').hidden, null, { timeout: 5000 }).catch(() => {});
  const c80 = [await chip(A), await chip(B)];
  check('indice absent sous 80 % de la couche', c78 === null, String(c78));
  check('« Anomalie détectée » à 80 % (deux navigateurs)', c80.every((c) => c?.includes('Anomalie détectée')), c80.join(' | '));
  await R2.mineUntil(1, keep); // 35 / 36 = 97,2 %
  await A.waitForFunction(() => document.querySelector('#chip-signal').textContent.includes('presque'), null, { timeout: 5000 }).catch(() => {});
  const c95 = [await chip(A), await chip(B)];
  check('« Signal presque accessible » à 95 % (deux navigateurs)', c95.every((c) => c?.includes('Signal presque accessible')), c95.join(' | '));
  if (RENDU === 'monolithe') {
    const notice = await A.evaluate(() => window.tlb.world.layers[0].data?.notice);
    check('panneau holographique : indice affiché', notice === 'Signal presque accessible', String(notice));
  }
  check('toujours aucun texte révélé avant la destruction complète', (await leaks(A, Object.keys(TEXT))).length === 0 && (await A.evaluate(() => document.querySelector('#discovery').hidden)));
  await A.screenshot({ path: join(OUT, `signal-indice-mobile-${RENDU}.png`) });

  // 3. Le téléphone sélectionne le dernier bloc d'un toucher et le mine.
  const bx = lastTarget % SIZE;
  const by = Math.floor(lastTarget / SIZE);
  await A.evaluate(([x, y]) => window.tlb.world.camera.animateTo({ x: x + 0.5, y: y + 0.5 }, 0), [bx, by]);
  await A.waitForTimeout(300);
  const pt = await A.evaluate(([x, y]) => {
    const r = document.querySelector('#world').getBoundingClientRect();
    const [sx, sy] = window.tlb.world.camera.worldToScreen(x + 0.5, y + 0.5);
    return [r.left + sx, r.top + sy];
  }, [bx, by]);
  await A.touchscreen.tap(pt[0], pt[1]);
  await A.waitForTimeout(200);
  check('toucher : dernier bloc sélectionné', (await A.evaluate(() => window.tlb.state.selected)) === lastTarget);
  const t0 = Date.now();
  await A.tap('#mine-btn');
  await Promise.all(
    [A, B].map((p) => p.waitForFunction(() => !document.querySelector('#discovery').hidden && window.tlb.state.discoveries.fragments[0].revealed, null, { timeout: 8000 })),
  );
  metrics.revelationMs = Date.now() - t0;
  // Mesure de fluidité pendant l'animation (téléphone).
  const fps = await A.evaluate(
    () =>
      new Promise((r) => {
        let n = 0;
        const t = performance.now();
        const f = () => (performance.now() - t < 1500 ? (n++, requestAnimationFrame(f)) : r(Math.round(n / 1.5)));
        requestAnimationFrame(f);
      }),
  );
  metrics.fpsPendantAnimation = fps;
  await A.waitForTimeout(400);
  const [oa, ob] = [await overlay(A), await overlay(B)];
  const logA = await A.evaluate(() => window.tlb.state.discoveries);
  const logB = await B.evaluate(() => window.tlb.state.discoveries);
  check(
    'les deux navigateurs reçoivent la même découverte : « L\'Écho »',
    oa.visible && ob.visible && oa.title === "L'ÉCHO" && ob.title === "L'ÉCHO" && oa.text === TEXT.echo && ob.text === TEXT.echo,
    `${oa.title} / ${ob.title}`,
  );
  check('journal identique dans les deux navigateurs (couche 1, même date)', JSON.stringify(logA) === JSON.stringify(logB) && logA.fragments[0].layer === 1 && logA.fragments[0].revealedAt > 0);
  check('les autres fragments restent secrets après la révélation', (await leaks(A, Object.keys(TEXT).filter((k) => k !== 'echo'))).length === 0);
  if (RENDU === 'monolithe') {
    const notice = await B.evaluate(() => window.tlb.world.layers[0].data?.notice);
    check('panneau holographique : « Nouveau fragment découvert »', notice === 'Nouveau fragment découvert', String(notice));
  }
  check(
    `animation : impulsion et carte animées (${fps} images/s pendant l'animation)`,
    !oa.still && oa.cardAnim !== 'none' && oa.pulse !== 'none' && fps >= 20,
    `${oa.cardAnim}, ${fps} img/s`,
  );
  await A.screenshot({ path: join(OUT, `signal-revelation-mobile-${RENDU}.png`) });
  await B.screenshot({ path: join(OUT, `signal-revelation-bureau-${RENDU}.png`) });

  // 4. Non bloquant : pendant l'annonce, le bouton Miner reste accessible et on continue de miner.
  const free = await A.evaluate(() => {
    const m = document.querySelector('#mine-btn').getBoundingClientRect();
    const hit = document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2);
    return !!hit?.closest('#mine-btn');
  });
  const hits0 = await A.evaluate(() => window.tlb.state.me.hits);
  await A.waitForFunction(() => window.tlb.state.cube.currentLayer === 1);
  await A.evaluate(() => {
    const c = window.tlb.state.cube;
    window.tlb.state.selected = c.currentHp.findIndex((h) => h > 0);
  });
  await A.tap('#mine-btn');
  await A.waitForFunction((h) => window.tlb.state.me.hits > h, hits0, { timeout: 5000 }).catch(() => {});
  const hits1 = await A.evaluate(() => window.tlb.state.me.hits);
  check('annonce non bloquante : Miner accessible et coup confirmé pendant l\'annonce', free && hits1 > hits0 && (await overlay(A)).visible);

  // 5. Archives du cube : menu du téléphone (tiroir), panneau de l'ordinateur.
  await A.tap('#discovery-open');
  await A.waitForTimeout(500);
  const archA = await A.evaluate(() => ({
    open: document.querySelector('#panel').classList.contains('open'),
    tab: document.querySelector('.tabs button.active')?.dataset.tab,
    revealed: [...document.querySelectorAll('#archives-list .frag.revealed')].map((e) => e.innerText),
    locked: document.querySelectorAll('#archives-list .frag.locked').length,
    summary: document.querySelector('#archives-summary').textContent,
    overlay: !document.querySelector('#discovery').hidden,
  }));
  check(
    'téléphone : « Archives du cube » s\'ouvrent dans le menu, 1 fragment révélé et 5 verrouillés',
    archA.open && archA.tab === 'archives' && archA.revealed.length === 1 && archA.locked === 5 && archA.revealed[0].includes(TEXT.echo) && /couche 1/.test(archA.revealed[0]) && !archA.overlay,
    archA.summary,
  );
  await A.screenshot({ path: join(OUT, `signal-archives-mobile-${RENDU}.png`) });
  await A.tap('#panel-close');
  await B.click('#discovery-close');
  await B.click('#archives-tab');
  await B.waitForTimeout(400);
  const seasonsOpt = await B.evaluate(() => [...document.querySelectorAll('#archives-season option')].map((o) => o.textContent));
  check('ordinateur : archives avec la saison en cours', seasonsOpt.some((t) => t.includes('Saison 1')) && (await B.evaluate(() => document.querySelectorAll('#archives-list .frag.revealed').length)) === 1, seasonsOpt.join(', '));
  await B.screenshot({ path: join(OUT, `signal-archives-bureau-${RENDU}.png`) });

  // 6. Reconnexion, joueur absent, nouveau joueur : même historique.
  await B.reload();
  await ready(B);
  await B.waitForTimeout(400);
  const afterReload = await B.evaluate(() => ({ log: window.tlb.state.discoveries, overlay: !document.querySelector('#discovery').hidden }));
  check('reconnexion : historique identique, annonce déjà vue non rejouée', JSON.stringify(afterReload.log) === JSON.stringify(logA) && !afterReload.overlay);
  const D2 = await ctxD.newPage();
  watch(D2, 'absent');
  await D2.goto(`${BASE}/?${Q}&profil=signal-absent`);
  await ready(D2);
  await D2.waitForTimeout(400);
  const od = await overlay(D2);
  check('joueur absent pendant la révélation : annoncée à son retour, une fois', od.visible && /absence/.test(od.kicker) && od.text === TEXT.echo, od.kicker);
  const ctxC = await bDesktop.newContext({ viewport: { width: 1280, height: 860 } });
  const C = await ctxC.newPage();
  watch(C, 'nouveau');
  await C.goto(`${BASE}/?${Q}&profil=signal-nouveau`);
  await ready(C);
  const logC = await C.evaluate(() => window.tlb.state.discoveries);
  check('nouveau joueur : même historique que les autres', JSON.stringify(logC) === JSON.stringify(logA));

  // 7. Animations réduites : deuxième fragment révélé sans impulsion ni animation.
  const ctxR = await bMobile.newContext({ ...playwright.devices['iPhone 13'], reducedMotion: 'reduce' });
  const Rm = await ctxR.newPage();
  watch(Rm, 'réduit');
  await Rm.goto(`${BASE}/?${Q}&profil=signal-reduit`);
  await ready(Rm);
  await R1.mineUntil(0);
  await Promise.all([Rm, A, B].map((p) => p.waitForFunction(() => window.tlb.state.discoveries.fragments[1].revealed, null, { timeout: 8000 })));
  await Rm.waitForTimeout(300);
  const orm = await overlay(Rm);
  check(
    'animations réduites : titre complet immédiatement, sans impulsion ni animation',
    orm.visible && orm.still && orm.cardAnim === 'none' && orm.pulse === 'none' && orm.title === 'LES COORDONNÉES',
    `${orm.title}, ${orm.cardAnim}, impulsion ${orm.pulse}`,
  );
  await Rm.screenshot({ path: join(OUT, `signal-reduit-mobile-${RENDU}.png`) });
  const o2 = await overlay(B);
  check('deuxième fragment reçu par les autres navigateurs (robot sur la couche 2)', o2.visible && o2.text === TEXT.coordinates);

  check('aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));
  R1.close();
  R2.close();
} catch (e) {
  check('scénario exécuté sans exception', false, e.stack ?? String(e));
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  server?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
const ok = results.filter((r) => r.ok).length;
console.log(`\nMesures : ${JSON.stringify(metrics)}`);
console.log(`${ok}/${results.length} vérifications réussies. Captures : ${OUT}`);
process.exit(ok === results.length ? 0 : 1);
