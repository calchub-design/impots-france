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
  SeasonInfo,
  ServerMessage,
} from '../../shared/protocol.js';
import { SKINS, skinById } from '../../shared/skins.js';
import { GameSocket, type ConnState } from './net.js';
import { Scene } from './scene.js';

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

const scene = new Scene($<HTMLCanvasElement>('#scene'), (block) => {
  state.selected = block;
  mineSelected();
});

const socket = new GameSocket(profile, onMessage, onConnState, (text) => toast(text, 'info'));
socket.connect();

function onConnState(s: ConnState) {
  const node = $('#conn-status');
  node.dataset.state = s;
  node.querySelector('.label')!.textContent =
    s === 'online' ? 'Connecté' : s === 'connecting' ? 'Connexion…' : s === 'replaced' ? 'Ouvert ailleurs — toucher pour reprendre' : 'Reconnexion…';
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
    if (state.selected === block) state.selected = null;
  }
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
      if (state.selected !== null && !(msg.cube && msg.cube.currentHp[state.selected] > 0)) state.selected = null;
      renderAll();
      break;
    case 'delta':
      if (!state.season || msg.seasonId !== state.season.id || msg.seq <= state.seq) return;
      state.seq = msg.seq;
      for (const [layer, block, hp] of msg.updates) {
        if (setHp(layer, block, hp)) scene.hitEffect(block, hp === 0, '#e8dcc0');
      }
      renderHud();
      break;
    case 'layer':
      if (!state.season || msg.seasonId !== state.season.id) return;
      state.seq = msg.seq;
      state.cube = msg.cube;
      state.selected = null;
      toast(`Couche ${msg.cube.currentLayer + 1} atteinte !`, 'good');
      renderHud();
      break;
    case 'mineResult':
      if (msg.ok) {
        if (msg.layer !== undefined && msg.block !== undefined && msg.hpAfter !== undefined) {
          setHp(msg.layer, msg.block, msg.hpAfter);
          if (!msg.duplicate) scene.hitEffect(msg.block, !!msg.destroyed, myColor(), msg.destroyed ? '+1 bloc !' : '+1');
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
      if (state.cube) state.cube.destroyedBlocks = msg.destroyedBlocks;
      renderBoards();
      renderHud();
      break;
    case 'seasonEnded':
      state.nextSeasonAt = msg.nextSeasonAt;
      showSeasonEnd(msg.season);
      loadSeasons();
      break;
    case 'seasonStarted':
      toast('Une nouvelle saison commence !', 'good');
      break;
    case 'profile':
      state.player = msg.player;
      renderProfile();
      break;
    case 'brigade':
      state.brigade = msg.brigade;
      renderBrigade();
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
  if (reason === 'already_destroyed') state.selected = null;
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

function pickTarget(): number | null {
  const cube = state.cube;
  if (!cube || cube.currentLayer >= cube.size) return null;
  if (state.selected !== null && cube.currentHp[state.selected] > 0) return state.selected;
  // Choix d'un bloc vivant, de préférence voisin de la sélection précédente.
  const alive: number[] = [];
  cube.currentHp.forEach((hp, i) => hp > 0 && alive.push(i));
  if (alive.length === 0) return null;
  return alive[Math.floor(Math.random() * alive.length)];
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
  const id = socket.mine(cube.currentLayer, target);
  if (id) scene.hitEffect(target, false, myColor());
}

const mineBtn = $<HTMLButtonElement>('#mine-btn');
let holdTimer: number | null = null;
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
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !e.repeat) {
    e.preventDefault();
    mineSelected();
  }
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
  $('#hud-progress').textContent = cube ? `${((cube.destroyedBlocks / cube.totalBlocks) * 100).toFixed(1)} %` : '—';
  $('#hud-hits').textContent = state.me.hits.toLocaleString('fr-FR');
  $('#hud-rank').textContent = state.me.rank ? `#${state.me.rank}` : '—';
  $('#hud-online').textContent = String(state.online);
  const pt = state.playtime;
  if (pt) {
    const used = Math.min(pt.usedMs, pt.limitMs);
    $('#playtime-text').textContent = `${Math.floor(used / 60000)} min / ${Math.round(pt.limitMs / 3600000)} h`;
    $('#playtime-fill').style.width = `${(used / pt.limitMs) * 100}%`;
    $('#playtime-fill').classList.toggle('full', used >= pt.limitMs);
  }
  const limited = !!pt && pt.usedMs >= pt.limitMs;
  mineBtn.disabled = !cube || !state.season || limited;
  $('#mine-hint').textContent = limited
    ? 'Limite quotidienne atteinte'
    : !state.season
      ? 'En attente de la prochaine saison'
      : 'Touchez un bloc ou maintenez ce bouton';
  scene.data = {
    cube: state.cube,
    leaderboard: state.leaderboard,
    myId: state.player?.id ?? null,
    seasonName: state.season?.name ?? '',
    selected: state.selected,
    message: !state.season ? 'Intersaison — le prochain cube arrive bientôt' : null,
  };
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
    $('#season-list').replaceChildren(
      ...data.seasons.map((s) => {
        const li = el(
          'li',
          {},
          el('strong', { textContent: s.name }),
          el('span', { cls: 'muted small', textContent: s.status === 'active' ? ' — en cours' : ` — terminée (${endReasonText(s.endReason)})` }),
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
    el('p', { textContent: s.endReason === 'completed' ? 'Le cube a été entièrement miné.' : 'Le temps de la saison est écoulé.' }),
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
    if (btn.dataset.tab === 'seasons') loadSeasons();
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
  const box = $('#toasts');
  const t = el('div', { cls: `toast ${kind}`, textContent: text });
  box.append(t);
  while (box.children.length > 3) box.firstElementChild?.remove();
  setTimeout(() => t.remove(), 3200);
}

setInterval(() => {
  const now = serverNow();
  const cd = $('#countdown');
  if (state.season) cd.textContent = `fin dans ${fmtDuration(state.season.endsAt - now)}`;
  else if (state.nextSeasonAt) cd.textContent = `prochaine saison dans ${fmtDuration(state.nextSeasonAt - now)}`;
  else cd.textContent = 'en attente';
}, 500);

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
(window as unknown as { tlb: unknown }).tlb = { state, socket };
