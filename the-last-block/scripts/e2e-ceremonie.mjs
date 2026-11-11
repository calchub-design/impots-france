// Test réel de la cérémonie de fin de saison avec DEUX navigateurs Chromium
// distincts (téléphone tactile émulé + ordinateur), plus un navigateur en
// « animations réduites », un joueur qui se reconnecte pendant la cérémonie et un
// joueur qui revient après. Cadence de production (5 coups/s par compte).
//
//   npm run build && node scripts/e2e-ceremonie.mjs [--rendu monolithe|classique] [--out ./e2e-output] [--cpu 4]
//
// Saison 1 : cube de 4 couches de 4 × 4 blocs à 1 PV, quatre fragments (mini-48h).
// Règle de qualification de PRODUCTION (5 membres, valeur par défaut, non modifiée) :
// « Les Foreurs » (téléphone + ordinateur + 3 robots = 5 membres) et « Les Taupes »
// (4 robots, plus de coups mais non qualifiée). Des robots WebSocket préparent le
// cube et le téléphone détruit le dernier bloc. Saison 2 : ouverte puis clôturée par
// l'administration sans aucun coup.
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
const CPU = Number(arg('--cpu', '1'));
const Q = `rendu=${RENDU}`;
mkdirSync(OUT, { recursive: true });
console.log(`Cérémonie — rendu testé : ${RENDU}`);

const ADMIN = 'e2e-ceremonie-admin-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'tlb-e2e-ceremonie-'));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await new Promise((resolveStart, reject) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/server/server/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: join(dir, 'ceremonie.sqlite'),
      CUBE_SIZE: '4',
      BLOCK_BASE_HP: '1',
      BLOCK_HP_PER_LAYER: '0',
      DISCOVERY_PROFILE: 'mini-48h',
      SEASON_DURATION_HOURS: '720',
      SEASON_COOLDOWN_SECONDS: '3600',
      ADMIN_TOKEN: ADMIN,
      DONATION_DISPLAY_ENABLED: 'true',
      DONATION_ASSOCIATION_NAME: 'Association partenaire (exemple de test)',
      DONATION_ASSOCIATION_URL: 'https://example.org',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  p.stdout.on('data', (d) => d.toString().includes('serveur prêt') && resolveStart(p));
  p.once('exit', (c) => reject(new Error(`serveur arrêté (${c})`)));
});

/** Robot WebSocket réel qui mine jusqu'à ne laisser que `keep` blocs vivants dans tout le cube. */
async function bot(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const waiters = new Map();
  let cube;
  let brigade = null;
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  await new Promise((r) => {
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.t === 'welcome') {
        cube = m.cube;
        r();
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
    ws.send(JSON.stringify({ t: 'hello', v: 1, name }));
  });
  const waitBrigade = async () => {
    for (let i = 0; i < 50 && !brigade; i++) await sleep(50);
    return brigade;
  };
  return {
    async createBrigade(n) {
      ws.send(JSON.stringify({ t: 'brigadeCreate', name: n }));
      return (await waitBrigade()).inviteCode;
    },
    async joinBrigade(code) {
      ws.send(JSON.stringify({ t: 'brigadeJoin', code }));
      return waitBrigade();
    },
    async mineUntil(keep, offset) {
      for (;;) {
        if (!cube) return;
        const alive = cube.currentHp.map((h, i) => (h > 0 ? i : -1)).filter((i) => i >= 0);
        const total = alive.length + cube.layerRemaining.slice(cube.currentLayer + 1).reduce((s, n) => s + n, 0);
        if (total <= keep) return;
        const target = alive[(offset++ * 5) % alive.length];
        const actionId = randomUUID();
        await new Promise((r) => {
          waiters.set(actionId, r);
          ws.send(JSON.stringify({ t: 'mine', actionId, layer: cube.currentLayer, block: target }));
        });
        await sleep(210);
      }
    },
    close: () => ws.close(),
  };
}

const ready = (p) =>
  p.waitForFunction(() => window.tlb?.state.player && document.querySelector('#conn-status').dataset.state === 'online', null, { timeout: 15000 });
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(`${who}: ${m.text()}`);
  });
};
const cer = (p) =>
  p.evaluate(() => {
    const root = document.querySelector('#ceremony');
    return {
      visible: !root.hidden,
      step: root.hidden ? null : root.dataset.step,
      kicker: document.querySelector('#cer-kicker').textContent,
      body: [...document.querySelector('#cer-body').querySelectorAll('*')].filter((e) => !e.children.length).map((e) => e.textContent).join('\n'),
      still: root.classList.contains('still'),
      pulse: getComputedStyle(document.querySelector('.cer-pulse')).display,
    };
  });
async function nextStep(p, touch) {
  if (touch) await p.tap('#cer-next');
  else await p.click('#cer-next');
  await sleep(1700); // fin des apparitions du moment (≤ 1,45 s)
}

const browsers = [];
const bots = [];
try {
  const bMobile = await playwright.chromium.launch();
  const bDesktop = await playwright.chromium.launch();
  browsers.push(bMobile, bDesktop);
  const ctxA = await bMobile.newContext({ ...playwright.devices['iPhone 13'] });
  const ctxB = await bDesktop.newContext({ viewport: { width: 1280, height: 860 } });
  const ctxR = await bMobile.newContext({ ...playwright.devices['iPhone 13'], reducedMotion: 'reduce' });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const R = await ctxR.newPage();
  watch(A, 'mobile');
  watch(B, 'bureau');
  watch(R, 'réduit');
  for (const [p, n] of [[A, 'mobile'], [B, 'bureau'], [R, 'reduit']]) {
    await p.goto(`${BASE}/?${Q}&profil=ceremonie-${n}`);
    await ready(p);
  }

  // 1. « Les Foreurs » : créée sur le téléphone, rejointe par l'ordinateur (puis par 3 robots).
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

  // 2. L'ordinateur donne un coup ; des robots préparent le cube jusqu'au dernier bloc.
  await B.evaluate(() => {
    window.tlb.state.selected = window.tlb.state.cube.currentHp.findIndex((h) => h > 0);
  });
  await B.click('#mine-btn');
  await B.waitForFunction(() => window.tlb.state.me.hits === 1, null, { timeout: 5000 });
  const foreurs = [];
  for (const n of ['Robot-Un', 'Robot-Deux', 'Robot-Trois']) {
    const b = await bot(n);
    await b.joinBrigade(code);
    foreurs.push(b);
  }
  const taupes = [];
  for (const n of ['Taupe-1', 'Taupe-2', 'Taupe-3', 'Taupe-4']) taupes.push(await bot(n));
  const taupesCode = await taupes[0].createBrigade('Les Taupes');
  for (const t of taupes.slice(1)) await t.joinBrigade(taupesCode);
  bots.push(...foreurs, ...taupes);
  await B.waitForFunction(() => window.tlb.state.brigade?.members.length === 5, null, { timeout: 5000 });
  // Les Taupes (4 membres) minent davantage, puis les robots des Foreurs ; un seul descend au dernier bloc.
  await Promise.all(taupes.map((b, i) => b.mineUntil(28, i)));
  await Promise.all(foreurs.map((b, i) => b.mineUntil(6, i)));
  await sleep(400);
  await foreurs[0].mineUntil(1, 0);
  const boardBefore = await B.evaluate(() => window.tlb.state.brigades.map((b) => ({ name: b.name, members: b.members, eligible: b.eligible, hits: b.hits })));
  // Notifications : enregistrées avec l'état de la cérémonie au moment où elles apparaissent.
  await A.evaluate(() => {
    window.__toasts = [];
    new MutationObserver((ms) =>
      ms.forEach((m) => m.addedNodes.forEach((n) => window.__toasts.push({ text: n.textContent, during: !document.querySelector('#ceremony').hidden }))),
    ).observe(document.querySelector('#toasts'), { childList: true });
  });
  await A.waitForFunction(() => {
    const c = window.tlb.state.cube;
    return c && c.currentLayer === c.size - 1 && c.layerRemaining[c.currentLayer] === 1;
  }, null, { timeout: 15000 });

  // 3. Le téléphone détruit le dernier bloc (toucher → Miner) : clôture décidée par le serveur.
  await A.evaluate(() => {
    window.tlb.state.selected = window.tlb.state.cube.currentHp.findIndex((h) => h > 0);
  });
  const cdpA = await ctxA.newCDPSession(A);
  if (CPU > 1) await cdpA.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await A.tap('#mine-btn');
  await Promise.all([A, B, R].map((p) => p.waitForFunction(() => !document.querySelector('#ceremony').hidden, null, { timeout: 8000 })));
  const perf = await A.evaluate(
    () =>
      new Promise((r) => {
        let n = 0;
        let worst = 0;
        let last = performance.now();
        const t0 = last;
        const f = () => {
          const now = performance.now();
          worst = Math.max(worst, now - last);
          last = now;
          if (now - t0 < 2000) {
            n++;
            requestAnimationFrame(f);
          } else r({ fps: Math.round(n / 2), worstMs: Math.round(worst) });
        };
        requestAnimationFrame(f);
      }),
  );
  if (CPU > 1) await cdpA.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  metrics.cpu = CPU;
  metrics.fpsCeremonie = perf.fps;
  metrics.pireImageMs = perf.worstMs;
  const [ca, cb] = [await cer(A), await cer(B)];
  check(
    'séquence A sur les deux navigateurs : « SAISON TERMINÉE — TRANSMISSION EN COURS », minage suspendu',
    ca.step === 'silence' && cb.step === 'silence' && ca.body.includes('SAISON TERMINÉE — TRANSMISSION EN COURS') && (await A.evaluate(() => document.querySelector('#mine-btn').disabled)),
    `${ca.kicker} · ${perf.fps} img/s`,
  );
  await A.screenshot({ path: join(OUT, `ceremonie-a-silence-mobile-${RENDU}.png`) });
  const arc = await B.evaluate(() => fetch('/api/hall').then((r) => r.json()).then((d) => d.seasons[0]));
  check('archive : champion, brigade championne, Pierre finale, 4 fragments', !!arc.champion && arc.championBrigade?.name === 'Les Foreurs' && !!arc.finalStone && arc.discoveries.length === 4, `${arc.champion?.name} · ${arc.finalStone?.name}`);
  const taupesB = boardBefore.find((b) => b.name === 'Les Taupes');
  const foreursB = boardBefore.find((b) => b.name === 'Les Foreurs');
  check(
    'règle de production (5 membres) : « Les Taupes » (4 membres, plus de coups) non qualifiée ; « Les Foreurs » (5 membres) championne',
    taupesB.members === 4 && !taupesB.eligible && taupesB.hits > foreursB.hits && foreursB.members === 5 && foreursB.eligible && arc.brigadeMinSize === 5 && arc.championBrigade.members === 5,
    `Taupes ${taupesB.hits} coups / ${taupesB.members} membres · Foreurs ${foreursB.hits} coups / ${foreursB.members} membres`,
  );
  const toastsDuring = await A.evaluate(() => document.querySelectorAll('#toasts .toast').length);
  check('aucune notification affichée par-dessus la cérémonie', toastsDuring === 0);
  const line390 = await A.evaluate(() => {
    const e = document.querySelector('.season-line');
    return { text: e.textContent, fits: e.scrollWidth <= e.clientWidth + 1 };
  });
  check('intersaison : compte à rebours lisible en entier sur téléphone (390 px)', line390.fits && /Intersaison · reprise \d/.test(line390.text), line390.text);
  const stoneName = await A.evaluate(() => window.tlb.state.player.name);
  check('Pierre finale attribuée à l\'auteur du dernier bloc (le téléphone)', arc.finalStone.name === stoneName, stoneName);
  const R0 = await cer(R);
  check('animations réduites : pas d\'impulsion ni d\'animation', R0.still && R0.pulse === 'none');
  await R.screenshot({ path: join(OUT, `ceremonie-reduit-mobile-${RENDU}.png`) });

  // 4. Synchronisation : sans intervention, les deux navigateurs passent ensemble au champion.
  await B.waitForFunction(() => document.querySelector('#ceremony').dataset.step === 'champion', null, { timeout: 9000 });
  await sleep(1700);
  const [sa, sb] = [await cer(A), await cer(B)];
  check('synchronisation sur l\'horloge serveur : même moment sur les deux navigateurs', sa.step === 'champion' && sb.step === 'champion');
  check(
    'séquence B : champion (pseudo, rang final, contribution, titre)',
    sb.kicker === 'Champion de saison' && sb.body.includes(arc.champion.name) && sb.body.includes('Rang final : 1') && sb.body.includes(`${arc.champion.hits} coups`),
    sb.body.split('\n')[0],
  );
  await A.screenshot({ path: join(OUT, `ceremonie-b-champion-mobile-${RENDU}.png`) });
  await B.screenshot({ path: join(OUT, `ceremonie-b-champion-bureau-${RENDU}.png`) });

  // 5. Reconnexion pendant la cérémonie : on reprend au même moment que les autres.
  const ctxC = await bDesktop.newContext({ viewport: { width: 1280, height: 860 } });
  const C = await ctxC.newPage();
  watch(C, 'reconnexion');
  await C.goto(`${BASE}/?${Q}&profil=ceremonie-reconnexion`);
  await ready(C);
  await C.waitForFunction(() => !document.querySelector('#ceremony').hidden, null, { timeout: 5000 }).catch(() => {});
  const [sc, sb2] = [await cer(C), await cer(B)];
  check('connexion pendant la cérémonie : rejointe au même moment', sc.visible && sc.step === sb2.step, `${sc.step} / ${sb2.step}`);

  // 6. Navigation jamais bloquée : le menu s'ouvre pendant la cérémonie.
  await A.tap('#menu-btn');
  const menuOpen = await A.evaluate(() => document.querySelector('#panel').classList.contains('open'));
  await A.tap('#panel-close');
  check('navigation non bloquée : le menu s\'ouvre pendant la cérémonie', menuOpen);

  // 7. Téléphone : moments suivants avec « Suivant ».
  await nextStep(A, true);
  const sBrig = await cer(A);
  check('séquence C : brigade championne (nom, emblème, contribution, membres)', sBrig.step === 'brigade' && sBrig.body.includes('Les Foreurs') && sBrig.body.includes('5 membres') && sBrig.body.includes(`${arc.championBrigade.hits} coups`), sBrig.body.replace(/\n/g, ' · '));
  await A.screenshot({ path: join(OUT, `ceremonie-c-brigade-mobile-${RENDU}.png`) });
  await nextStep(A, true);
  const sStone = await cer(A);
  check('séquence D : Pierre finale à l\'honneur, hors championnat', sStone.step === 'stone' && sStone.body.includes(stoneName) && sStone.body.includes('indépendante du championnat'));
  await A.screenshot({ path: join(OUT, `ceremonie-d-pierre-mobile-${RENDU}.png`) });
  await nextStep(A, true);
  const sSec = await cer(A);
  check('séquence E : fragments réellement révélés (4 / 4)', sSec.step === 'secrets' && sSec.body.includes('4 / 4') && arc.discoveries.every((d) => sSec.body.includes(d.title)));
  await A.screenshot({ path: join(OUT, `ceremonie-e-secrets-mobile-${RENDU}.png`) });
  await nextStep(A, true);
  const sCause = await cer(A);
  check(
    'séquence F : cause de la saison, « Montant du don à confirmer », pas une récompense du champion',
    sCause.step === 'cause' && sCause.body.includes('Montant du don à confirmer') && sCause.body.includes('ni un gain ni une récompense du champion') && sCause.body.includes('Association partenaire (exemple de test)'),
  );
  await A.screenshot({ path: join(OUT, `ceremonie-f-cause-mobile-${RENDU}.png`) });
  await B.waitForFunction(() => document.querySelector('#ceremony').dataset.step === 'secrets', null, { timeout: 25000 }).catch(() => {});
  await sleep(1700);
  await B.screenshot({ path: join(OUT, `ceremonie-e-secrets-bureau-${RENDU}.png`) });

  // 8. « Passer » ferme la cérémonie ; « Revoir » depuis le Hall des champions la relance sans rien changer.
  await B.click('#cer-skip');
  check('« Passer » ferme la cérémonie', !(await cer(B)).visible);
  await B.click('.tabs button[data-tab="seasons"]');
  await B.waitForFunction(() => document.querySelectorAll('#hall-list .hall-card').length === 1, null, { timeout: 5000 });
  const card = await B.evaluate(() => document.querySelector('#hall-list .hall-card').innerText);
  check(
    'Hall des champions : saison, dates, champion, brigade, Pierre finale, contribution, découvertes, distinctions',
    ['Saison 1', 'du ', arc.champion.name, 'Les Foreurs', stoneName, 'Contribution totale', 'Découvertes : 4 / 4', 'Champion de saison', 'Montant du don à confirmer'].every((t) => card.includes(t)),
  );
  await B.screenshot({ path: join(OUT, `hall-bureau-${RENDU}.png`) });
  const hallBefore = await B.evaluate(() => fetch('/api/hall').then((r) => r.text()));
  await B.click('#hall-list .hall-card button');
  const replay = await cer(B);
  check('« Revoir la cérémonie » : relancée depuis le début', replay.visible && replay.step === 'silence');
  await B.click('#cer-skip');
  check('revoir ne modifie rien (archive identique)', (await B.evaluate(() => fetch('/api/hall').then((r) => r.text()))) === hallBefore);

  // Notifications retenues pendant la cérémonie : affichées après sa fermeture.
  await A.waitForFunction(() => document.querySelector('#ceremony').hidden, null, { timeout: 45000 });
  await sleep(300);
  const seen = await A.evaluate(() => window.__toasts);
  check(
    'notification de mission reportée après la cérémonie, jamais pendant',
    seen.length > 0 && seen.every((t) => !t.during) && seen.some((t) => t.text.includes('Mission accomplie')),
    seen.map((t) => t.text).join(' | ').slice(0, 120),
  );

  // 9. Joueur qui revient APRÈS la fin (la cérémonie dure 41 s) : résultats proposés une fois depuis le début.
  await A.waitForFunction(() => document.querySelector('#ceremony').hidden, null, { timeout: 45000 });
  const wait = arc.closedAt + 42_500 - Date.now();
  if (wait > 0) await sleep(wait);
  const ctxF = await bMobile.newContext({ ...playwright.devices['iPhone 13'] });
  const F = await ctxF.newPage();
  watch(F, 'retour');
  await F.goto(`${BASE}/?${Q}&profil=ceremonie-retour`);
  await ready(F);
  await F.waitForFunction(() => !document.querySelector('#ceremony').hidden, null, { timeout: 5000 }).catch(() => {});
  const f1 = await cer(F);
  await F.tap('#cer-skip');
  await F.reload();
  await ready(F);
  await sleep(600);
  const f2 = await cer(F);
  check('joueur qui revient après la fin : cérémonie proposée depuis le début, une seule fois', f1.visible && f1.step === 'silence' && !f2.visible, JSON.stringify({ f1: [f1.visible, f1.step], f2: [f2.visible, f2.step], seen: await F.evaluate(() => localStorage.getItem('tlb.ceremony.seen')) }));
  await F.tap('#menu-btn');
  await F.tap('.tabs button[data-tab="seasons"]');
  await sleep(500);
  await F.screenshot({ path: join(OUT, `hall-mobile-${RENDU}.png`) });

  // 10. Saison 2 ouverte puis clôturée par l'administration, sans aucun coup.
  const admin = (path, body = {}) => fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await admin('/api/admin/season/start', { name: 'Saison 2', cubeSize: 4 });
  await B.waitForFunction(() => window.tlb.state.season?.name === 'Saison 2', null, { timeout: 5000 });
  await admin('/api/admin/season/end');
  await B.waitForFunction(() => !document.querySelector('#ceremony').hidden, null, { timeout: 5000 });
  const s2 = [];
  for (let i = 0; i < 6; i++) {
    s2.push(await cer(B));
    if (i < 5) await nextStep(B, false);
  }
  check(
    'clôture administrative sans contribution : aucun champion, aucune brigade, aucune Pierre finale, aucun fragment inventé',
    s2[0].kicker.includes('clôture par l\'organisation') && s2[1].body.includes('aucun champion') && s2[2].body.includes('Aucune brigade qualifiée') && s2[3].body.includes('Aucune Pierre finale') && s2[4].body.includes('Aucun fragment n\'a été révélé'),
    s2.map((x) => x.step).join(' → '),
  );
  await B.screenshot({ path: join(OUT, `ceremonie-admin-bureau-${RENDU}.png`) });
  await B.click('#cer-skip');
  const hall2 = await B.evaluate(() => fetch('/api/hall').then((r) => r.json()));
  const ctx360 = await bMobile.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const P360 = await ctx360.newPage();
  watch(P360, '360');
  await P360.addInitScript(() => localStorage.setItem('tlb.ceremony.seen', '999'));
  await P360.goto(`${BASE}/?${Q}&profil=ceremonie-360`);
  await ready(P360);
  await P360.evaluate(() => document.querySelector('#cer-skip')?.click());
  await sleep(700);
  const line360 = await P360.evaluate(() => {
    const e = document.querySelector('.season-line');
    return { text: e.textContent, fits: e.scrollWidth <= e.clientWidth + 1 };
  });
  check('intersaison : compte à rebours lisible en entier sur téléphone (360 px)', line360.fits, line360.text);
  await P360.screenshot({ path: join(OUT, `intersaison-360-${RENDU}.png`) });
  const mapGone = await P360.evaluate(() => getComputedStyle(document.querySelector('.map-box')).opacity === '0');
  check('intersaison : la mini-carte vide est masquée', mapGone);
  check('Hall : deux saisons, la première inchangée', hall2.seasons.length === 2 && JSON.stringify(hall2.seasons[1]) === JSON.stringify(JSON.parse(hallBefore).seasons[0]));
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
console.log(`\nMesures : ${JSON.stringify(metrics)}`);
console.log(`${ok}/${results.length} vérifications réussies. Captures : ${OUT}`);
process.exit(ok === results.length ? 0 : 1);
