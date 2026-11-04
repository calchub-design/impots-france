import type { CubeSnapshot, LeaderboardEntry, SeasonInfo } from '../../shared/protocol.js';
import { skinById } from '../../shared/skins.js';

/**
 * Scène 2D (Canvas, sans moteur 3D) : un panneau géant des meilleurs mineurs
 * au-dessus d'un cube en projection isométrique. Seule la couche supérieure
 * est dessinée bloc par bloc ; les couches inférieures forment un prisme.
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
}

export interface SceneData {
  cube: CubeSnapshot | null;
  leaderboard: LeaderboardEntry[];
  myId: string | null;
  /** Ma position, affichée sous le podium si je ne suis pas dans le top visible. */
  me: { name: string; skin: string; rank: number | null; hits: number } | null;
  seasonName: string;
  /** Texte du compte à rebours (calculé par l'interface, horloge serveur). */
  countdown: string;
  selected: number | null;
  message: string | null;
  /** Saison terminée affichée sur le panneau pendant l'intersaison. */
  lastSeason?: SeasonInfo | null;
}

const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Palette de strates : du sable en surface à la roche profonde puis au cœur doré.
const STRATA = ['#c9a36b', '#b48a5a', '#9c7a58', '#866b55', '#6f5d55', '#5c5260', '#4b4766', '#3f3d6e', '#383677', '#4a3a86'];

function strataColor(layer: number, size: number): string {
  const t = size <= 1 ? 0 : layer / (size - 1);
  return STRATA[Math.min(STRATA.length - 1, Math.round(t * (STRATA.length - 1)))];
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * f)));
  return `rgb(${r},${g},${b})`;
}

export class Scene {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private particles: Particle[] = [];
  private texts: FloatText[] = [];
  private shake = new Map<number, number>();
  private hover: number | null = null;
  private t0 = performance.now();
  data: SceneData = { cube: null, leaderboard: [], myId: null, me: null, seasonName: '', countdown: '', selected: null, message: null };
  /** Suivi des rangs pour signaler les montées au classement. */
  private lastBoard: LeaderboardEntry[] | null = null;
  private prevRanks = new Map<string, number>();
  private rankUpAt = new Map<string, number>();

  // Géométrie courante (calculée à chaque image)
  private ox = 0;
  private oy = 0;
  private tw = 0;
  private th = 0;
  private lh = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onPick: (block: number) => void,
  ) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    canvas.addEventListener('pointerdown', (e) => {
      const b = this.pick(e.offsetX, e.offsetY);
      if (b !== null) {
        e.preventDefault();
        this.onPick(b);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.hover = this.pick(e.offsetX, e.offsetY);
    });
    canvas.addEventListener('pointerleave', () => (this.hover = null));
    const loop = () => {
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
  }

  // --- Géométrie isométrique ----------------------------------------------

  private layout() {
    const size = this.data.cube?.size ?? 10;
    // Sur mobile le panneau prend une part plus grande : 5 lignes lisibles.
    const boardH = this.w > 480 ? Math.min(this.h * 0.36, 250) : Math.min(this.h * 0.44, 200);
    const availH = this.h - boardH - 24;
    const availW = this.w - 24;
    // Le cube complet occupe une boîte de largeur size*tw et de hauteur size*tw.
    const cubeW = Math.min(availW, availH);
    this.tw = cubeW / size;
    this.th = this.tw / 2;
    this.lh = this.th;
    this.ox = this.w / 2;
    this.oy = boardH + 16 + (availH - cubeW) / 2 + size * this.lh;
    return { size, boardH };
  }

  /** Point (gx, gy) de la grille, à la hauteur z (en couches depuis le sol). */
  private pt(gx: number, gy: number, z: number): [number, number] {
    // z mesuré en couches depuis le sol ; le sommet du cube complet est à z = size.
    return [this.ox + ((gx - gy) * this.tw) / 2, this.oy + ((gx + gy) * this.th) / 2 - z * this.lh];
  }

  private pick(sx: number, sy: number): number | null {
    const cube = this.data.cube;
    if (!cube || cube.currentLayer >= cube.size) return null;
    const size = cube.size;
    const ztop = size - cube.currentLayer; // hauteur du dessus de la couche courante
    for (const z of [ztop, ztop - 0.5, ztop - 1]) {
      const [x0, y0] = this.pt(0, 0, z);
      const dx = (sx - x0) / (this.tw / 2);
      const dy = (sy - y0) / (this.th / 2);
      const gx = Math.floor((dx + dy) / 2);
      const gy = Math.floor((dy - dx) / 2);
      if (gx >= 0 && gy >= 0 && gx < size && gy < size) {
        const idx = gy * size + gx;
        if (cube.currentHp[idx] > 0) return idx;
      }
    }
    // Aimantation : sur un grand cube les blocs sont petits sur mobile ; on
    // retient le bloc vivant le plus proche du doigt (rayon ≥ 22 px).
    const radius = Math.max(22, this.tw * 0.9);
    let best: number | null = null;
    let bestD = radius * radius;
    for (let idx = 0; idx < cube.currentHp.length; idx++) {
      if (!(cube.currentHp[idx] > 0)) continue;
      const [cx, cy] = this.pt((idx % size) + 0.5, Math.floor(idx / size) + 0.5, ztop);
      const d = (cx - sx) ** 2 + (cy - sy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    }
    return best;
  }

  /** Centre écran du dessus d'un bloc de la couche courante. */
  blockCenter(idx: number): [number, number] | null {
    const cube = this.data.cube;
    if (!cube) return null;
    this.layout();
    const gx = idx % cube.size;
    const gy = Math.floor(idx / cube.size);
    return this.pt(gx + 0.5, gy + 0.5, cube.size - cube.currentLayer);
  }

  // --- Effets ---------------------------------------------------------------

  hitEffect(idx: number, destroyed: boolean, color: string, label?: string) {
    const c = this.blockCenter(idx);
    if (!c) return;
    if (!REDUCED_MOTION) this.shake.set(idx, performance.now());
    const n = REDUCED_MOTION ? (destroyed ? 6 : 0) : destroyed ? 22 : 6;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (destroyed ? 2.5 : 1.4) * (0.4 + Math.random());
      this.particles.push({
        x: c[0],
        y: c[1],
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 2,
        life: 0,
        max: 40 + Math.random() * 30,
        color: destroyed && i % 2 ? color : (this.data.cube ? strataColor(this.data.cube.currentLayer, this.data.cube.size) : color),
        size: Math.max(1.5, this.tw * (destroyed ? 0.12 : 0.07)),
      });
    }
    if (label) this.texts.push({ x: c[0], y: c[1] - 6, text: label, color, life: 0 });
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  }

  // --- Rendu ---------------------------------------------------------------

  private draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const now = performance.now();
    const time = (now - this.t0) / 1000;

    // Ciel
    const sky = ctx.createLinearGradient(0, 0, 0, this.h);
    sky.addColorStop(0, '#0b0e1d');
    sky.addColorStop(1, '#1c1838');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawStars(time);

    const { boardH } = this.layout();
    this.drawGround();
    this.drawBillboard(boardH, time);
    this.drawCube(now);
    this.drawEffects();

    if (this.data.message) {
      ctx.fillStyle = 'rgba(8,10,22,0.72)';
      ctx.fillRect(0, this.h / 2 - 34, this.w, 68);
      ctx.fillStyle = '#ffe08a';
      ctx.font = `600 ${Math.max(15, Math.min(22, this.w / 24))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.data.message, this.w / 2, this.h / 2);
    }
  }

  private drawStars(time: number) {
    const ctx = this.ctx;
    for (let i = 0; i < 50; i++) {
      const x = (i * 97.3) % this.w;
      const y = (i * 53.7) % (this.h * 0.6);
      const a = 0.3 + 0.3 * Math.sin(time * 1.3 + i);
      ctx.fillStyle = `rgba(255,255,240,${a})`;
      ctx.fillRect(x, y, 1.5, 1.5);
    }
  }

  private drawGround() {
    const ctx = this.ctx;
    const size = this.data.cube?.size ?? 10;
    const [cx, cy] = this.pt(size / 2, size / 2, 0);
    const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, size * this.tw * 0.9);
    g.addColorStop(0, 'rgba(120,100,180,0.35)');
    g.addColorStop(1, 'rgba(120,100,180,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, size * this.tw * 0.85, size * this.th * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private poly(points: [number, number][], fill: string, stroke?: string) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private drawCube(now: number) {
    const cube = this.data.cube;
    const ctx = this.ctx;
    if (!cube) return;
    const size = cube.size;
    const remainingLayers = size - cube.currentLayer; // couches non vides (courante incluse)

    // Silhouette fantôme du cube d'origine.
    ctx.save();
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    const top = [this.pt(0, 0, size), this.pt(size, 0, size), this.pt(size, size, size), this.pt(0, size, size)];
    ctx.beginPath();
    ctx.moveTo(...top[0]);
    for (const p of top.slice(1)) ctx.lineTo(...p);
    ctx.closePath();
    ctx.moveTo(...this.pt(0, size, size));
    ctx.lineTo(...this.pt(0, size, 0));
    ctx.moveTo(...this.pt(size, size, size));
    ctx.lineTo(...this.pt(size, size, 0));
    ctx.moveTo(...this.pt(size, 0, size));
    ctx.lineTo(...this.pt(size, 0, 0));
    ctx.stroke();
    ctx.restore();

    if (remainingLayers <= 0) return;

    // Prisme des couches intactes sous la couche courante (z de 0 à remaining-1).
    const below = remainingLayers - 1;
    for (let k = 0; k < below; k++) {
      const layer = size - 1 - k; // couche réelle (0 = sommet d'origine)
      const col = strataColor(layer, size);
      // Face gauche (le long de y = size)
      this.poly([this.pt(0, size, k), this.pt(size, size, k), this.pt(size, size, k + 1), this.pt(0, size, k + 1)], shade(col, 0.72));
      // Face droite (le long de x = size)
      this.poly([this.pt(size, 0, k), this.pt(size, size, k), this.pt(size, size, k + 1), this.pt(size, 0, k + 1)], shade(col, 0.55));
    }
    if (below > 0) {
      const col = strataColor(cube.currentLayer + 1, size);
      // Dessus des couches intactes (visible à travers les trous)
      this.poly([this.pt(0, 0, below), this.pt(size, 0, below), this.pt(size, size, below), this.pt(0, size, below)], shade(col, 0.8));
      // Quadrillage discret
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.beginPath();
      for (let i = 1; i < size; i++) {
        ctx.moveTo(...this.pt(i, 0, below));
        ctx.lineTo(...this.pt(i, size, below));
        ctx.moveTo(...this.pt(0, i, below));
        ctx.lineTo(...this.pt(size, i, below));
      }
      ctx.stroke();
    }

    // Couche courante, bloc par bloc, de l'arrière vers l'avant.
    const col = strataColor(cube.currentLayer, size);
    const maxHp = cube.layerMaxHp[cube.currentLayer] ?? 1;
    const z0 = below;
    const z1 = below + 1;
    const isLast = cube.layerRemaining[cube.currentLayer] === 1 && cube.currentLayer === size - 1;
    for (let s = 0; s <= 2 * (size - 1); s++) {
      for (let gx = Math.max(0, s - size + 1); gx <= Math.min(size - 1, s); gx++) {
        const gy = s - gx;
        const idx = gy * size + gx;
        const hp = cube.currentHp[idx];
        if (!(hp > 0)) continue;
        let jx = 0;
        const sh = this.shake.get(idx);
        if (sh !== undefined) {
          const dt = now - sh;
          if (dt > 160) this.shake.delete(idx);
          else jx = Math.sin(dt / 12) * 2 * (1 - dt / 160);
        }
        const P = (x: number, y: number, z: number): [number, number] => {
          const p = this.pt(x, y, z);
          return [p[0] + jx, p[1]];
        };
        const base = isLast ? '#f2c14e' : col;
        const dmg = 1 - hp / maxHp;
        const topCol = shade(base, 1.08 - dmg * 0.35);
        this.poly([P(gx, gy + 1, z0), P(gx + 1, gy + 1, z0), P(gx + 1, gy + 1, z1), P(gx, gy + 1, z1)], shade(base, 0.72), 'rgba(0,0,0,0.25)');
        this.poly([P(gx + 1, gy, z0), P(gx + 1, gy + 1, z0), P(gx + 1, gy + 1, z1), P(gx + 1, gy, z1)], shade(base, 0.55), 'rgba(0,0,0,0.25)');
        this.poly([P(gx, gy, z1), P(gx + 1, gy, z1), P(gx + 1, gy + 1, z1), P(gx, gy + 1, z1)], topCol, 'rgba(0,0,0,0.22)');
        if (dmg > 0) this.drawCracks(P, gx, gy, z1, dmg, idx);
        if (idx === this.data.selected || idx === this.hover) {
          ctx.save();
          ctx.lineWidth = idx === this.data.selected ? 2.5 : 1.5;
          ctx.strokeStyle = idx === this.data.selected ? '#ffe08a' : 'rgba(255,255,255,0.7)';
          ctx.beginPath();
          ctx.moveTo(...P(gx, gy, z1));
          ctx.lineTo(...P(gx + 1, gy, z1));
          ctx.lineTo(...P(gx + 1, gy + 1, z1));
          ctx.lineTo(...P(gx, gy + 1, z1));
          ctx.closePath();
          ctx.stroke();
          ctx.restore();
        }
        if (isLast) {
          const [cx, cy] = P(gx + 0.5, gy + 0.5, z1);
          const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, this.tw * 1.6);
          glow.addColorStop(0, 'rgba(255,224,138,0.45)');
          glow.addColorStop(1, 'rgba(255,224,138,0)');
          ctx.fillStyle = glow;
          ctx.fillRect(cx - this.tw * 2, cy - this.tw * 2, this.tw * 4, this.tw * 4);
        }
      }
    }
  }

  private drawCracks(P: (x: number, y: number, z: number) => [number, number], gx: number, gy: number, z: number, dmg: number, seed: number) {
    const ctx = this.ctx;
    const lines = Math.ceil(dmg * 4);
    ctx.strokeStyle = `rgba(20,12,8,${0.35 + dmg * 0.4})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < lines; i++) {
      const r = (k: number) => ((Math.sin(seed * 12.9898 + i * 78.233 + k * 37.719) * 43758.5453) % 1 + 1) % 1;
      const a = P(gx + 0.5, gy + 0.5, z);
      const b = P(gx + 0.15 + r(1) * 0.7, gy + 0.15 + r(2) * 0.7, z);
      ctx.moveTo(...a);
      ctx.lineTo(...b);
    }
    ctx.stroke();
  }

  private trackRanks(now: number) {
    const board = this.data.leaderboard;
    if (board === this.lastBoard) return;
    this.lastBoard = board;
    for (const e of board) {
      const prev = this.prevRanks.get(e.playerId);
      if (prev !== undefined && e.rank < prev) this.rankUpAt.set(e.playerId, now);
    }
    this.prevRanks = new Map(board.map((e) => [e.playerId, e.rank]));
  }

  private fit(text: string, maxW: number): string {
    const ctx = this.ctx;
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  /**
   * Panneau géant : podium (or, argent, bronze), barre de contribution
   * relative au premier, brigade, flèche de progression, ma position si je
   * suis hors du top affiché, avancement du cube et alerte Pierre finale.
   */
  private drawBillboard(boardH: number, time: number) {
    const ctx = this.ctx;
    const now = performance.now();
    this.trackRanks(now);
    const wide = this.w > 480;
    const bw = Math.min(this.w - 16, 640);
    const bx = (this.w - bw) / 2;
    const by = 8;
    const bh = boardH - 8;
    const postW = Math.max(6, bw * 0.018);
    // Poteaux reliant le panneau au cube.
    ctx.fillStyle = '#2a2540';
    ctx.fillRect(bx + bw * 0.18, by + bh, postW, 18);
    ctx.fillRect(bx + bw * 0.82 - postW, by + bh, postW, 18);
    // Cadre
    ctx.fillStyle = '#2e2a4a';
    roundRect(ctx, bx, by, bw, bh, 10);
    ctx.fill();
    const inner = ctx.createLinearGradient(0, by, 0, by + bh);
    inner.addColorStop(0, '#16132f');
    inner.addColorStop(1, '#0d0b22');
    ctx.fillStyle = inner;
    roundRect(ctx, bx + 6, by + 6, bw - 12, bh - 12, 7);
    ctx.fill();
    // Ampoules
    const bulbs = Math.floor(bw / 22);
    for (let i = 0; i < bulbs; i++) {
      const on = REDUCED_MOTION ? i % 2 === 0 : Math.sin(time * 4 - i * 0.6) > 0;
      ctx.fillStyle = on ? '#ffd76a' : '#5b4a22';
      ctx.beginPath();
      ctx.arc(bx + 11 + (i * (bw - 22)) / (bulbs - 1), by + 3, 2.4, 0, Math.PI * 2);
      ctx.arc(bx + 11 + (i * (bw - 22)) / (bulbs - 1), by + bh - 3, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    const pad = 16;
    const left = bx + pad;
    const right = bx + bw - pad;
    // En-tête : titre + saison / compte à rebours.
    const titleSize = wide ? 15 : 12.5;
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${titleSize}px system-ui, sans-serif`;
    ctx.fillStyle = '#ffe08a';
    let y = by + 20;
    if (wide) {
      ctx.textAlign = 'left';
      ctx.fillText('★ PANNEAU DES MINEURS', left, y);
      ctx.textAlign = 'right';
      ctx.font = `600 12px system-ui, sans-serif`;
      ctx.fillStyle = '#b9b4dc';
      ctx.fillText(this.fit([this.data.seasonName, this.data.countdown].filter(Boolean).join(' · '), bw * 0.45), right, y);
    } else {
      // Mobile : la saison et le compte à rebours figurent déjà dans la barre du haut.
      ctx.textAlign = 'center';
      ctx.fillText(this.fit(`★ MINEURS — ${this.data.seasonName.toUpperCase() || 'INTERSAISON'} ★`, bw - 2 * pad), bx + bw / 2, y);
    }

    // Pied : avancement du cube (+ bannière Pierre finale).
    const cube = this.data.cube;
    const footY = by + bh - 17;
    if (cube) {
      const frac = cube.destroyedBlocks / cube.totalBlocks;
      const lastLayer = cube.currentLayer === cube.size - 1;
      const finalStone = lastLayer && cube.layerRemaining[cube.currentLayer] === 1;
      ctx.font = `700 10.5px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ece9f5';
      const label = lastLayer ? (finalStone ? '◆ PIERRE FINALE EN JEU' : 'DERNIÈRE COUCHE') : `Cube ${(frac * 100).toFixed(1)} %`;
      if (lastLayer) {
        const pulse = REDUCED_MOTION ? 1 : 0.6 + 0.4 * Math.sin(time * 6);
        ctx.fillStyle = `rgba(255,${finalStone ? 120 : 210},${finalStone ? 90 : 120},${pulse})`;
      }
      ctx.fillText(label, left, footY);
      const barX = left + ctx.measureText(label).width + 10;
      const barW = right - barX;
      ctx.fillStyle = '#26224a';
      roundRect(ctx, barX, footY - 4, barW, 8, 4);
      ctx.fill();
      ctx.fillStyle = '#f2c14e';
      roundRect(ctx, barX, footY - 4, Math.max(8, barW * frac), 8, 4);
      ctx.fill();
    }

    // Lignes du classement.
    const listTop = y + 13;
    const listBottom = cube ? footY - 11 : by + bh - 12;
    const entries = this.data.leaderboard;
    const me = this.data.me;
    const meVisible = entries.some((e) => e.playerId === this.data.myId);
    const showMeLine = !!me && me.rank !== null && !meVisible && entries.length > 0;
    // Espace réservé à « ma » ligne (séparateur + ligne de 16 px), sans chevaucher le pied.
    const ME_LINE_H = 30;
    const avail = listBottom - listTop - (showMeLine ? ME_LINE_H : 0);
    const twoCols = wide && entries.length > 5;
    const rowH = Math.max(16, Math.min(24, avail / (twoCols ? 5 : Math.min(5, Math.max(entries.length, 1)))));
    const fitRows = Math.max(1, Math.floor(avail / rowH));
    // Deux colonnes équilibrées (5 + 5 au maximum).
    const perCol = twoCols ? Math.min(fitRows, Math.ceil(Math.min(entries.length, fitRows * 2) / 2)) : fitRows;
    const shown = entries.slice(0, twoCols ? perCol * 2 : perCol);
    if (!cube && this.data.lastSeason) {
      // Intersaison : le panneau honore les titres de la saison écoulée.
      const s = this.data.lastSeason;
      const lines: [string, string, string][] = [
        ['🏆', 'Champion', s.championName ?? '—'],
        ['⚑', 'Brigade championne', s.championBrigadeName ?? '—'],
        ['◆', 'Pierre finale', s.finalStoneName ?? (s.endReason === 'completed' ? '—' : 'non attribuée')],
      ];
      const lh = Math.min(26, (listBottom - listTop) / 4);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffe08a';
      ctx.font = `800 ${Math.min(14, lh * 0.6)}px system-ui, sans-serif`;
      ctx.fillText(this.fit(`${s.name.toUpperCase()} TERMINÉE`, bw - 2 * pad), bx + bw / 2, listTop + lh / 2);
      lines.forEach(([icon, label, value], i) => {
        const cy = listTop + (i + 1.5) * lh;
        ctx.font = `600 ${Math.min(13, lh * 0.55)}px system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#b9b4dc';
        ctx.fillText(`${icon} ${label}`, left, cy);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#f4f1ea';
        ctx.font = `700 ${Math.min(14, lh * 0.6)}px system-ui, sans-serif`;
        ctx.fillText(this.fit(value, (right - left) * 0.5), right, cy);
      });
      return;
    }
    if (shown.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.textAlign = 'center';
      ctx.font = `600 13px system-ui, sans-serif`;
      ctx.fillText('Aucun coup pour l\'instant — soyez le premier !', bx + bw / 2, (listTop + listBottom) / 2);
      return;
    }
    const top = shown[0].hits || 1;
    const colGap = 14;
    const colW = twoCols ? (right - left - colGap) / 2 : right - left;
    shown.forEach((e, i) => {
      const col = twoCols && i >= perCol ? 1 : 0;
      const row = col ? i - perCol : i;
      const x = left + col * (colW + colGap);
      const cy = listTop + row * rowH + rowH / 2;
      this.drawRow(e.rank, e.name, e.skin, e.hits, e.brigadeName, x, cy, colW, rowH, e.hits / top, e.playerId === this.data.myId, this.rankUpAt.get(e.playerId), now);
    });
    if (showMeLine && me) {
      const base = listTop + Math.min(perCol, shown.length) * rowH;
      ctx.fillStyle = '#8c86b0';
      ctx.textAlign = 'center';
      ctx.font = `700 10px system-ui, sans-serif`;
      ctx.fillText('• • •', bx + bw / 2, base + 6);
      this.drawRow(me.rank!, me.name, me.skin, me.hits, null, left, base + 20, twoCols ? colW : right - left, 16, me.hits / top, true, undefined, now);
    }
  }

  private drawRow(
    rank: number,
    name: string,
    skin: string,
    hits: number,
    brigade: string | null,
    x: number,
    cy: number,
    w: number,
    h: number,
    share: number,
    mine: boolean,
    rankUpAt: number | undefined,
    now: number,
  ) {
    const ctx = this.ctx;
    const podium = rank <= 3;
    const flash = rankUpAt !== undefined && now - rankUpAt < 3000;
    // Barre de contribution relative au premier.
    ctx.fillStyle = mine ? 'rgba(255,224,138,0.16)' : flash ? 'rgba(91,227,154,0.14)' : 'rgba(255,255,255,0.045)';
    roundRect(ctx, x - 4, cy - h / 2 + 1.5, (w + 4) * Math.max(0.04, Math.min(1, share)), h - 3, 4);
    ctx.fill();
    if (mine) {
      ctx.strokeStyle = 'rgba(255,224,138,0.55)';
      ctx.lineWidth = 1;
      roundRect(ctx, x - 4, cy - h / 2 + 1.5, w + 4, h - 3, 4);
      ctx.stroke();
    }
    // Médaille / rang
    const r = Math.min(h * 0.38, 9);
    const medal = rank === 1 ? '#ffd24a' : rank === 2 ? '#d5dbe6' : rank === 3 ? '#d08a4a' : null;
    ctx.textBaseline = 'middle';
    if (medal) {
      ctx.fillStyle = medal;
      ctx.beginPath();
      ctx.arc(x + r, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1405';
      ctx.font = `800 ${r * 1.2}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(String(rank), x + r, cy + 0.5);
    } else {
      ctx.fillStyle = '#8c86b0';
      ctx.font = `700 ${Math.min(12, h * 0.55)}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(String(rank), x + r, cy);
    }
    // Score (et flèche de montée)
    const fs = Math.max(10.5, Math.min(podium ? 15 : 13.5, h * 0.62));
    ctx.font = `700 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f4f1ea';
    const score = hits.toLocaleString('fr-FR');
    ctx.fillText(score, x + w - 4, cy);
    const scoreW = ctx.measureText(score).width;
    if (flash) {
      ctx.fillStyle = '#5be39a';
      ctx.fillText('▲', x + w - 10 - scoreW, cy);
    }
    // Nom + brigade
    const nameX = x + r * 2 + 8;
    const nameMax = x + w - scoreW - (flash ? 26 : 14) - nameX;
    ctx.textAlign = 'left';
    ctx.font = `${podium ? 700 : 600} ${fs}px system-ui, sans-serif`;
    ctx.fillStyle = skinById(skin).color;
    const shownName = this.fit(name, nameMax);
    ctx.fillText(shownName, nameX, cy);
    const used = ctx.measureText(shownName).width;
    if (brigade && nameMax - used > 40) {
      ctx.font = `600 ${Math.max(9, fs - 4)}px system-ui, sans-serif`;
      ctx.fillStyle = '#8c86b0';
      ctx.fillText(this.fit(`[${brigade}]`, nameMax - used - 6), nameX + used + 6, cy + 0.5);
    }
  }

  private drawEffects() {
    const ctx = this.ctx;
    this.particles = this.particles.filter((p) => {
      p.life++;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15;
      const a = 1 - p.life / p.max;
      if (a <= 0) return false;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
      return true;
    });
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.font = '700 14px system-ui, sans-serif';
    this.texts = this.texts.filter((t) => {
      t.life++;
      const a = 1 - t.life / 50;
      if (a <= 0) return false;
      ctx.globalAlpha = a;
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y - t.life * 0.6);
      return true;
    });
    ctx.globalAlpha = 1;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
