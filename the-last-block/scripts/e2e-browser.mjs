// Test réel de bout en bout avec DEUX navigateurs Chromium distincts
// (téléphone tactile émulé + ordinateur), sur la surface navigable.
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
  console.error("Lancez d'abord `npm run build`.");
  process.exit(2);
}
const outIdx = process.argv.indexOf('--out');
const OUT = resolve(outIdx > 0 ? process.argv[outIdx + 1] : 'e2e-output');
// --rendu monolithe : mêmes scénarios avec le rendu en perspective.
const renduIdx = process.argv.indexOf('--rendu');
const RENDU = renduIdx > 0 ? process.argv[renduIdx + 1] : 'classique';
const Q = `rendu=${RENDU}`;
console.log(`Rendu testé : ${RENDU}`);
mkdirSync(OUT, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), 'tlb-e2e-'));
const DB = join(dir, 'e2e.sqlite');
const ADMIN = 'e2e-admin-token-0123456789';
const SIZE = 40;
const port = await new Promise((r) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const BASE = `http://127.0.0.1:${port}`;
let server;
const results = [];
const metrics = {};
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
};

function startServer() {
  return new Promise((resolveStart, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/server/server/index.js'], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DB_PATH: DB,
        CUBE_SIZE: String(SIZE),
        BLOCK_BASE_HP: '3',
        BLOCK_HP_PER_LAYER: '1',
        SEASON_DURATION_HOURS: '720',
        SEASON_COOLDOWN_SECONDS: '2',
        ADMIN_TOKEN: ADMIN,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    p.stdout.on('data', (d) => d.toString().includes('serveur prêt') && resolveStart(p));
    p.once('exit', (c) => reject(new Error(`serveur arrêté (${c})`)));
  });
}

// --- Aides ------------------------------------------------------------------
const ready = (p) =>
  p.waitForFunction(() => window.tlb?.state.player && window.tlb.state.cube && document.querySelector('#conn-status').dataset.state === 'online', null, { timeout: 15000 });
const cam = (p) => p.evaluate(() => ({ x: window.tlb.world.camera.x, y: window.tlb.world.camera.y, zoom: window.tlb.world.camera.zoom }));
const sel = (p) => p.evaluate(() => window.tlb.state.selected);
const hpOf = (p, idx) => p.evaluate((i) => window.tlb.state.cube.currentHp[i], idx);
const visible = (p) => p.evaluate(() => window.tlb.world.camera.visibleWorld());

async function touchApi(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  return {
    async drag(x0, y0, dx, dy, steps = 12) {
      await send('touchStart', [[x0, y0]]);
      for (let i = 1; i <= steps; i++) {
        await send('touchMove', [[x0 + (dx * i) / steps, y0 + (dy * i) / steps]]);
        await page.waitForTimeout(16);
      }
      await send('touchEnd', []);
    },
    async pinch(cx, cy, from, to, steps = 8) {
      await send('touchStart', [[cx - from, cy], [cx + from, cy]]);
      for (let i = 1; i <= steps; i++) {
        const d = from + ((to - from) * i) / steps;
        await send('touchMove', [[cx - d, cy], [cx + d, cy]]);
        await page.waitForTimeout(16);
      }
      await send('touchEnd', []);
    },
    async tap(x, y) {
      await send('touchStart', [[x, y]]);
      await page.waitForTimeout(40);
      await send('touchEnd', []);
    },
  };
}

/** Aucun chevauchement entre les éléments d'interface visibles. */
async function overlaps(page) {
  return page.evaluate(() => {
    const box = (s) =>
      [...document.querySelectorAll(s)]
        .filter((e) => !e.closest('[hidden]') && getComputedStyle(e).display !== 'none' && e.getClientRects().length)
        .map((e) => ({ s, r: e.getBoundingClientRect() }));
    const hit = (a, b) => a.r.left < b.r.right - 0.5 && b.r.left < a.r.right - 0.5 && a.r.top < b.r.bottom - 0.5 && b.r.top < a.r.bottom - 0.5;
    const groups = ['#mine-btn', '.playtime', '.cam-controls', '.map-box', '#banner', '.chips', '#toasts .toast', '.topbar'];
    const all = groups.flatMap(box);
    const bad = [];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (all[i].s !== all[j].s && hit(all[i], all[j])) bad.push(`${all[i].s} × ${all[j].s}`);
    // La barre d'action est sous la surface, jamais dessus ; le bouton Miner est entièrement à l'écran.
    const v = document.querySelector('#viewport').getBoundingClientRect();
    const a = document.querySelector('.actionbar').getBoundingClientRect();
    if (a.top < v.bottom - 0.5) bad.push('.actionbar × #viewport');
    const m = document.querySelector('#mine-btn').getBoundingClientRect();
    if (m.bottom > innerHeight + 0.5 || m.top < 0) bad.push('#mine-btn hors écran');
    if (document.documentElement.scrollWidth > innerWidth + 1) bad.push('défilement horizontal');
    return bad;
  });
}

const browsers = [];
const errors = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(t)) errors.push(`${who}: ${t}`);
  });
};

try {
  server = await startServer();
  const bMobile = await playwright.chromium.launch();
  const bDesktop = await playwright.chromium.launch();
  browsers.push(bMobile, bDesktop);
  const ctxA = await bMobile.newContext({ ...playwright.devices['iPhone 13'] });
  const ctxB = await bDesktop.newContext({ viewport: { width: 1280, height: 860 } });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  watch(A, 'mobile');
  watch(B, 'bureau');

  // 1. Miner dans les secondes qui suivent l'ouverture (bloc présélectionné).
  const t0 = Date.now();
  await A.goto(`${BASE}/?${Q}`);
  await ready(A);
  const firstSel = await sel(A);
  await A.tap('#mine-btn');
  await A.waitForFunction(() => window.tlb.state.me.hits >= 1, null, { timeout: 10000 });
  const tFirst = Date.now() - t0;
  metrics.premierCoupMs = tFirst;
  check('premier coup confirmé peu après l\'ouverture, sans rien régler', firstSel !== null && tFirst < 6000, `${(tFirst / 1000).toFixed(1)} s`);
  await B.goto(`${BASE}/?${Q}`);
  await ready(B);
  const idA = await A.evaluate(() => window.tlb.state.player.id);
  const idB = await B.evaluate(() => window.tlb.state.player.id);
  check('deux joueurs distincts sur la même face', idA !== idB, `${SIZE}×${SIZE} blocs`);

  // 2. Navigation tactile (mobile) : glisser, inertie, pincer.
  const T = await touchApi(A);
  const vb = await A.locator('#world').boundingBox();
  const cx = vb.x + vb.width / 2;
  const cy = vb.y + vb.height / 2;
  const view0 = await visible(A);
  const start0 = await cam(A);
  const c0 = await cam(A);
  await T.drag(cx + 120, cy, -240, 0);
  await A.waitForTimeout(900);
  await T.drag(cx, cy + 150, 0, -300);
  await A.waitForTimeout(900);
  const c1 = await cam(A);
  check('glisser du doigt : la caméra se déplace (gauche/droite et haut/bas)', c1.x - c0.x > 4 && c1.y - c0.y > 4, `Δx ${(c1.x - c0.x).toFixed(1)}, Δy ${(c1.y - c0.y).toFixed(1)} blocs`);
  await T.pinch(cx, cy, 40, 110);
  await A.waitForTimeout(300);
  const c2 = await cam(A);
  await T.pinch(cx, cy, 110, 60);
  await A.waitForTimeout(300);
  const c3 = await cam(A);
  check('pincer : zoom avant puis arrière, borné', c2.zoom > c1.zoom * 1.5 && c3.zoom < c2.zoom && c2.zoom <= 96, `${c1.zoom.toFixed(0)} → ${c2.zoom.toFixed(0)} → ${c3.zoom.toFixed(0)} px/bloc`);
  const selBeforeZoom = await sel(A);
  // Téléphone : les commandes secondaires sont regroupées derrière « ⋯ », Miner reste à portée.
  const camMenu0 = await A.evaluate(() => ({ zoomVisible: !!document.querySelector('#zoom-in').offsetParent, more: !!document.querySelector('#cam-more').offsetParent }));
  await A.tap('#cam-more');
  const camMenu1 = await A.evaluate(() => !!document.querySelector('#zoom-in').offsetParent && !!document.querySelector('#board-btn').offsetParent);
  check('mobile : commandes secondaires regroupées derrière « ⋯ » puis dépliées', camMenu0.more && !camMenu0.zoomVisible && camMenu1, JSON.stringify({ ...camMenu0, ouvert: camMenu1 }));
  // Menu ouvert : chaque commande affiche son nom, entièrement dans la vue.
  const camLabels = await A.evaluate(() =>
    [...document.querySelectorAll('#cam-controls button[data-label]')]
      .filter((b) => b.offsetParent)
      .map((b) => {
        const cs = getComputedStyle(b, '::after');
        const r = b.getBoundingClientRect();
        return { text: cs.content.replace(/"/g, ''), left: r.left - 6 - parseFloat(cs.width || '0') };
      }),
  );
  check('mobile : « ⋯ » ouvert, chaque commande est nommée (Zoomer, Panneau, Mon bloc…)', camLabels.length >= 6 && camLabels.every((l) => l.text && l.text !== 'none' && l.left >= 0), camLabels.map((l) => l.text).join(', '));
  await A.tap('#zoom-in');
  await A.waitForTimeout(350);
  check('le zoom conserve la sélection', (await sel(A)) === selBeforeZoom);

  // 3. Sélectionner après déplacement un bloc qui n'était pas visible au départ, puis le miner.
  // Toucher au-dessus du centre : toujours sur la face (en perspective, le bas de
  // l'écran peut montrer la falaise et le vide au-delà du bord sud).
  await T.tap(cx + 30, cy - 40);
  await A.waitForTimeout(200);
  const target = await sel(A);
  const tx = target % SIZE;
  const ty = Math.floor(target / SIZE);
  // En vue de dessus : le bloc n'était pas à l'écran au départ. En perspective, l'écran montre
  // déjà une grande partie de la face : on exige un bloc éloigné du point visé initial.
  const wasOffscreen = RENDU === 'monolithe'
    ? Math.hypot(tx + 0.5 - start0.x, ty + 0.5 - start0.y) >= 4
    : tx < view0.minX || tx + 1 > view0.maxX || ty < view0.minY || ty + 1 > view0.maxY;
  check('toucher bref après déplacement : sélection d\'un bloc éloigné du point de départ', target !== null && wasOffscreen, `bloc (${tx}, ${ty})`);
  // Le bureau regarde le même endroit.
  await B.evaluate(([x, y]) => {
    window.tlb.world.camera.animateTo({ x: x + 0.5, y: y + 0.5, zoom: 44 }, 0);
    window.tlb.world.requestRender();
  }, [tx, ty]);
  const hp0 = await hpOf(A, target);
  await A.tap('#mine-btn');
  await A.waitForFunction(([i, h]) => window.tlb.state.cube.currentHp[i] === h - 1, [target, hp0]);
  await B.waitForFunction(([i, h]) => window.tlb.state.cube.currentHp[i] === h - 1, [target, hp0], { timeout: 5000 });
  check('miner après déplacement : coup confirmé et vu par l\'autre navigateur', true, `PV ${hp0} → ${hp0 - 1}`);

  // 4. Bureau : glisser souris, molette, clavier, clic + Espace ; destruction vue par le mobile.
  const db = await B.locator('#world').boundingBox();
  const d0 = await cam(B);
  await B.mouse.move(db.x + 500, db.y + 300);
  await B.mouse.down();
  await B.mouse.move(db.x + 380, db.y + 220, { steps: 8 });
  await B.mouse.up();
  await B.waitForTimeout(700);
  const d1 = await cam(B);
  await B.mouse.wheel(0, -240);
  await B.waitForTimeout(200);
  const d2 = await cam(B);
  await B.keyboard.down('ArrowLeft');
  await B.waitForTimeout(350);
  await B.keyboard.up('ArrowLeft');
  await B.waitForTimeout(100);
  const d3 = await cam(B);
  check('bureau : glisser, molette et flèches déplacent/zooment', d1.x > d0.x && d2.zoom > d1.zoom && d3.x < d2.x, `x ${d0.x.toFixed(1)}→${d1.x.toFixed(1)}→${d3.x.toFixed(1)}, zoom ${d1.zoom.toFixed(0)}→${d2.zoom.toFixed(0)}`);
  // Clic sur le bloc visé par le mobile, puis Espace jusqu'à destruction.
  await B.evaluate(([x, y]) => {
    window.tlb.world.camera.animateTo({ x: x + 0.5, y: y + 0.5, zoom: 44 }, 0);
    window.tlb.world.requestRender();
  }, [tx, ty]);
  await B.waitForTimeout(100);
  await B.mouse.click(db.x + db.width / 2, db.y + db.height / 2);
  await B.waitForTimeout(150);
  check('clic : sélection du bloc sous le curseur', (await sel(B)) === target);
  for (let i = 0; i < 6 && (await hpOf(B, target)) > 0; i++) {
    await B.keyboard.press('Space');
    await B.waitForTimeout(260);
  }
  await A.waitForFunction((i) => window.tlb.state.cube.currentHp[i] === 0, target, { timeout: 5000 });
  check('destruction confirmée par le serveur, identique dans les deux navigateurs', (await hpOf(B, target)) === 0);
  const selAfter = await sel(B);
  check('après destruction, la sélection passe au bloc vivant voisin', selAfter !== target && (await hpOf(B, selAfter)) > 0);

  // 5. Débit : maintenir Miner 2,5 s (mobile).
  const hitsBefore = await A.evaluate(() => window.tlb.state.me.hits);
  await A.dispatchEvent('#mine-btn', 'pointerdown');
  await A.waitForTimeout(2500);
  await A.dispatchEvent('#mine-btn', 'pointerup');
  await A.waitForTimeout(800);
  const held = (await A.evaluate(() => window.tlb.state.me.hits)) - hitsBefore;
  check('maintien du bouton : ≤ 5 coups/s', held > 3 && held <= 5 * 2.5 + 5, `${held} coups en 2,5 s`);

  // 6. Brigade + présence réelle + « Rejoindre ma brigade ».
  const openTab = async (p, tab) => {
    const sheetOpen = await p.evaluate(() => document.querySelector('#panel').classList.contains('open'));
    if ((await p.locator('#menu-btn').isVisible()) && !sheetOpen) {
      await p.click('#menu-btn');
      await p.waitForTimeout(250);
    }
    await p.click(`.tabs [data-tab=${tab}]`);
  };
  const closeSheet = async (p) => {
    if (await p.locator('#panel-close').isVisible()) await p.click('#panel-close');
  };
  await openTab(A, 'profile');
  await A.fill('#name-input', 'Alice');
  await A.click('#name-form button');
  await A.waitForFunction(() => window.tlb.state.player.name === 'Alice');
  await openTab(A, 'brigade');
  await A.fill('#brigade-create input', 'Les Foreurs');
  await A.click('#brigade-create button');
  await A.waitForSelector('#brigade-mine:not(.hidden)');
  const code = (await A.textContent('#brigade-code')).trim();
  await closeSheet(A);
  await openTab(B, 'brigade');
  await B.fill('#brigade-join input', code);
  await B.click('#brigade-join button');
  await B.waitForSelector('#brigade-mine:not(.hidden)');
  check('brigade créée (tiroir mobile) et rejointe par code (bureau)', true, code);
  // Alice frappe UN bloc précis ; Bob doit la voir exactement à cet endroit, avec sa brigade.
  const aliceBlock = await sel(A);
  const aliceHits = await A.evaluate(() => window.tlb.state.me.hits);
  await A.tap('#mine-btn');
  await A.waitForFunction((h) => window.tlb.state.me.hits === h + 1, aliceHits);
  await B.waitForFunction(([id, blk]) => window.tlb.world.layers[1].markers.some((m) => m.playerId === id && m.block === blk), [idA, aliceBlock], { timeout: 5000 }).catch(() => {});
  const marker = await B.evaluate((id) => window.tlb.world.layers[1].markers.find((m) => m.playerId === id), idA);
  check('présence : le bureau voit Alice au bloc exact qu\'elle vient de frapper, avec sa brigade', marker?.block === aliceBlock && marker?.brigadeName === 'Les Foreurs', JSON.stringify({ attendu: aliceBlock, vu: marker?.block, brigade: marker?.brigadeName }));
  await B.evaluate(() => {
    window.tlb.world.camera.animateTo({ x: 2, y: 2 }, 0);
  });
  await B.click('#brigade-go');
  await B.waitForTimeout(800);
  const bc = await cam(B);
  const mx = marker.block % SIZE;
  const my = Math.floor(marker.block / SIZE);
  check('« Rejoindre ma brigade » amène la caméra près d\'Alice', Math.abs(bc.x - (mx + 0.5)) < 1.5 && Math.abs(bc.y - (my + 0.5)) < 1.5);
  await B.screenshot({ path: join(OUT, 'bureau-presence.png') });

  // 7. Panneau monumental.
  if (!(await A.evaluate(() => !!document.querySelector('#board-btn').offsetParent))) await A.tap('#cam-more');
  await A.tap('#board-btn');
  await A.waitForTimeout(900);
  const boardState = await A.evaluate(() => ({
    minY: window.tlb.world.camera.visibleWorld().minY,
    boardPx: window.tlb.world.billboardScreenWidth ?? null,
    banner: document.querySelector('#banner').hidden,
  }));
  const boardSeen = RENDU === 'monolithe' ? boardState.boardPx > 100 : boardState.minY < -5;
  check('« Regarder le panneau » : panneau à l\'écran, bandeau masqué (pas de doublon)', boardSeen && boardState.banner === true, JSON.stringify(boardState));
  await A.screenshot({ path: join(OUT, 'mobile-panneau.png') });
  await A.tap('#recenter');
  await A.waitForTimeout(700);
  check('Recentrer : retour au bloc sélectionné, bandeau réaffiché', !(await A.evaluate(() => document.querySelector('#banner').hidden)));

  // 8. Vue d'ensemble : fenêtre isométrique (classique) ou vue monumentale en scène (monolithe).
  await A.tap('#overview-btn');
  await A.waitForTimeout(RENDU === 'monolithe' ? 1200 : 400);
  if (RENDU === 'monolithe') {
    const mono = await A.evaluate(() => ({ t: window.tlb.world.camera.t, cls: document.querySelector('#viewport').classList.contains('monumental') }));
    await A.screenshot({ path: join(OUT, 'mobile-vue-monumentale.png') });
    // Finition : écran holographique entier, large et lisible ; ni bandeau ni mini-carte en double.
    const holo = await A.evaluate(() => {
      const w = window.tlb.world;
      const r = w.billboardRect;
      const map = getComputedStyle(document.querySelector('.map-box')).opacity;
      return { r, vw: w.camera.viewW, vh: w.camera.viewH, alpha: w.billboardAlpha, banner: document.querySelector('#banner').hidden, map };
    });
    const inView = holo.r && holo.r.x >= 0 && holo.r.y >= 0 && holo.r.x + holo.r.w <= holo.vw && holo.r.y + holo.r.h <= holo.vh;
    check(
      'vue monumentale : écran holographique entier, ≥ 55 % de la largeur, sans bandeau ni mini-carte',
      inView && holo.r.w >= holo.vw * 0.55 && holo.alpha > 0.95 && holo.banner && holo.map === '0',
      holo.r ? `${Math.round(holo.r.w)} px sur ${holo.vw}, x ${Math.round(holo.r.x)}–${Math.round(holo.r.x + holo.r.w)}, y ${Math.round(holo.r.y)}` : 'absent',
    );
    await A.tap('#overview-btn');
    await A.waitForTimeout(800);
    const back = await A.evaluate(() => window.tlb.world.camera.t);
    check('vue monumentale : aller (cube entier) et retour à la vue de minage', mono.t > 0.95 && mono.cls && back < 0.05, `t ${mono.t.toFixed(2)} → ${back.toFixed(2)}`);
  } else {
    const ovOpen = await A.evaluate(() => !document.querySelector('#overview').hidden);
    await A.screenshot({ path: join(OUT, 'mobile-vue-ensemble.png') });
    await A.tap('#overview-close');
    check("vue d'ensemble : ouverture et fermeture", ovOpen && (await A.evaluate(() => document.querySelector('#overview').hidden)));
  }

  // 9. Mise en page : aucun chevauchement à 360, 390, tablette et bureau (avec une notification affichée).
  const layouts = [
    ['360', { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
    ['390', { ...playwright.devices['iPhone 13'] }],
    ['tablette', { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
    ['bureau', { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 }],
    ['paysage', { viewport: { width: 740, height: 360 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
  ];
  for (const [name, opts] of layouts) {
    const ctx = await bMobile.newContext(opts);
    const p = await ctx.newPage();
    watch(p, name);
    await p.goto(`${BASE}/?${Q}&profil=mise-en-page-${name}`);
    await ready(p);
    await p.evaluate(() => document.querySelector('#overview-btn').click());
    await p.evaluate(() => document.querySelector('#overview-close').click());
    await p.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p' })));
    await p.waitForTimeout(700);
    await p.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', key: 'c' })));
    await p.waitForTimeout(700);
    await p.locator('#mine-btn').dispatchEvent('pointerdown');
    await p.waitForTimeout(300);
    await p.locator('#mine-btn').dispatchEvent('pointerup');
    await p.waitForTimeout(600);
    // Une notification réelle affichée pendant le contrôle : refus du serveur (pseudo déjà pris).
    await p.evaluate(() => window.tlb.socket.send({ t: 'setName', name: 'Alice' }));
    await p.waitForSelector('#toasts .toast', { timeout: 3000 });
    const toastShown = await p.locator('#toasts .toast').count();
    const bad = await overlaps(p);
    if (!toastShown) bad.push('notification absente pendant le contrôle');
    check(`mise en page ${name} : aucun chevauchement`, bad.length === 0, bad.join(', '));
    await p.screenshot({ path: join(OUT, `apres-${name}.png`) });
    await ctx.close();
  }

  // 10. Performances (Chromium sans affichage, CPU de la machine de test) : images pendant un lancer.
  const perf = await A.evaluate(async () => {
    const w = window.tlb.world;
    w.camera.animateTo({ zoom: w.camera.minZoom }, 0);
    w.camera.fling(-2500, -1500);
    w.requestRender();
    let frames = 0;
    const t0 = performance.now();
    await new Promise((r) => {
      const tick = () => {
        frames++;
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
        else r();
      };
      requestAnimationFrame(tick);
    });
    const draws = w.recentFrameTimes;
    const sorted = [...draws].sort((a, b) => a - b);
    return {
      fps: Math.round(frames / 1.5),
      drawAvgMs: +(draws.reduce((a, b) => a + b, 0) / draws.length).toFixed(2),
      drawP95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
      zoom: Math.round(w.camera.zoom),
    };
  });
  Object.assign(metrics, perf);
  check('performances : image dessinée en < 16 ms en moyenne au zoom minimal (toute la face)', perf.drawAvgMs < 16, JSON.stringify(perf));

  // 11. Arrêt brutal du serveur : reconnexion automatique, mêmes comptes, scores, brigade, caméra conservée.
  const before = await Promise.all([A, B].map((p) => p.evaluate(() => ({ hits: window.tlb.state.me.hits, id: window.tlb.state.player.id }))));
  const camBefore = await cam(B);
  server.kill('SIGKILL');
  await new Promise((r) => server.once('exit', r));
  await A.waitForFunction(() => document.querySelector('#conn-status').dataset.state !== 'online');
  await A.screenshot({ path: join(OUT, 'mobile-hors-ligne.png') });
  server = await startServer();
  await Promise.all([ready(A), ready(B)]);
  const after = await Promise.all([A, B].map((p) => p.evaluate(() => ({ hits: window.tlb.state.me.hits, id: window.tlb.state.player.id }))));
  const camAfter = await cam(B);
  check(
    'SIGKILL + redémarrage : mêmes comptes et scores, caméra conservée',
    JSON.stringify(before) === JSON.stringify(after) && Math.abs(camAfter.x - camBefore.x) < 0.01,
    after.map((x) => `${x.hits} coups`).join(' / '),
  );
  check('brigade conservée', (await B.evaluate(() => window.tlb.state.brigade?.name)) === 'Les Foreurs');

  // 12. Mouvement réduit : pas d'inertie, pas d'erreur.
  const ctxR = await bMobile.newContext({ ...playwright.devices['iPhone 13'], reducedMotion: 'reduce' });
  const R = await ctxR.newPage();
  watch(R, 'mouvement-réduit');
  await R.goto(`${BASE}/?${Q}&profil=reduit`);
  await ready(R);
  const TR = await touchApi(R);
  const rb = await R.locator('#world').boundingBox();
  await TR.drag(rb.x + 200, rb.y + 300, -150, 0, 6);
  const r1 = await cam(R);
  await R.waitForTimeout(500);
  const r2 = await cam(R);
  check('prefers-reduced-motion : aucune inertie après le glisser', Math.abs(r2.x - r1.x) < 0.001);
  await ctxR.close();

  // 13. Saisons : clôture puis nouvelle saison ; la surface repart d'un cube intact.
  const end = await fetch(`${BASE}/api/admin/season/end`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } });
  // Fin de saison : la cérémonie (docs/CEREMONIE.md) remplace l'ancien dialogue ; on passe au champion.
  await A.waitForFunction(() => !document.querySelector('#ceremony').hidden, null, { timeout: 5000 });
  await A.tap('#cer-next');
  await A.waitForFunction(() => document.querySelector('#ceremony').dataset.step === 'champion', null, { timeout: 3000 });
  const dialog = await A.evaluate(() => document.querySelector('#cer-kicker').textContent + ' : ' + document.querySelector('#cer-body .cer-name')?.textContent);
  check('fin de saison affichée (classement et champion conservés)', end.ok && /Champion de saison : (Alice|Mineur)/.test(dialog), dialog);
  await A.tap('#cer-skip');
  await A.waitForFunction(() => window.tlb.state.season && window.tlb.state.season.name === 'Saison 2' && window.tlb.state.cube.destroyedBlocks === 0, null, { timeout: 10000 });
  const s2 = await A.evaluate(() => ({ sel: window.tlb.state.selected, hp: window.tlb.state.cube.currentHp[window.tlb.state.selected] }));
  check('nouvelle saison : surface intacte, un bloc vivant présélectionné', s2.sel !== null && s2.hp > 0);
  await A.screenshot({ path: join(OUT, 'mobile-saison2.png') });

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
console.log(`\nMesures : ${JSON.stringify(metrics)}`);
console.log(`${results.length - failed}/${results.length} vérifications réussies. Captures : ${OUT}`);
process.exit(failed ? 1 : 0);
