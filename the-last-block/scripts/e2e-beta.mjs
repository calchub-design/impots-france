// Test réel de la préparation de la bêta privée, avec des navigateurs Chromium distincts :
// téléphone Android émulé (Pixel 7), iPhone émulé (iPhone 13, moteur Chromium et non
// WebKit/Safari) et un ordinateur « robot de test ».
//
//   npm run build && node scripts/e2e-beta.mjs [--rendu monolithe|classique] [--out ./e2e-output]
//
// Vérifie : refus de démarrage d'une configuration de bêta dangereuse, écran d'invitation,
// lien d'invitation, compte de test exclu des statistiques, minage continu (mémoire),
// pause d'urgence, coupure et redémarrage du serveur (même base), API protégées,
// sauvegarde à chaud, absence de secrets dans le client.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
console.log(`Bêta privée — rendu testé : ${RENDU}`);

// Secrets du test uniquement (jamais réutilisés ailleurs).
const ADMIN = `e2e-admin-${Math.random().toString(36).slice(2)}-${'x'.repeat(24)}`;
const SECRET = `e2e-pseudo-${Math.random().toString(36).slice(2)}-${'y'.repeat(24)}`;
const dir = mkdtempSync(join(tmpdir(), 'tlb-e2e-beta-'));
const freePort = () =>
  new Promise((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const results = [];
const errors = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
};

/** Lance le serveur compilé ; résout au message « serveur prêt », rejette s'il s'arrête avant. */
function startServer(env, { expectFailure = false } = {}) {
  return new Promise((resolveStart, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/server/server/index.js'], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      if (!expectFailure && d.toString().includes('serveur prêt')) resolveStart({ proc: p, out: () => out });
    });
    p.stderr.on('data', (d) => (out += d));
    p.once('exit', (c) => (expectFailure ? resolveStart({ code: c, out: () => out }) : reject(new Error(`serveur arrêté (${c}) : ${out}`))));
  });
}
const stopServer = (s) =>
  new Promise((r) => {
    if (s.proc.exitCode !== null) return r();
    s.proc.once('exit', () => r());
    s.proc.kill('SIGTERM');
  });

// 0. Démarrage en mode bêta : une configuration dangereuse est refusée d'emblée.
{
  const bad = await startServer({ BETA_MODE: 'true', PORT: String(await freePort()), DB_PATH: join(dir, 'refus.sqlite') }, { expectFailure: true });
  check('BETA_MODE : configuration incomplète refusée au démarrage', bad.code !== 0 && /ACCESS_MODE/.test(bad.out()) && /ADMIN_TOKEN/.test(bad.out()), `code ${bad.code}`);
  const okPort = await freePort();
  const good = await startServer({
    BETA_MODE: 'true',
    ACCESS_MODE: 'invite',
    ADMIN_TOKEN: ADMIN,
    STATS_PSEUDONYM_SECRET: SECRET,
    DB_PATH: join(dir, 'beta-valide.sqlite'),
    ALLOWED_ORIGINS: 'https://beta.example.org',
    DISCOVERY_PROFILE: 'mini-48h',
    SEASON_DURATION_HOURS: '48',
    AUTO_START_SEASON: 'false',
    HOST: '127.0.0.1',
    PORT: String(okPort),
    TRUST_PROXY: 'true',
  });
  const health = await (await fetch(`http://127.0.0.1:${okPort}/api/health`)).json();
  check('BETA_MODE : configuration complète acceptée, santé « ok »', health.ok === true && health.db === 'ok' && /bêta/i.test(good.out()), JSON.stringify(health));
  const page = await fetch(`http://127.0.0.1:${okPort}/api/hall`);
  check('BETA_MODE : API de lecture fermée sans jeton de joueur', page.status === 401);
  await stopServer(good);
}

// Serveur de la suite : accès sur invitation, limites de production (5 coups/s, 4 h/jour,
// brigade de 5), profil mini-48h. Origine http locale : BETA_MODE n'est pas activé ici
// (il exige des origines https), ACCESS_MODE=invite suffit pour tester le parcours.
const DB = join(dir, 'beta.sqlite');
const SERVER_ENV = {
  PORT: String(port),
  HOST: '127.0.0.1',
  DB_PATH: DB,
  ACCESS_MODE: 'invite',
  ADMIN_TOKEN: ADMIN,
  STATS_PSEUDONYM_SECRET: SECRET,
  BACKUP_DIR: join(dir, 'sauvegardes'),
  CUBE_SIZE: '8',
  BLOCK_BASE_HP: '20',
  BLOCK_HP_PER_LAYER: '0',
  DISCOVERY_PROFILE: 'mini-48h',
  SEASON_DURATION_HOURS: '48',
  AUTO_START_SEASON: 'false',
};
let server = await startServer(SERVER_ENV);
const admin = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
};
const started = await admin('/api/admin/season/start', { name: 'Bêta 48 h (e2e)' });
check('saison de 48 h démarrée par l\'administration, profil mini-48h', started.season?.endsAt - started.season?.startsAt === 48 * 3600_000 && started.discoveries?.fragments?.length === 4, started.season?.name);
const [{ code: CODE_A }] = (await admin('/api/admin/invites', { label: 'Brigade A', maxUses: 2 })).invites;
const [{ code: CODE_TEST }] = (await admin('/api/admin/invites', { label: 'Robot e2e', kind: 'test' })).invites;

const ready = (p) =>
  p.waitForFunction(() => window.tlb?.state.player && window.tlb.state.cube && document.querySelector('#conn-status').dataset.state === 'online', null, { timeout: 15000 });
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource|401/.test(m.text())) errors.push(`${who}: ${m.text()}`);
  });
};
const heapMb = async (cdp) => {
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'JSHeapUsedSize').value / 1048576;
};

const browsers = [];
try {
  const bAndroid = await playwright.chromium.launch();
  const bIphone = await playwright.chromium.launch();
  const bRobot = await playwright.chromium.launch();
  browsers.push(bAndroid, bIphone, bRobot);
  const ctxA = await bAndroid.newContext({ ...playwright.devices['Pixel 7'] });
  const ctxI = await bIphone.newContext({ ...playwright.devices['iPhone 13'] });
  const ctxR = await bRobot.newContext({ viewport: { width: 1280, height: 860 } });
  const A = await ctxA.newPage();
  const I = await ctxI.newPage();
  const R = await ctxR.newPage();
  watch(A, 'android');
  watch(I, 'iphone');
  watch(R, 'robot');

  // 1. Sans invitation : écran d'invitation, aucun compte créé.
  await A.goto(`${BASE}/?${Q}&profil=beta-android`);
  await A.waitForFunction(() => document.querySelector('#conn-status').dataset.state === 'invite', null, { timeout: 15000 });
  const gate = await A.evaluate(() => ({
    visible: !document.querySelector('#invite-gate').hidden,
    label: document.querySelector('#conn-status .label').textContent,
    fontPx: parseFloat(getComputedStyle(document.querySelector('#invite-input')).fontSize),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  check('Android : écran d\'invitation affiché, statut « Invitation requise »', gate.visible && gate.label === 'Invitation requise', gate.label);
  check('champ du code ≥ 16 px (pas de zoom automatique à la saisie sur iPhone)', gate.fontPx >= 16, `${gate.fontPx} px`);
  check('écran d\'invitation sans défilement horizontal', !gate.overflow);
  await A.screenshot({ path: join(OUT, `beta-invitation-android-${RENDU}.png`) });
  check('aucun compte créé sans invitation', (await admin('/api/admin/beta/summary')).participants.registered === 0);

  // 2. Mauvais code, puis bon code saisi au doigt.
  await A.tap('#invite-input');
  await A.fill('#invite-input', 'TLB-ZZZZ-ZZZ2');
  await A.tap('#invite-form button[type=submit]');
  await A.waitForFunction(() => document.querySelector('#invite-error').textContent.length > 0, null, { timeout: 10000 });
  check('code faux : message clair, écran maintenu', await A.evaluate(() => !document.querySelector('#invite-gate').hidden && document.querySelector('#invite-error').textContent), await A.textContent('#invite-error'));
  await A.fill('#invite-input', CODE_A.toLowerCase().replace(/-/g, ' '));
  await A.tap('#invite-form button[type=submit]');
  await ready(A);
  const idA = await A.evaluate(() => window.tlb.state.player.id);
  check('code valide (minuscules, espaces) : compte créé, écran fermé', await A.evaluate(() => document.querySelector('#invite-gate').hidden));

  // 3. iPhone : lien d'invitation, retiré de la barre d'adresse.
  await I.goto(`${BASE}/?${Q}&profil=beta-iphone&invitation=${CODE_A}`);
  await ready(I);
  check('iPhone : connexion directe par lien d\'invitation', !!(await I.evaluate(() => window.tlb.state.player.id)));
  check('le code ne reste pas dans l\'adresse', !I.url().includes('invitation'), I.url());
  check('invitation à 2 utilisations épuisée', (await admin('/api/admin/invites')).invites.find((i) => i.label === 'Brigade A').uses === 2);

  // 4. Robot de test : invitation « test », exclu des statistiques.
  await R.goto(`${BASE}/?${Q}&profil=beta-robot&invitation=${CODE_TEST}`);
  await ready(R);
  const sum1 = await admin('/api/admin/beta/summary');
  check('robot de test séparé des joueurs réels dans les statistiques', sum1.participants.registered === 2 && sum1.participants.testAccountsExcluded === 1, JSON.stringify(sum1.participants));

  // 5. Minage continu au doigt (bouton maintenu) sur Android, mémoire mesurée.
  const cdp = await ctxA.newCDPSession(A);
  await cdp.send('Performance.enable');
  const heap0 = await heapMb(cdp);
  const box = await A.locator('#mine-btn').boundingBox();
  const hits0 = await A.evaluate(() => window.tlb.state.me.hits);
  await A.dispatchEvent('#mine-btn', 'pointerdown', { pointerType: 'touch', clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
  await A.waitForTimeout(20_000);
  await A.dispatchEvent('#mine-btn', 'pointerup', { pointerType: 'touch' });
  await A.waitForTimeout(1500);
  const hits1 = await A.evaluate(() => window.tlb.state.me.hits);
  const heap1 = await heapMb(cdp);
  check('minage continu : ~4,5 coups/s acceptés pendant 20 s', hits1 - hits0 >= 70 && hits1 - hits0 <= 101, `${hits1 - hits0} coups`);
  check('mémoire JS stable pendant le minage continu (< 15 Mo de plus)', heap1 - heap0 < 15, `${heap0.toFixed(1)} → ${heap1.toFixed(1)} Mo`);

  // 6. Pause d'urgence : diffusée, minage suspendu, message lisible, persiste au rechargement.
  await admin('/api/admin/pause', { message: 'Retour prévu dans 10 minutes, merci de votre patience.' });
  await I.waitForFunction(() => window.tlb.state.pause !== null, null, { timeout: 5000 });
  const p1 = await I.evaluate(() => ({ disabled: document.querySelector('#mine-btn').disabled, hint: document.querySelector('#mine-hint').textContent, msg: window.tlb.world.state.message }));
  check('pause : bouton Miner désactivé et message de maintenance sur la scène', p1.disabled && /Maintenance/.test(p1.msg ?? ''), `${p1.hint} | ${p1.msg}`);
  await I.screenshot({ path: join(OUT, `beta-maintenance-iphone-${RENDU}.png`) });
  await I.reload();
  await ready(I);
  check('pause : toujours affichée après rechargement', await I.evaluate(() => window.tlb.state.pause !== null && document.querySelector('#mine-btn').disabled));
  await admin('/api/admin/pause', { message: null });
  await I.waitForFunction(() => window.tlb.state.pause === null && !document.querySelector('#mine-btn').disabled, null, { timeout: 5000 });
  check('pause levée : minage de nouveau possible', true);

  // 7. Incident : arrêt du serveur, message d'indisponibilité, redémarrage sur la même base.
  const hitsBefore = await A.evaluate(() => window.tlb.state.me.hits);
  await stopServer(server);
  await A.waitForFunction(() => document.querySelector('#conn-status .label').textContent === 'Serveur indisponible', null, { timeout: 40_000 });
  await A.waitForTimeout(4000); // plusieurs nouvelles tentatives : le message ne doit pas clignoter
  const down = await A.evaluate(() => ({ label: document.querySelector('#conn-status .label').textContent, msg: window.tlb.world.state.message, disabled: document.querySelector('#mine-btn').disabled, hint: document.querySelector('#mine-hint').textContent }));
  check('serveur arrêté : « Serveur indisponible » et message clair sur la scène', down.label === 'Serveur indisponible' && /indisponible/.test(down.msg ?? ''), `${down.label} | ${down.msg}`);
  check('serveur arrêté : bouton Miner désactivé avec explication', down.disabled && /indisponible/.test(down.hint), down.hint);
  await A.screenshot({ path: join(OUT, `beta-indisponible-android-${RENDU}.png`) });
  server = await startServer(SERVER_ENV);
  await ready(A);
  await ready(I);
  const after = await A.evaluate(() => ({ id: window.tlb.state.player.id, hits: window.tlb.state.me.hits }));
  check('redémarrage : reconnexion automatique, même compte, coups conservés', after.id === idA && after.hits === hitsBefore, `${after.hits} coups`);

  // 8. Statistiques : sessions, coups, export pseudonymisé.
  const sum2 = await admin('/api/admin/beta/summary');
  check('statistiques : sessions enregistrées et coups acceptés comptés', sum2.sessions.count >= 3 && sum2.hitsCounters.accepted >= hits1 - hits0, `${sum2.sessions.count} sessions, ${sum2.hitsCounters.accepted} coups`);
  const csv = await admin('/api/admin/beta/export?table=players');
  const names = await Promise.all([A, I].map((p) => p.evaluate(() => window.tlb.state.player.name)));
  check('export CSV sans pseudo ni identifiant', !names.some((n) => n && csv.includes(n)) && !csv.includes(idA) && csv.trim().split('\n').length === 3, `${csv.trim().split('\n').length - 1} joueurs réels`);

  // 9. API de lecture : le client envoie son jeton, un tiers sans jeton est refusé.
  const inPage = await A.evaluate(async () => (await fetch('/api/hall', { headers: { 'x-tlb-token': window.tlb.socket.token } })).status);
  check('API protégées : 401 sans jeton, 200 avec le jeton du joueur', (await fetch(`${BASE}/api/hall`)).status === 401 && inPage === 200);
  check('/api/stats réservé à l\'administration en mode invitation', (await fetch(`${BASE}/api/stats`)).status === 401);

  // 10. Sauvegarde à chaud pendant que les joueurs sont connectés.
  const bk = await admin('/api/admin/backup', {});
  check('sauvegarde à chaud vérifiée (intégrité « ok »)', bk.backup?.check?.integrity === 'ok' && bk.backup.check.hits >= hits1 - hits0, bk.backup?.file);

  // 11. Aucun secret d'administration dans le client.
  const assets = readdirSync('dist/client/assets').map((f) => readFileSync(join('dist/client/assets', f), 'utf8')).join('\n');
  const html = await (await fetch(`${BASE}/`)).text();
  const seen = JSON.stringify(await Promise.all([A, I, R].map((p) => p.evaluate(() => ({ ls: { ...localStorage }, state: window.tlb.state })))));
  check('aucun secret ni route d\'administration dans le client ou son stockage', ![assets, html, seen].some((t) => t.includes(ADMIN) || t.includes(SECRET)) && !assets.includes('/api/admin'));

  check('aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('déroulé du scénario', false, e.message);
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  await stopServer(server).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} vérifications réussies (rendu ${RENDU}).`);
process.exit(failed.length ? 1 : 0);
