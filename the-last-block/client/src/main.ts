import './style.css';
import type {
  BrigadeBoardEntry,
  BrigadeInfo,
  CubeSnapshot,
  LeaderboardEntry,
  MineRejectReason,
  MyStats,
  PlaytimeInfo,
  PublicPlayer,
  PresenceEntry,
  SeasonInfo,
  SeasonProjection,
  ServerMessage,
} from '../../shared/protocol.js';
import { PRESENCE_WINDOW_MS } from '../../shared/protocol.js';
import { SKINS, skinById } from '../../shared/skins.js';
import { GameSocket, type ConnState } from './net.js';
import { Scene } from './scene.js';
import { TILT } from './world/camera.js';
import { nearestAlive, toXY, type FaceData } from './world/face.js';
import { BillboardLayer, billboardCameraY } from './world/billboard.js';
import { Minimap } from './world/minimap.js';
import { brigadeColor, groupByBlock, PresenceLayer, presenceAge, type PresenceMarker } from './world/presence.js';
import { MonolithView } from './world/monolith/view.js';
import { SurfaceView } from './world/surface.js';
import type { PointerKind } from './world/gestures.js';
import type { WorldView } from './world/view.js';
import { layerColor, scale } from './world/monolith/material.js';

// ---------------------------------------------------------------------------
// État client (toujours dérivé des messages du serveur)
// ---------------------------------------------------------------------------

interface State {
  player: PublicPlayer | null;
  season: SeasonInfo | null;
  nextSeasonAt: number | null;
  cube: CubeSnapshot | null;
  seq: number;
  leaderboard: LeaderboardEntry[];
  brigades: BrigadeBoardEntry[];
  me: MyStats;
  playtime: PlaytimeInfo | null;
  brigade: BrigadeInfo | null;
  online: number;
  clockOffset: number;
  selected: number | null;
  projection: SeasonProjection | null;
  lastEnded: SeasonInfo | null;
}

const state: State = {
  player: null,
  season: null,
  nextSeasonAt: null,
  cube: null,
  seq: 0,
  leaderboard: [],
  brigades: [],
  me: { hits: 0, blocks: 0, rank: null },
  playtime: null,
  brigade: null,
  online: 0,
  clockOffset: 0,
  selected: null,
  projection: null,
  lastEnded: null,
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const serverNow = () => Date.now() + state.clockOffset;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...children: (Node | string)[]) {
  const e = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  for (const c of children) e.append(c);
  return e;
}

const params = new URLSearchParams(location.search);
const profile = (params.get('profil') ?? params.get('profile') ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'default';

// ---------------------------------------------------------------------------
// Scène et réseau
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Surface de minage navigable (face « top » = dessus de la couche courante)
// ---------------------------------------------------------------------------

/**
 * Choix du rendu : « monolithe » (perspective, nouveau) ou « classique »
 * (2.5D léger). Le rendu classique reste la valeur par défaut tant que le
 * nouveau n'a pas été validé ; `?rendu=monolithe` ou le réglage du profil
 * permettent de choisir.
 */
type RendererKind = 'monolith' | 'classic';
const DEFAULT_RENDERER: RendererKind = 'monolith';
/**
 * Priorité : paramètre d'URL > choix explicite du joueur (Profil) > repli
 * automatique enregistré sur un appareil trop lent > rendu par défaut.
 */
function chooseRenderer(): RendererKind {
  const q = params.get('rendu');
  if (q === 'monolithe' || q === 'monolith') return 'monolith';
  if (q === 'classique' || q === 'classic') return 'classic';
  const saved = storageGet('tlb.renderer');
  if (saved === 'monolith' || saved === 'classic') return saved;
  if (storageGet('tlb.renderer.auto') === 'classic') return 'classic';
  return DEFAULT_RENDERER;
}
let rendererKind = chooseRenderer();
const billboard = new BillboardLayer();
const presence = new PresenceLayer();
function createView(kind: RendererKind, canvas: HTMLCanvasElement): WorldView {
  const v: WorldView = kind === 'monolith' ? new MonolithView(canvas) : new SurfaceView(canvas);
  v.layers = [billboard, presence];
  return v;
}
// `world` et `monolith` peuvent être remplacés à chaud (voir swapRenderer) : le reste du
// code les lit toujours au moment de l'appel.
let world: WorldView = createView(rendererKind, $<HTMLCanvasElement>('#world'));
let monolith: MonolithView | null = world instanceof MonolithView ? world : null;
document.body.dataset.renderer = rendererKind;
const minimap = new Minimap($<HTMLCanvasElement>('#minimap'), world.camera, (wx, wy, final) => {
  world.camera.animateTo({ x: wx, y: wy }, final ? animMs(250) : 0);
  world.requestRender();
  saveCamera();
});
/** Coups envoyés, en attente de confirmation : actionId → bloc. */
const pendingHits = new Map<string, { block: number; at: number }>();
let face: FaceData | null = null;
let cameraReady = false;

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
world.reducedMotion = reducedMotion;
billboard.reducedMotion = reducedMotion;
presence.reducedMotion = reducedMotion;
world.camera.inertia = !reducedMotion;
/** Durée d'animation de caméra : nulle si l'utilisateur préfère réduire les mouvements. */
const animMs = (ms: number) => (reducedMotion ? 0 : ms);

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible */
  }
}
function lowFxPref(): boolean {
  return storageGet('tlb.lowfx') === '1';
}
world.lowFx = lowFxPref();

const camKey = () => `tlb.cam.${profile}.${state.season?.id ?? 0}`;
let camSaveTimer = 0;
function saveCamera() {
  clearTimeout(camSaveTimer);
  camSaveTimer = window.setTimeout(() => {
    const c = world.camera;
    storageSet(camKey(), JSON.stringify({ x: c.x, y: c.y, zoom: c.zoom }));
  }, 400);
}

function defaultZoom(): number {
  const c = world.camera;
  // En perspective, le premier plan est agrandi : on vise des blocs plus petits au centre.
  const z = monolith ? Math.min(38, Math.max(24, Math.min(c.viewW, c.viewH) / 13)) : Math.min(52, Math.max(30, Math.min(c.viewW, c.viewH) / 9));
  return Math.max(c.minZoom, Math.min(c.maxZoom, z));
}

/** Reconstruit la face à partir de l'état serveur. `reset` : nouvelle saison / première connexion. */
function applyCube(reset: boolean) {
  const cube = state.cube;
  if (!cube || cube.currentLayer >= cube.size) {
    face = null;
    world.setState({ face: null });
    minimap.face = null;
    minimap.draw();
    return;
  }
  face = {
    faceId: 'top',
    size: cube.size,
    layer: cube.currentLayer,
    maxHp: cube.layerMaxHp[cube.currentLayer] ?? 1,
    hp: cube.currentHp,
  };
  const cam = world.camera;
  // Au nord, la caméra peut remonter jusqu'au panneau planté au-delà du bord.
  // Rendu classique : la caméra peut remonter jusqu'au panneau planté au nord.
  // Rendu monolithe : le panneau se voit depuis la face, la caméra reste au-dessus.
  cam.setBounds({ minX: 0, maxX: cube.size, minY: monolith ? 0 : billboardCameraY(TILT), maxY: cube.size });
  billboard.faceSize = cube.size;
  presence.faceSize = cube.size;
  cam.minZoom = Math.max(5, Math.min(24, cam.fitZoom(cube.size, cube.size) * 0.95));
  cam.maxZoom = 96;
  if (reset || !cameraReady) {
    let restored = false;
    try {
      const saved = JSON.parse(storageGet(camKey()) ?? 'null') as { x: number; y: number; zoom: number } | null;
      if (saved && [saved.x, saved.y, saved.zoom].every(Number.isFinite)) {
        cam.animateTo(saved, 0);
        restored = true;
      }
    } catch {
      /* position illisible : ignorée */
    }
    if (!restored) cam.animateTo({ x: cube.size / 2, y: cube.size / 2, zoom: defaultZoom() }, 0);
    cameraReady = true;
  }
  // Sélection : conservée si le bloc vit encore, sinon le bloc vivant le plus proche.
  if (state.selected === null || !(cube.currentHp[state.selected] > 0)) {
    const from = state.selected !== null ? toXY(state.selected, cube.size) : null;
    state.selected = from ? nearestAlive(face, from.x + 0.5, from.y + 0.5) : nearestAlive(face, cam.x, cam.y);
  }
  minimap.face = face;
  minimap.cubeSize = cube.size;
  minimap.version++;
  syncWorld();
}

/** Signale une attente réseau anormale (> 400 ms) sur le bouton Miner. */
function updateWaiting() {
  const now = Date.now();
  const slow = [...pendingHits.values()].some((p) => now - p.at > 400);
  mineBtn.classList.toggle('waiting', slow);
  if (slow) $('#mine-hint').textContent = 'En attente de confirmation du serveur…';
}
setInterval(updateWaiting, 200);

/** Panneau du décor + bandeau compact : top 3, meilleure brigade, avancement, saison. */
function updateBillboard() {
  const cube = state.cube;
  if (!state.season || !cube) {
    billboard.data = null;
    $('#banner-top').textContent = state.lastEnded ? `★ ${state.lastEnded.name} terminée` : '★ Intersaison';
    $('#banner-sub').textContent = state.lastEnded
      ? `Champion : ${state.lastEnded.championName ?? '—'} · Pierre finale : ${state.lastEnded.finalStoneName ?? '—'}`
      : countdownText();
    return;
  }
  const best = state.brigades[0] ?? null;
  const progress = cube.destroyedBlocks / cube.totalBlocks;
  billboard.data = {
    seasonName: state.season.name,
    countdown: countdownText(),
    top: state.leaderboard.slice(0, 3).map((e) => ({ name: e.name, color: skinById(e.skin).color, hits: e.hits })),
    brigade: best ? { name: best.name, hits: best.hits, eligible: best.eligible } : null,
    progress,
    finalStone: cube.currentLayer === cube.size - 1 && cube.layerRemaining[cube.currentLayer] === 1,
  };
  const top3 = state.leaderboard.slice(0, 3);
  $('#banner-top').textContent = top3.length ? `★ ${top3.map((e, i) => `${i + 1}. ${e.name} ${e.hits}`).join(' · ')}` : '★ Aucun coup pour l\'instant';
  $('#banner-sub').textContent = `${best ? `⚑ ${best.name} · ` : ''}cube ${fmtPct(progress)} · ${state.season.name}`;
}

function lookAtBillboard() {
  if (!face) return;
  if (monolith) {
    monolith.lookAtBillboard();
    return;
  }
  const cam = world.camera;
  // Le panneau tient dans la largeur libre, à gauche de la colonne de commandes.
  const controls = $('.cam-controls').getBoundingClientRect().width + 16;
  const zoom = Math.max(cam.minZoom, Math.min(48, (cam.viewW - controls - 16) / 23));
  cam.animateTo({ x: face.size / 2 + controls / 2 / zoom, y: billboardCameraY(TILT), zoom }, animMs(600));
  world.requestRender();
}

/** Le bandeau compact est masqué quand le panneau du décor est à l'écran (pas de doublon). */
function updateBannerVisibility() {
  // Vue monumentale : la scène se suffit, bandeau et mini-carte s'effacent.
  const monumental = !!monolith?.monumental;
  $('#viewport').classList.toggle('monumental', monumental);
  // Monolithe : en vue de minage, le panneau lointain reste petit (bandeau utile) ; on ne
  // masque le bandeau que si la caméra s'est élevée vers le panneau et qu'il est bien lisible.
  const boardShown = monolith
    ? monumental || ((monolith.camera as { t: number }).t > 0.25 && monolith.billboardScreenWidth > world.camera.viewW * 0.35)
    : world.camera.visibleWorld().minY < -2;
  const visible = !(billboard.data && boardShown);
  const banner = $('#banner');
  if (banner.hidden === !visible) return;
  banner.hidden = !visible;
  placeToasts();
}
$('#banner').addEventListener('click', lookAtBillboard);
$('#board-btn').addEventListener('click', lookAtBillboard);

/** Présence : observations transmises par le serveur (jamais simulées). */
function setPresence(list: PresenceEntry[]) {
  const now = performance.now();
  presence.markers = list.map((m): PresenceMarker => ({ ...m, receivedAt: now }));
  updatePresenceUi();
}
/** Pourcentage lisible même au tout début d'un très grand cube. */
function fmtPct(f: number): string {
  return `${(f * 100).toFixed(f > 0 && f < 0.01 ? 2 : 1).replace('.', ',')} %`;
}

function updatePresenceUi() {
  const now = performance.now();
  presence.myId = state.player?.id ?? null;
  presence.myBrigade = state.brigade?.name ?? null;
  const live = presence.markers.filter((m) => m.playerId !== presence.myId && presenceAge(m, now) <= PRESENCE_WINDOW_MS);
  $('#hud-presence').textContent = String(live.length);
  minimap.markers = [...groupByBlock(live, now).entries()].map(([idx, l]) => ({ idx, color: brigadeColor(l[0].brigadeName) }));
  ($('#brigade-go') as HTMLButtonElement).hidden = !state.brigade;
}
// Les observations vieillissent : rafraîchissement discret une fois par seconde.
setInterval(() => {
  if (presence.markers.length === 0) return;
  updatePresenceUi();
  minimap.draw();
  world.requestRender();
}, 1000);

function joinBrigade() {
  if (!state.brigade || !face) return;
  const now = performance.now();
  const mates = presence.markers
    .filter((m) => m.brigadeName === state.brigade!.name && m.playerId !== state.player?.id && presenceAge(m, now) <= PRESENCE_WINDOW_MS)
    .sort((a, b) => presenceAge(a, now) - presenceAge(b, now));
  if (mates.length === 0) {
    toast('Aucun membre de votre brigade n\'a miné dans les 20 dernières secondes : position inconnue.', 'info');
    return;
  }
  const { x, y } = toXY(mates[0].block, face.size);
  world.camera.animateTo({ x: x + 0.5, y: y + 0.5, zoom: defaultZoom() }, animMs(500));
  world.requestRender();
  toast(`Vous rejoignez ${mates[0].name} (vu il y a ${Math.round(presenceAge(mates[0], now) / 1000)} s).`, 'good');
}
$('#brigade-go').addEventListener('click', joinBrigade);

function syncWorld() {
  updateBillboard();
  world.setState({
    face,
    cubeSize: state.cube?.size ?? 1,
    selected: state.selected,
    pending: new Set([...pendingHits.values()].map((p) => p.block)),
    offline: $('#conn-status').dataset.state !== 'online' && cameraReady,
    message: !state.season ? 'Intersaison — le prochain cube arrive bientôt' : null,
  });
  minimap.selected = state.selected;
  minimap.draw();
  updateCoords();
}

function updateCoords() {
  const c = world.camera;
  $('#coords').textContent = face ? `x ${Math.floor(c.x)} · y ${Math.floor(c.y)} / ${face.size}` : '—';
}

function handleCameraMove() {
  updateBannerVisibility();
  minimap.draw();
  updateCoords();
  saveCamera();
}
world.onCameraMove = handleCameraMove;
world.onTap = handleTap;

function handleTap(wx: number, wy: number, kind: PointerKind) {
  if (!face) return;
  // Toucher indulgent : rayon d'aimantation d'au moins ~22 px ou un demi-bloc.
  const radiusPx = kind === 'touch' ? 22 : 10;
  const zoom = world.camera.zoom;
  const x = Math.floor(wx);
  const y = Math.floor(wy);
  let idx: number | null = null;
  if (x >= 0 && y >= 0 && x < face.size && y < face.size && face.hp[y * face.size + x] > 0) idx = y * face.size + x;
  else {
    const cand = nearestAlive(face, wx, wy, Math.max(1, Math.ceil(radiusPx / zoom) + 1));
    if (cand !== null) {
      const p = toXY(cand, face.size);
      const d = Math.hypot((p.x + 0.5 - wx) * zoom, (p.y + 0.5 - wy) * zoom * TILT);
      if (d <= Math.max(radiusPx, zoom * 0.75)) idx = cand;
    }
  }
  if (idx === null) return;
  state.selected = idx;
  syncWorld();
};

/** Amène un bloc dans la vue s'il en est sorti (sans changer le zoom). */
function ensureVisible(idx: number) {
  if (!face) return;
  const { x, y } = toXY(idx, face.size);
  const v = world.camera.visibleWorld();
  const m = 1;
  if (x < v.minX + m || x + 1 > v.maxX - m || y < v.minY + m || y + 1 > v.maxY - m) {
    world.camera.animateTo({ x: x + 0.5, y: y + 0.5 }, animMs(300));
    world.requestRender();
  }
}

// Vue d'ensemble : l'ancienne vue isométrique du cube entier, réutilisée.
const overview = new Scene(
  $<HTMLCanvasElement>('#overview-canvas'),
  (block) => {
    closeOverview();
    if (!face || !(face.hp[block] > 0)) return;
    state.selected = block;
    const { x, y } = toXY(block, face.size);
    world.camera.animateTo({ x: x + 0.5, y: y + 0.5, zoom: defaultZoom() }, animMs(450));
    syncWorld();
  },
  { billboard: false },
);
overview.setActive(false);
function openOverview() {
  $('#overview').hidden = false;
  overview.data = {
    cube: state.cube,
    leaderboard: [],
    myId: null,
    me: null,
    seasonName: state.season?.name ?? '',
    countdown: '',
    selected: state.selected,
    message: state.cube ? null : 'Intersaison',
  };
  overview.setActive(true);
  $('#overview-close').focus();
}
function closeOverview() {
  $('#overview').hidden = true;
  overview.setActive(false);
}
/** Bouton ▦ : vue d'ensemble isométrique (classique) ou vue monumentale en scène (monolithe). */
function toggleOverview() {
  if (!monolith) return openOverview();
  if (monolith.monumental) recenter();
  else monolith.showMonument();
}
$('#overview-btn').addEventListener('click', toggleOverview);
const classicTint = minimap.tint;
/** Réglages d'interface propres au rendu actif (au démarrage et après un remplacement à chaud). */
function applyRendererUi() {
  document.body.dataset.renderer = rendererKind;
  // Mini-carte aux couleurs du monolithe (pierre-tech, éclaircie pour rester lisible).
  minimap.tint = monolith ? (layer, size) => scale(layerColor(layer, size), 1.7) : classicTint;
  minimap.version++;
  const label = monolith ? 'Vue monumentale du cube' : "Vue d'ensemble du cube";
  $('#overview-btn').title = `${label} (V)`;
  $('#overview-btn').setAttribute('aria-label', label);
  if (!monolith) $('#viewport').classList.remove('monumental');
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="renderer"]')) input.checked = input.value === rendererKind;
}
applyRendererUi();
setInterval(updateBannerVisibility, 400);

/**
 * Remplace le rendu sans recharger la page : nouveau canevas (les anciens
 * gestionnaires d'événements disparaissent avec l'ancien), mêmes couches,
 * même position de caméra, même état de jeu.
 */
function swapRenderer(kind: RendererKind) {
  if (kind === rendererKind) return;
  const prev = world;
  const old = $<HTMLCanvasElement>('#world');
  const canvas = old.cloneNode(false) as HTMLCanvasElement;
  old.replaceWith(canvas);
  prev.dispose();
  const v = createView(kind, canvas);
  v.reducedMotion = reducedMotion;
  v.camera.inertia = !reducedMotion;
  v.lowFx = prev.lowFx;
  v.onTap = handleTap;
  v.onCameraMove = handleCameraMove;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  world = v;
  monolith = v instanceof MonolithView ? v : null;
  rendererKind = kind;
  minimap.camera = v.camera;
  closeOverview();
  applyRendererUi();
  applyCube(false);
  v.camera.animateTo({ x: prev.camera.x, y: prev.camera.y, zoom: Math.max(v.camera.minZoom, Math.min(v.camera.maxZoom, prev.camera.zoom)) }, 0);
  v.resize();
  syncWorld();
}
$('#overview-close').addEventListener('click', closeOverview);
$('#overview').addEventListener('click', (e) => e.target === $('#overview') && closeOverview());

$('#zoom-in').addEventListener('click', () => {
  world.camera.animateTo({ zoom: world.camera.zoom * 1.4 }, animMs(200));
  world.requestRender();
});
$('#zoom-out').addEventListener('click', () => {
  world.camera.animateTo({ zoom: world.camera.zoom / 1.4 }, animMs(200));
  world.requestRender();
});
function recenter() {
  if (!face) return;
  const target = state.selected !== null && face.hp[state.selected] > 0 ? state.selected : nearestAlive(face, world.camera.x, world.camera.y);
  if (target === null) return;
  state.selected = target;
  const { x, y } = toXY(target, face.size);
  world.camera.animateTo({ x: x + 0.5, y: y + 0.5, zoom: defaultZoom() }, animMs(450));
  syncWorld();
}
$('#recenter').addEventListener('click', recenter);
new ResizeObserver(() => {
  if (face) world.camera.minZoom = Math.max(5, Math.min(24, world.camera.fitZoom(face.size, face.size) * 0.95));
  minimap.draw();
}).observe($('#viewport'));

const socket = new GameSocket(profile, onMessage, onConnState, (text) => toast(text, 'info'));

function onConnState(s: ConnState) {
  const node = $('#conn-status');
  node.dataset.state = s;
  node.querySelector('.label')!.textContent =
    s === 'online' ? 'Connecté' : s === 'connecting' ? 'Connexion…' : s === 'replaced' ? 'Ouvert ailleurs — toucher pour reprendre' : 'Reconnexion…';
  node.title = node.querySelector('.label')!.textContent ?? '';
  if (s !== 'online') stopHold?.();
  syncWorld();
}
$('#conn-status').addEventListener('click', () => {
  if ($('#conn-status').dataset.state === 'replaced') socket.restart();
});

function myColor() {
  return skinById(state.player?.skin ?? 'classic').color;
}

function setHp(layer: number, block: number, hp: number): boolean {
  const cube = state.cube;
  if (!cube || layer !== cube.currentLayer) return false;
  const prev = cube.currentHp[block];
  if (prev === undefined || hp >= prev) return false; // les PV ne font que diminuer
  cube.currentHp[block] = hp;
  if (hp === 0) {
    cube.layerRemaining[layer]--;
    cube.destroyedBlocks++;
    // Bloc sélectionné détruit : la sélection passe au bloc vivant le plus proche.
    if (state.selected === block && face) {
      const { x, y } = toXY(block, cube.size);
      state.selected = nearestAlive(face, x + 0.5, y + 0.5, 8);
    }
  }
  minimap.version++;
  return true;
}

function onMessage(msg: ServerMessage) {
  switch (msg.t) {
    case 'welcome':
      state.player = msg.player;
      state.season = msg.season;
      state.nextSeasonAt = msg.nextSeasonAt;
      state.cube = msg.cube;
      state.seq = msg.seq;
      state.leaderboard = msg.leaderboard;
      state.brigades = msg.brigades;
      state.me = msg.me;
      state.playtime = msg.playtime;
      state.brigade = msg.brigade;
      state.online = msg.online;
      state.clockOffset = msg.serverTime - Date.now();
      state.projection = msg.projection;
      setPresence(msg.presence);
      ($('#presence-visible') as HTMLInputElement).checked = msg.presenceVisible;
      if (!msg.season) loadSeasons(); // intersaison : récupère la saison écoulée pour le panneau
      applyCube(face === null || face.size !== msg.cube?.size || lastSeasonId !== msg.season?.id);
      lastSeasonId = msg.season?.id ?? null;
      renderAll();
      break;
    case 'delta':
      if (!state.season || msg.seasonId !== state.season.id || msg.seq <= state.seq) return;
      state.seq = msg.seq;
      for (const [layer, block, hp] of msg.updates) {
        // Coups des autres (ou les miens déjà affichés : setHp renvoie alors faux).
        if (setHp(layer, block, hp)) world.impact(block, hp === 0 ? 'otherDestroyed' : 'other');
      }
      renderHud();
      break;
    case 'layer':
      if (!state.season || msg.seasonId !== state.season.id) return;
      state.seq = msg.seq;
      state.cube = msg.cube;
      pendingHits.clear();
      applyCube(false);
      toast(`Couche ${msg.cube.currentLayer + 1} atteinte !`, 'good');
      renderHud();
      break;
    case 'mineResult':
      {
        const sent = pendingHits.get(msg.actionId);
        pendingHits.delete(msg.actionId);
        if (!msg.ok && sent) world.impact(sent.block, 'refused');
      }
      if (msg.ok) {
        if (msg.layer !== undefined && msg.block !== undefined && msg.hpAfter !== undefined) {
          setHp(msg.layer, msg.block, msg.hpAfter);
          // Effet uniquement APRÈS confirmation du serveur.
          if (!msg.duplicate && msg.layer === state.cube?.currentLayer) {
            world.impact(msg.block, msg.destroyed ? 'destroyed' : 'confirmed', myColor(), msg.destroyed ? 'bloc !' : '+1');
          }
          if (msg.destroyed && !msg.duplicate) haptic(12);
        }
        if (msg.me) state.me = msg.me;
        if (msg.playtime) state.playtime = msg.playtime;
        renderHud();
      } else {
        if (msg.playtime) state.playtime = msg.playtime;
        rejectFeedback(msg.reason, msg.retryAfterMs);
      }
      break;
    case 'leaderboard':
      state.leaderboard = msg.leaderboard;
      state.brigades = msg.brigades;
      state.online = msg.online;
      state.projection = msg.projection;
      setPresence(msg.presence);
      if (state.cube) state.cube.destroyedBlocks = msg.destroyedBlocks;
      renderBoards();
      renderProjection();
      renderHud();
      break;
    case 'seasonEnded':
      state.nextSeasonAt = msg.nextSeasonAt;
      state.lastEnded = msg.season;
      showSeasonEnd(msg.season);
      loadSeasons();
      break;
    case 'seasonStarted':
      toast('Une nouvelle saison commence !', 'good');
      break;
    case 'profile':
      state.player = msg.player;
      if (msg.presenceVisible !== undefined) ($('#presence-visible') as HTMLInputElement).checked = msg.presenceVisible;
      renderProfile();
      break;
    case 'brigade':
      state.brigade = msg.brigade;
      renderBrigade();
      updatePresenceUi();
      break;
    case 'error':
      toast(msg.message, 'bad');
      break;
    case 'pong':
    case 'token':
      break;
  }
}

const REJECT_TEXT: Record<MineRejectReason, string> = {
  invalid_action: 'Action invalide.',
  no_active_season: 'Aucune saison en cours.',
  out_of_bounds: 'Bloc inexistant.',
  already_destroyed: 'Trop tard : bloc déjà détruit !',
  layer_locked: 'Cette couche n\'est pas encore accessible.',
  rate_limited: 'Doucement ! 5 coups par seconde maximum.',
  daily_limit: 'Limite quotidienne de 4 h de minage actif atteinte.',
};

let lastRejectToast = 0;
function rejectFeedback(reason: MineRejectReason | undefined, retryAfterMs?: number) {
  if (!reason) return;
  if (reason === 'already_destroyed' && face && state.selected !== null && !(face.hp[state.selected] > 0)) {
    const { x, y } = toXY(state.selected, face.size);
    state.selected = nearestAlive(face, x + 0.5, y + 0.5, 8);
  }
  const now = Date.now();
  if (now - lastRejectToast < 1500 && reason !== 'daily_limit') return;
  lastRejectToast = now;
  let text = REJECT_TEXT[reason];
  if (reason === 'daily_limit' && retryAfterMs) {
    text += ` Reprise à ${new Date(serverNow() + retryAfterMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`;
  }
  toast(text, reason === 'already_destroyed' ? 'info' : 'bad');
  if (reason === 'daily_limit') renderHud();
}

// ---------------------------------------------------------------------------
// Minage
// ---------------------------------------------------------------------------

/** Bloc visé : la sélection si elle vit encore, sinon le bloc vivant le plus proche (de la sélection ou du centre de la vue). */
function pickTarget(): number | null {
  if (!face) return null;
  if (state.selected !== null && face.hp[state.selected] > 0) return state.selected;
  if (state.selected !== null) {
    const { x, y } = toXY(state.selected, face.size);
    const near = nearestAlive(face, x + 0.5, y + 0.5, 8);
    if (near !== null) return near;
  }
  return nearestAlive(face, world.camera.x, world.camera.y);
}

function mineSelected() {
  const cube = state.cube;
  if (!cube || !state.season) return;
  if (state.playtime && state.playtime.usedMs >= state.playtime.limitMs) {
    rejectFeedback('daily_limit', state.playtime.resetsAt - serverNow());
    return;
  }
  const target = pickTarget();
  if (target === null) return;
  state.selected = target;
  ensureVisible(target);
  // Aucun effet d'impact ici : seulement l'état « en attente » jusqu'à la réponse du serveur.
  const id = socket.mine(cube.currentLayer, target);
  if (id) pendingHits.set(id, { block: target, at: Date.now() });
  syncWorld();
}
// Nettoyage des attentes orphelines (réponse perdue lors d'une coupure longue).
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of pendingHits) if (now - p.at > 15_000) changed = pendingHits.delete(id) || changed;
  if (changed) syncWorld();
}, 3000);

const mineBtn = $<HTMLButtonElement>('#mine-btn');
let holdTimer: number | null = null;
let lastSeasonId: number | null = null;
function startHold(e: Event) {
  e.preventDefault();
  mineSelected();
  stopHold();
  // 220 ms ≈ 4,5 coups/s : reste sous la limite serveur malgré la gigue réseau.
  holdTimer = window.setInterval(mineSelected, 220);
  mineBtn.classList.add('active');
}
function stopHold() {
  if (holdTimer !== null) clearInterval(holdTimer);
  holdTimer = null;
  mineBtn.classList.remove('active');
}
mineBtn.addEventListener('pointerdown', startHold);
for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur'] as const) mineBtn.addEventListener(ev, stopHold);
window.addEventListener('blur', stopHold);
document.addEventListener('visibilitychange', () => document.hidden && stopHold());
for (const n of [mineBtn, $('#world'), $('#minimap')]) n.addEventListener('contextmenu', (e) => e.preventDefault());

// Clavier : déplacement (flèches, ZQSD, WASD), zoom (+/−), C recentrer, V vue d'ensemble, Espace miner.
const PAN_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  KeyQ: [-1, 0],
  KeyD: [1, 0],
  KeyW: [0, -1],
  KeyZ: [0, -1],
  KeyS: [0, 1],
};
const held = new Set<string>();
function updateKeyPan() {
  let x = 0;
  let y = 0;
  for (const k of held) {
    x += PAN_KEYS[k][0];
    y += PAN_KEYS[k][1];
  }
  const speed = 700; // px/s
  world.keyPan = { x: Math.sign(x) * speed, y: Math.sign(y) * speed };
  world.requestRender();
}
function typing(e: KeyboardEvent) {
  return e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.altKey || e.ctrlKey || e.metaKey;
}
window.addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (e.key === 'Escape') {
    closeOverview();
    closePanel();
    return;
  }
  if (!$('#overview').hidden || panelOpen()) return;
  if (e.code === 'Space' || e.code === 'Enter') {
    if (e.target instanceof HTMLButtonElement && e.code === 'Enter') return;
    e.preventDefault();
    if (!e.repeat) mineSelected();
  } else if (PAN_KEYS[e.code]) {
    e.preventDefault();
    held.add(e.code);
    updateKeyPan();
  } else if (e.key === '+' || e.key === '=') {
    world.camera.zoomAt(1.25);
    world.requestRender();
  } else if (e.key === '-' || e.key === '_') {
    world.camera.zoomAt(0.8);
    world.requestRender();
  } else if (e.code === 'KeyC') recenter();
  else if (e.code === 'KeyV') toggleOverview();
  else if (e.code === 'KeyP') lookAtBillboard();
  else if (e.code === 'KeyB') joinBrigade();
});
window.addEventListener('keyup', (e) => {
  if (held.delete(e.code)) updateKeyPan();
});
window.addEventListener('blur', () => {
  held.clear();
  updateKeyPan();
});

// Tiroir des panneaux (mobile)
const panel = $('#panel');
function panelOpen() {
  return panel.classList.contains('open');
}
function openPanel(tab?: string) {
  panel.classList.add('open');
  $('#backdrop').hidden = false;
  $('#menu-btn').setAttribute('aria-expanded', 'true');
  if (tab) document.querySelector<HTMLButtonElement>(`.tabs button[data-tab="${tab}"]`)?.click();
}
function closePanel() {
  panel.classList.remove('open');
  $('#backdrop').hidden = true;
  $('#menu-btn').setAttribute('aria-expanded', 'false');
}
$('#menu-btn').addEventListener('click', () => (panelOpen() ? closePanel() : openPanel()));
$('#panel-close').addEventListener('click', closePanel);
$('#backdrop').addEventListener('click', closePanel);

// Notifications : en haut de la surface, à gauche de la mini-carte (aucun chevauchement de commande).
function placeToasts() {
  const v = $('#viewport').getBoundingClientRect();
  const map = $('.map-box').getBoundingClientRect();
  const banner = document.querySelector<HTMLElement>('#banner');
  const top = banner && !banner.hidden ? banner.getBoundingClientRect().bottom + 6 : v.top + 8;
  const root = document.documentElement.style;
  root.setProperty('--toast-top', `${Math.round(top)}px`);
  root.setProperty('--toast-left', `${Math.round(v.left + 8)}px`);
  root.setProperty('--toast-width', `${Math.round(Math.min(420, map.left - v.left - 16))}px`);
}
new ResizeObserver(placeToasts).observe($('#viewport'));
window.addEventListener('resize', placeToasts);

// Effets réduits automatiques : si le dessin d'une image dépasse ~14 ms en moyenne,
// ou si moins de ~25 images/s sont réellement affichées pendant les animations
// (coût d'affichage d'un grand canevas haute densité), on bascule une fois, sauf
// choix explicite de l'utilisateur.
let slowChecks = 0;
setInterval(() => {
  const t = world.recentFrameTimes;
  // Les pauses du rendu (rien ne bouge) ne sont pas enregistrées ; 20 images suffisent
  // pour juger, même sur un appareil qui n'en affiche que quelques-unes par seconde.
  const iv = world.recentFrameIntervals.filter((x) => x < 10_000).sort((a, b) => a - b);
  const avg = t.length ? t.reduce((a, b) => a + b, 0) / t.length : 0;
  const medianInterval = iv.length >= 20 ? iv[Math.floor(iv.length / 2)] : 0;
  const slow = medianInterval > 33; // sous 30 images/s
  if (world.lowFx) {
    // Déjà allégé et toujours sous 30 images/s pendant deux contrôles (≥ 10 s) : on passe
    // au rendu classique tout de suite, sans recharger (sauf choix explicite du joueur).
    slowChecks = slow ? slowChecks + 1 : 0;
    if (monolith && slowChecks >= 2 && storageGet('tlb.renderer') === null) {
      storageSet('tlb.renderer.auto', 'classic');
      swapRenderer('classic');
      slowChecks = 0;
      toast('Appareil lent : passage au rendu classique, plus léger, pour garder la fluidité (réglable dans Profil).', 'info');
    }
    return;
  }
  if (storageGet('tlb.lowfx') !== null) return; // choix explicite du joueur : on ne force rien
  if ((t.length >= 20 && avg > 14) || slow) {
    world.lowFx = true;
    lowFxBox.checked = true;
    world.resize();
    toast('Affichage allégé automatiquement pour garder la fluidité (réglable dans Profil).', 'info');
  }
}, 5000);

$<HTMLInputElement>('#presence-visible').addEventListener('change', (e) => {
  socket.send({ t: 'setPresence', visible: (e.target as HTMLInputElement).checked });
});

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="renderer"]')) {
  input.checked = input.value === rendererKind;
  input.addEventListener('change', () => {
    // Choix explicite : mémorisé, appliqué immédiatement, sans rechargement.
    storageSet('tlb.renderer', input.value);
    storageSet('tlb.renderer.auto', '');
    swapRenderer(input.value as RendererKind);
  });
}

const lowFxBox = $<HTMLInputElement>('#low-fx');
lowFxBox.checked = world.lowFx;
lowFxBox.addEventListener('change', () => {
  world.lowFx = lowFxBox.checked;
  storageSet('tlb.lowfx', world.lowFx ? '1' : '0');
  world.resize();
});

// ---------------------------------------------------------------------------
// Rendu de l'interface
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
  if (ms <= 0) return '0 s';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${m.toString().padStart(2, '0')}`;
  return `${m} min ${(s % 60).toString().padStart(2, '0')} s`;
}

function renderAll() {
  renderHud();
  renderBoards();
  renderBrigade();
  renderProfile();
}

function renderHud() {
  const cube = state.cube;
  $('#season-name').textContent = state.season?.name ?? 'Intersaison';
  $('#hud-layer').textContent = cube ? `${Math.min(cube.currentLayer + 1, cube.size)} / ${cube.size}` : '—';
  $('#hud-progress').textContent = cube ? fmtPct(cube.destroyedBlocks / cube.totalBlocks) : '—';
  $('#hud-hits').textContent = state.me.hits.toLocaleString('fr-FR');
  $('#hud-rank').textContent = state.me.rank ? `#${state.me.rank}` : '—';
  $('#hud-online').textContent = String(state.online);
  const pt = state.playtime;
  if (pt) {
    const used = Math.min(pt.usedMs, pt.limitMs);
    $('#playtime-text').textContent = `${Math.floor(used / 60000)} min / ${Math.round(pt.limitMs / 3600000)} h`;
    $('#playtime-fill').style.width = `${(used / pt.limitMs) * 100}%`;
    $('#playtime-bar').setAttribute('aria-valuenow', String(Math.round((used / pt.limitMs) * 100)));
    $('#playtime-fill').classList.toggle('full', used >= pt.limitMs);
  }
  const limited = !!pt && pt.usedMs >= pt.limitMs;
  mineBtn.disabled = !cube || !state.season || limited;
  $('#mine-hint').textContent = limited
    ? 'Limite quotidienne atteinte'
    : !state.season
      ? 'En attente de la prochaine saison'
      : 'Touchez un bloc pour le choisir, puis Miner (maintenir = continu)';
  if (!$('#overview').hidden) overview.data = { ...overview.data, cube: state.cube, selected: state.selected };
  syncWorld();
}

function renderBoards() {
  const list = $('#board-players');
  list.replaceChildren(
    ...(state.leaderboard.length
      ? state.leaderboard.map((e) => {
          const li = el(
            'li',
            { cls: e.playerId === state.player?.id ? 'me' : '' },
            el('span', { cls: 'rank', textContent: `#${e.rank}` }),
            el('span', { cls: 'name', textContent: e.name }),
            el('span', { cls: 'sub', textContent: e.brigadeName ?? '' }),
            el('span', { cls: 'score', textContent: `${e.hits.toLocaleString('fr-FR')}` }),
          );
          (li.querySelector('.name') as HTMLElement).style.color = skinById(e.skin).color;
          return li;
        })
      : [el('li', { cls: 'empty', textContent: 'Aucun mineur pour le moment.' })]),
  );
  if (state.me.rank && !state.leaderboard.some((e) => e.playerId === state.player?.id)) {
    list.append(
      el('li', { cls: 'me' }, el('span', { cls: 'rank', textContent: `#${state.me.rank}` }), el('span', { cls: 'name', textContent: state.player?.name ?? 'Moi' }), el('span', { cls: 'sub' }), el('span', { cls: 'score', textContent: String(state.me.hits) })),
    );
  }
  $('#board-brigades').replaceChildren(
    ...(state.brigades.length
      ? state.brigades.map((b) =>
          el(
            'li',
            { cls: b.brigadeId === state.brigade?.id ? 'me' : '' },
            el('span', { cls: 'rank', textContent: `#${b.rank}` }),
            el('span', { cls: 'name', textContent: b.name }),
            el('span', { cls: 'sub', textContent: `${b.members} membres${b.eligible ? '' : ' · en formation'}` }),
            el('span', { cls: 'score', textContent: b.hits.toLocaleString('fr-FR') }),
          ),
        )
      : [el('li', { cls: 'empty', textContent: 'Aucune brigade.' })]),
  );
}

function renderBrigade() {
  const b = state.brigade;
  $('#brigade-none').classList.toggle('hidden', !!b);
  $('#brigade-mine').classList.toggle('hidden', !b);
  if (!b) return;
  $('#brigade-name').textContent = b.name;
  const n = b.members.length;
  $('#brigade-status').textContent =
    n < b.minSize ? `${n}/${b.maxSize} membres — encore ${b.minSize - n} pour être éligible au titre.` : `${n}/${b.maxSize} membres — éligible au titre de brigade championne.`;
  $('#brigade-code').textContent = b.inviteCode;
  $('#brigade-members').replaceChildren(
    ...b.members
      .slice()
      .sort((x, y) => y.hits - x.hits)
      .map((m, i) =>
        el(
          'li',
          { cls: m.id === state.player?.id ? 'me' : '' },
          el('span', { cls: 'rank', textContent: `#${i + 1}` }),
          el('span', { cls: 'name', textContent: m.name }),
          el('span', { cls: 'sub', textContent: m.id === b.ownerId ? 'chef' : '' }),
          el('span', { cls: 'score', textContent: m.hits.toLocaleString('fr-FR') }),
        ),
      ),
  );
}

function renderProfile() {
  const input = $<HTMLInputElement>('#name-input');
  if (document.activeElement !== input) input.value = state.player?.name ?? '';
  $('#skins').replaceChildren(
    ...SKINS.map((s) => {
      const btn = el('button', { type: 'button', cls: `skin${state.player?.skin === s.id ? ' active' : ''}`, title: s.label });
      btn.style.setProperty('--c', s.color);
      btn.style.setProperty('--a', s.accent);
      btn.append(el('span', { cls: 'swatch' }), el('span', { textContent: s.label }));
      btn.addEventListener('click', () => socket.send({ t: 'setSkin', skin: s.id }));
      return btn;
    }),
  );
  renderHud();
}

// ---------------------------------------------------------------------------
// Saisons
// ---------------------------------------------------------------------------

async function loadSeasons() {
  try {
    const r = await fetch('/api/seasons');
    const data = (await r.json()) as { seasons: SeasonInfo[] };
    const ended = data.seasons.find((s) => s.status === 'ended');
    if (ended && (!state.lastEnded || ended.id >= state.lastEnded.id)) {
      state.lastEnded = ended;
      renderHud();
    }
    $('#season-list').replaceChildren(
      ...data.seasons.map((s) => {
        const li = el(
          'li',
          {},
          el('strong', { textContent: s.name }),
          el('span', {
            cls: 'muted small',
            textContent:
              s.status === 'active'
                ? ' — en cours'
                : ` — terminée (${endReasonText(s.endReason)}${s.completedEarlyMs && s.completedEarlyMs > 60_000 ? `, ${fmtDuration(s.completedEarlyMs)} avant l'échéance` : ''})`,
          }),
        );
        if (s.status === 'ended') {
          li.append(
            el('div', { cls: 'small', textContent: `Champion : ${s.championName ?? '—'} · Brigade : ${s.championBrigadeName ?? '—'} · Pierre finale : ${s.finalStoneName ?? '—'}` }),
          );
          const btn = el('button', { type: 'button', cls: 'link', textContent: 'Classement final' });
          btn.addEventListener('click', () => loadSeasonDetail(s.id));
          li.append(btn);
        }
        return li;
      }),
    );
  } catch {
    /* hors ligne : on réessaiera */
  }
}

function endReasonText(r: SeasonInfo['endReason']) {
  return r === 'completed' ? 'cube terminé' : r === 'timeout' ? 'temps écoulé' : r === 'admin' ? 'clôture manuelle' : '';
}

async function loadSeasonDetail(id: number) {
  const r = await fetch(`/api/seasons/${id}`);
  if (!r.ok) return;
  const d = (await r.json()) as { season: SeasonInfo; players: { rank: number; name: string; hits: number }[]; brigades: { rank: number; name: string; hits: number }[] };
  const mk = (rows: { rank: number; name: string; hits: number }[]) =>
    el(
      'ol',
      { cls: 'board' },
      ...rows.slice(0, 20).map((p) => el('li', {}, el('span', { cls: 'rank', textContent: `#${p.rank}` }), el('span', { cls: 'name', textContent: p.name }), el('span', { cls: 'sub' }), el('span', { cls: 'score', textContent: p.hits.toLocaleString('fr-FR') }))),
    );
  $('#season-detail').replaceChildren(el('h2', { textContent: `${d.season.name} — classement final` }), mk(d.players), el('h2', { textContent: 'Brigades' }), mk(d.brigades));
}

function showSeasonEnd(s: SeasonInfo) {
  const dlg = $<HTMLDialogElement>('#season-dialog');
  $('#season-dialog-body').replaceChildren(
    el('h2', { textContent: `${s.name} terminée !` }),
    el('p', {
      textContent:
        s.endReason === 'completed'
          ? `Le cube a été entièrement miné${s.completedEarlyMs && s.completedEarlyMs > 60_000 ? `, ${fmtDuration(s.completedEarlyMs)} avant l'échéance` : ''} !`
          : s.endReason === 'admin'
            ? 'La saison a été clôturée par l\'organisation.'
            : 'Le temps de la saison est écoulé : le cube n\'a pas été terminé, la Pierre finale n\'est pas attribuée.',
    }),
    el('p', {}, el('strong', { textContent: 'Champion : ' }), s.championName ?? '—'),
    el('p', {}, el('strong', { textContent: 'Brigade championne : ' }), s.championBrigadeName ?? '—'),
    el('p', {}, el('strong', { textContent: 'Pierre finale : ' }), s.finalStoneName ?? '—'),
  );
  if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
}

// ---------------------------------------------------------------------------
// Formulaires et onglets
// ---------------------------------------------------------------------------

document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll<HTMLElement>('.tab-body').forEach((b) => b.classList.toggle('hidden', b.dataset.body !== btn.dataset.tab));
    if (btn.dataset.tab === 'seasons') {
      loadSeasons();
      renderProjection();
    }
  }),
);

function formValue(form: HTMLFormElement, name: string): string {
  return (form.elements.namedItem(name) as HTMLInputElement).value;
}

$<HTMLFormElement>('#brigade-create').addEventListener('submit', (e) => {
  e.preventDefault();
  socket.send({ t: 'brigadeCreate', name: formValue(e.target as HTMLFormElement, 'name') });
});
$<HTMLFormElement>('#brigade-join').addEventListener('submit', (e) => {
  e.preventDefault();
  socket.send({ t: 'brigadeJoin', code: formValue(e.target as HTMLFormElement, 'code') });
});
$('#brigade-leave').addEventListener('click', () => {
  if (confirm('Quitter la brigade ? Vos coups passés restent acquis à la brigade.')) socket.send({ t: 'brigadeLeave' });
});
$('#brigade-copy').addEventListener('click', async () => {
  const code = state.brigade?.inviteCode;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    toast('Code copié.', 'good');
  } catch {
    toast(`Code : ${code}`, 'info');
  }
});
$<HTMLFormElement>('#name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  socket.send({ t: 'setName', name: formValue(e.target as HTMLFormElement, 'name') });
  (document.activeElement as HTMLElement | null)?.blur();
});
$('#rotate-token').addEventListener('click', () => {
  if (confirm('Générer un nouveau jeton ? Vos autres onglets et appareils seront déconnectés.')) socket.send({ t: 'rotateToken' });
});
$('#reset-profile').addEventListener('click', () => {
  if (!confirm('Abandonner ce compte invité ? Le jeton sera révoqué sur le serveur : ce compte ne pourra plus jamais être repris. Vos scores restent au classement.')) return;
  // Le serveur ferme alors la session (4003) ; la reconnexion automatique
  // crée un nouveau compte puisque le jeton local est effacé.
  socket.send({ t: 'logout' });
  socket.forgetToken();
});

// ---------------------------------------------------------------------------
// Divers
// ---------------------------------------------------------------------------

function toast(text: string, kind: 'good' | 'bad' | 'info' = 'info') {
  placeToasts(); // géométrie à jour (bandeau, mini-carte) au moment d'afficher
  const box = $('#toasts');
  const t = el('div', { cls: `toast ${kind}`, textContent: text });
  box.append(t);
  while (box.children.length > 3) box.firstElementChild?.remove();
  setTimeout(() => t.remove(), 3200);
}

setInterval(() => {
  // Le compte à rebours du panneau n'est redessiné que si le panneau est à l'écran.
  if (billboard.data && (monolith ? monolith.billboardScreenWidth > 0 : world.camera.visibleWorld().minY < 0)) {
    billboard.data.countdown = countdownText();
    world.requestRender();
  }
}, 1000);

function countdownText(): string {
  const now = serverNow();
  if (state.season) return `fin dans ${fmtDuration(state.season.endsAt - now)}`;
  if (state.nextSeasonAt) return `prochaine saison dans ${fmtDuration(state.nextSeasonAt - now)}`;
  return 'en attente';
}

setInterval(() => {
  const text = countdownText();
  $('#countdown').textContent = text;
}, 500);

function haptic(ms: number) {
  try {
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) navigator.vibrate?.(ms);
  } catch {
    /* non pris en charge */
  }
}

function renderProjection() {
  const p = state.projection;
  const node = $('#projection-text');
  if (!p || !state.season) {
    node.textContent = 'Aucune saison en cours.';
    return;
  }
  const now = serverNow();
  const pct = ((p.hitsDone / p.totalHits) * 100).toFixed(1);
  let text = `${pct} % des coups nécessaires portés (${p.hitsDone.toLocaleString('fr-FR')} / ${p.totalHits.toLocaleString('fr-FR')}). Échéance dans ${fmtDuration(p.endsAt - now)}.`;
  if (p.projectedCompletionAt && p.hitsDone > 0) {
    text += p.completesBeforeEnd
      ? ` Au rythme moyen actuel, le cube serait terminé dans ~${fmtDuration(p.projectedCompletionAt - now)}, avant l'échéance.`
      : ` Au rythme moyen actuel, le cube ne serait pas terminé avant l'échéance.`;
  }
  node.textContent = text;
}

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg: { rules: { maxActionsPerSecond: number; dailyActiveLimitMs: number; brigadeMinSize: number; brigadeMaxSize: number }; donation: { enabled: boolean; associationName: string; associationUrl: string; note: string } }) => {
    $('#rule-rate').textContent = String(cfg.rules.maxActionsPerSecond);
    $('#rule-daily').textContent = `${cfg.rules.dailyActiveLimitMs / 3600000} h`;
    document.querySelectorAll('.bmin').forEach((n) => (n.textContent = String(cfg.rules.brigadeMinSize)));
    document.querySelectorAll('.bmax').forEach((n) => (n.textContent = String(cfg.rules.brigadeMaxSize)));
    const note = $('#donation-note');
    note.textContent = cfg.donation.note;
    if (cfg.donation.enabled && cfg.donation.associationName) {
      note.append(el('br'), `Association envisagée : ${cfg.donation.associationName}`);
      if (/^https:\/\//.test(cfg.donation.associationUrl)) {
        note.append(' — ', el('a', { href: cfg.donation.associationUrl, target: '_blank', rel: 'noopener noreferrer', textContent: 'site' }));
      }
    }
  })
  .catch(() => {});

// Exposé pour le débogage manuel dans la console.
(window as unknown as { tlb: unknown }).tlb = {
  state,
  socket,
  minimap,
  get world() {
    return world;
  },
};

// Connexion en dernier : toute l'interface est initialisée.
socket.connect();
