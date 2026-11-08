import { Camera, TILT } from './camera.js';
import { hash2, toXY, visibleRange, type FaceData } from './face.js';
import { attachGestures, type PointerKind } from './gestures.js';
import { shade, strataColor } from './palette.js';
import type { ViewCamera, WorldView } from './view.js';
import { drawCenteredMessage } from './labels.js';

/**
 * Rendu Canvas 2D de la face jouable vue par la caméra.
 *
 * - Seuls les blocs visibles sont dessinés (culling), regroupés par couleur
 *   dans des chemins pour limiter le nombre d'appels de dessin.
 * - Rendu à la demande : la boucle d'animation ne tourne que si la caméra
 *   bouge, si un effet est en cours ou si un coup attend sa confirmation.
 * - Ce module n'invente aucun état de jeu : il affiche les PV transmis par
 *   le serveur et des effets déclenchés par ses confirmations.
 */

export type ImpactKind = 'confirmed' | 'other' | 'destroyed' | 'otherDestroyed' | 'refused';

export interface SurfaceState {
  face: FaceData | null;
  /** Nombre total de couches du cube (pour la falaise). */
  cubeSize: number;
  selected: number | null;
  /** Blocs ayant un coup envoyé et pas encore confirmé. */
  pending: ReadonlySet<number>;
  offline: boolean;
  message: string | null;
}

export interface WorldLayer {
  /** Dessiné avant la face (ex. panneau au nord). */
  under?(ctx: CanvasRenderingContext2D, cam: ViewCamera, time: number): void;
  /** Dessiné après la face (ex. marqueurs de présence). */
  over?(ctx: CanvasRenderingContext2D, cam: ViewCamera, time: number): void;
  /** Vrai si la couche demande une animation continue. */
  animating?(): boolean;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
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
  t0: number;
}

interface Flash {
  idx: number;
  kind: ImpactKind;
  t0: number;
}

export const WALL = 0.5; // hauteur visible d'une couche, en fraction de la largeur d'un bloc
const SCALE_STEP = 8; // repère d'échelle tous les 8 blocs

export class SurfaceView implements WorldView {
  readonly kind = 'classic' as const;
  readonly camera = new Camera();
  state: SurfaceState = { face: null, cubeSize: 1, selected: null, pending: new Set(), offline: false, message: null };
  lowFx = false;
  reducedMotion = false;
  layers: WorldLayer[] = [];
  /** Vitesse de déplacement clavier (px/s). */
  keyPan = { x: 0, y: 0 };
  onTap: (wx: number, wy: number, kind: PointerKind) => void = () => {};
  onCameraMove: () => void = () => {};

  private ctx: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private hover: number | null = null;
  private flashes: Flash[] = [];
  private particles: Particle[] = [];
  private texts: FloatText[] = [];
  private shakeUntil = 0;
  private frameTimes: number[] = [];
  private resizeObs: ResizeObserver | null = null;
  private disposed = false;
  /** Intervalles entre images consécutives pendant une animation (fluidité réellement obtenue). */
  private frameIntervals: number[] = [];
  private lastAny = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas);
    this.resize();
    attachGestures(
      canvas,
      {
        start: () => this.camera.stop(),
        pan: (dx, dy) => {
          this.camera.panByScreen(dx, dy);
          this.moved();
        },
        panEnd: (vx, vy) => {
          this.camera.fling(vx, vy);
          this.requestRender();
        },
        pinch: (scale, cx, cy, dx, dy) => {
          this.camera.zoomAt(scale, cx, cy);
          this.camera.panByScreen(dx, dy);
          this.moved();
        },
        tap: (x, y, kind) => {
          const [wx, wy] = this.camera.screenToWorld(x, y);
          this.onTap(wx, wy, kind);
        },
      },
      (deltaY, x, y) => {
        this.camera.zoomAt(Math.exp(-deltaY * 0.0015), x, y);
        this.moved();
      },
    );
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const r = canvas.getBoundingClientRect();
      const [wx, wy] = this.camera.screenToWorld(e.clientX - r.left, e.clientY - r.top);
      const f = this.state.face;
      const idx = f && wx >= 0 && wy >= 0 && wx < f.size && wy < f.size ? Math.floor(wy) * f.size + Math.floor(wx) : null;
      if (idx !== this.hover) {
        this.hover = idx;
        this.requestRender();
      }
    });
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.requestRender();
    });
  }

  private moved() {
    this.onCameraMove();
    this.requestRender();
  }

  setState(patch: Partial<SurfaceState>) {
    this.state = { ...this.state, ...patch };
    this.requestRender();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(this.lowFx ? 1 : 2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.camera.setViewport(this.w, this.h);
    this.requestRender();
  }

  requestRender() {
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.frame);
  }

  dispose() {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObs?.disconnect();
  }

  /** Intervalles des dernières images animées (ms). */
  get recentFrameIntervals(): number[] {
    return [...this.frameIntervals];
  }

  /** Durées des dernières images (ms), pour la mesure de performance. */
  get recentFrameTimes(): number[] {
    return [...this.frameTimes];
  }

  // --- Effets (déclenchés uniquement par des confirmations serveur) ---------

  impact(idx: number, kind: ImpactKind, color = '#ffe08a', label?: string) {
    const f = this.state.face;
    if (!f) return;
    const now = performance.now();
    if (label) {
      const p = toXY(idx, f.size);
      this.texts.push({ x: p.x + 0.5, y: p.y + 0.2, text: label, color, t0: now });
      if (this.texts.length > 20) this.texts.shift();
    }
    this.flashes.push({ idx, kind, t0: now });
    if (this.flashes.length > 80) this.flashes.splice(0, this.flashes.length - 80);
    const { x, y } = toXY(idx, f.size);
    const destroyed = kind === 'destroyed' || kind === 'otherDestroyed';
    const mine = kind === 'confirmed' || kind === 'destroyed';
    if (kind !== 'refused') {
      const n = this.lowFx || this.reducedMotion ? (destroyed ? 5 : 0) : destroyed ? (mine ? 26 : 12) : mine ? 7 : 2;
      const base = strataColor(f.layer, Math.max(f.size, this.state.cubeSize));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = (destroyed ? 2.6 : 1.4) * (0.4 + Math.random());
        this.particles.push({
          x: x + 0.5 + (Math.random() - 0.5) * 0.4,
          y: y + 0.5 + (Math.random() - 0.5) * 0.4,
          z: 0.2,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp * 0.7,
          vz: 2 + Math.random() * (destroyed ? 4 : 2.5),
          life: 0,
          max: 0.5 + Math.random() * 0.5,
          color: mine && i % 3 === 0 ? color : i % 2 ? shade(base, 0.8) : shade(base, 1.15),
          size: destroyed ? 0.09 + Math.random() * 0.08 : 0.05 + Math.random() * 0.05,
        });
      }
      if (this.particles.length > 500) this.particles.splice(0, this.particles.length - 500);
    }
    if (kind === 'destroyed' && !this.reducedMotion && !this.lowFx) this.shakeUntil = now + 180;
    this.requestRender();
  }

  // --- Boucle de rendu -------------------------------------------------------

  private frame = (t: number) => {
    this.raf = 0;
    // Fluidité réelle, glisser compris : intervalle entre deux images rapprochées (< 1 s).
    if (this.lastAny && t - this.lastAny < 1000) {
      this.frameIntervals.push(t - this.lastAny);
      if (this.frameIntervals.length > 120) this.frameIntervals.shift();
    }
    this.lastAny = t;
    const dt = this.last ? Math.min(64, t - this.last) : 16;
    this.last = t;
    let keep = false;
    if (this.keyPan.x || this.keyPan.y) {
      this.camera.panByScreen((-this.keyPan.x * dt) / 1000, (-this.keyPan.y * dt) / 1000);
      this.onCameraMove();
      keep = true;
    }
    if (this.camera.update(dt)) {
      this.onCameraMove();
      keep = true;
    }
    const t0 = performance.now();
    this.draw(t);
    this.frameTimes.push(performance.now() - t0);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
    const fxActive = this.particles.length > 0 || this.flashes.length > 0 || this.texts.length > 0 || t < this.shakeUntil;
    const layersActive = this.layers.some((l) => l.animating?.());
    if (keep || this.camera.animating || fxActive || this.state.pending.size > 0 || layersActive) this.requestRender();
    else this.last = 0;
  };

  private draw(time: number) {
    const ctx = this.ctx;
    const cam = this.camera;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Ciel / abîme
    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, '#0a0c1c');
    g.addColorStop(1, '#17132e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    let sx = 0;
    let sy = 0;
    if (time < this.shakeUntil) {
      const k = (this.shakeUntil - time) / 180;
      sx = (Math.random() - 0.5) * 5 * k;
      sy = (Math.random() - 0.5) * 5 * k;
      ctx.translate(sx, sy);
    }
    for (const l of this.layers) l.under?.(ctx, cam, time);

    const f = this.state.face;
    if (f) {
      this.drawCliff(f);
      this.drawFace(f, time);
      this.drawScale(f);
      this.drawEffects(f, time);
    }
    for (const l of this.layers) l.over?.(ctx, cam, time);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Brume au loin (haut de l'écran) : impression de profondeur.
    const fog = ctx.createLinearGradient(0, 0, 0, this.h * 0.35);
    fog.addColorStop(0, 'rgba(10,12,28,0.55)');
    fog.addColorStop(1, 'rgba(10,12,28,0)');
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, this.w, this.h * 0.35);

    if (this.state.offline || this.state.message) {
      ctx.fillStyle = 'rgba(8,10,22,0.55)';
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.fillStyle = '#ffe08a';
      drawCenteredMessage(ctx, this.state.message ?? 'Reconnexion… (état figé)', this.w, this.h);
    }
  }

  /** Falaise sud : les couches restantes, en strates, sous la couche courante. */
  private drawCliff(f: FaceData) {
    const ctx = this.ctx;
    const cam = this.camera;
    const z = cam.zoom;
    const remaining = Math.max(1, this.state.cubeSize - f.layer);
    const [, top] = cam.worldToScreen(0, f.size);
    if (top > this.h) return;
    const [xl] = cam.worldToScreen(0, 0);
    const [xr] = cam.worldToScreen(f.size, 0);
    const band = z * WALL;
    const left = Math.max(-2, xl);
    const right = Math.min(this.w + 2, xr);
    // Couche courante : face avant des blocs encore présents de la dernière rangée.
    const row = f.size - 1;
    ctx.fillStyle = shade(strataColor(f.layer, this.state.cubeSize), 0.62);
    ctx.beginPath();
    const { x0, x1 } = visibleRange(f.size, cam.visibleWorld().minX, 0, cam.visibleWorld().maxX, 1);
    for (let x = x0; x <= x1; x++) {
      if (f.hp[row * f.size + x] > 0) {
        const [px] = cam.worldToScreen(x, 0);
        ctx.rect(px, top, z, band);
      }
    }
    ctx.fill();
    for (let k = 1; k < remaining; k++) {
      const y = top + k * band;
      if (y > this.h) break;
      ctx.fillStyle = shade(strataColor(f.layer + k, this.state.cubeSize), 0.62 - Math.min(0.25, k * 0.01));
      ctx.fillRect(left, y, right - left, band + 0.5);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(left, y, right - left, 1);
    }
    // Ombre portée au pied de la falaise
    const bottom = top + remaining * band;
    if (bottom < this.h) {
      const g = ctx.createLinearGradient(0, bottom, 0, bottom + band * 3);
      g.addColorStop(0, 'rgba(0,0,0,0.5)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(left, bottom, right - left, band * 3);
    }
  }

  private drawFace(f: FaceData, time: number) {
    const ctx = this.ctx;
    const cam = this.camera;
    const z = cam.zoom;
    const th = z * TILT;
    const vw = cam.visibleWorld();
    const r = visibleRange(f.size, vw.minX, vw.minY, vw.maxX, vw.maxY);
    if (r.x1 < r.x0 || r.y1 < r.y0) return;
    const base = strataColor(f.layer, Math.max(this.state.cubeSize, f.size));
    const floor = strataColor(Math.min(f.layer + 1, this.state.cubeSize - 1), Math.max(this.state.cubeSize, f.size));
    const gap = z >= 10 ? Math.max(1, z * 0.045) : 0;
    const wall = Math.min(th, z * WALL);
    const detail = z >= 18;
    const texture = z >= 26 && !this.lowFx;

    // Chemins regroupés : 4 variantes de teinte × 4 niveaux de dégâts.
    const tiles: Path2D[] = Array.from({ length: 16 }, () => new Path2D());
    const floors = new Path2D();
    const walls = new Path2D();
    const sideShadow = new Path2D();
    const hi = new Path2D();
    const lo = new Path2D();
    const cracks = new Path2D();
    const specks = new Path2D();
    const [ox, oy] = cam.worldToScreen(r.x0, r.y0);
    // Joint entre les blocs : teinte sombre de la roche (et non le vide noir).
    if (gap > 0) {
      const [mx1, my1] = cam.worldToScreen(r.x1 + 1, r.y1 + 1);
      ctx.fillStyle = shade(base, 0.42);
      ctx.fillRect(ox, oy, mx1 - ox, my1 - oy);
    }

    for (let y = r.y0; y <= r.y1; y++) {
      const py = oy + (y - r.y0) * th;
      for (let x = r.x0; x <= r.x1; x++) {
        const px = ox + (x - r.x0) * z;
        const idx = y * f.size + x;
        const hp = f.hp[idx];
        if (hp > 0) {
          const v = Math.floor(hash2(x, y) * 4);
          const dmg = Math.min(3, Math.ceil((1 - hp / f.maxHp) * 3));
          tiles[v * 4 + dmg].rect(px, py, z - gap, th - gap);
          if (detail) {
            hi.rect(px, py, z - gap, Math.max(1, z * 0.05));
            lo.rect(px, py + th - gap - Math.max(1, z * 0.07), z - gap, Math.max(1, z * 0.07));
          }
          if (detail && dmg > 0) this.crackPath(cracks, px, py, z - gap, th - gap, x, y, dmg);
          if (texture) {
            for (let k = 0; k < 3; k++) {
              const a = hash2(x, y, k + 1);
              const b = hash2(x, y, k + 7);
              specks.rect(px + a * (z - gap - 3), py + b * (th - gap - 3), Math.max(1.2, z * 0.05), Math.max(1.2, z * 0.05));
            }
          }
        } else {
          // Puits : le sol de la couche inférieure, le mur nord et l'ombre du mur ouest.
          floors.rect(px, py, z - gap, th - gap); // blocs de la couche inférieure
          const northAlive = y > 0 && f.hp[idx - f.size] > 0;
          if (northAlive) walls.rect(px, py, z, wall);
          if (x > 0 && f.hp[idx - 1] > 0) sideShadow.rect(px, py, Math.max(1.5, z * 0.14), th);
        }
      }
    }
    ctx.fillStyle = shade(floor, 0.46);
    ctx.fill(floors);
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fill(sideShadow);
    ctx.fillStyle = shade(base, 0.74);
    ctx.fill(walls);
    for (let v = 0; v < 4; v++) {
      for (let d = 0; d < 4; d++) {
        ctx.fillStyle = shade(base, 0.94 + v * 0.04 - d * 0.1);
        ctx.fill(tiles[v * 4 + d]);
      }
    }
    if (detail) {
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      ctx.fill(hi);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fill(lo);
      ctx.strokeStyle = 'rgba(28,16,8,0.6)';
      ctx.lineWidth = Math.max(1, z * 0.03);
      ctx.stroke(cracks);
    }
    if (texture) {
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fill(specks);
    }

    // Survol, sélection, coups en attente
    const outline = (idx: number, color: string, width: number, dash?: number[]) => {
      const { x, y } = toXY(idx, f.size);
      const [px, py] = cam.worldToScreen(x, y);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) {
        ctx.setLineDash(dash);
        ctx.lineDashOffset = -time / 40;
      }
      ctx.strokeRect(px + width / 2, py + width / 2, z - gap - width, th - gap - width);
      ctx.restore();
    };
    if (this.hover !== null && this.hover !== this.state.selected && f.hp[this.hover] > 0) outline(this.hover, 'rgba(255,255,255,0.55)', 1.5);
    for (const idx of this.state.pending) outline(idx, 'rgba(255,255,255,0.9)', 2, [4, 3]);
    if (this.state.selected !== null && f.hp[this.state.selected] > 0) {
      const { x, y } = toXY(this.state.selected, f.size);
      const [px, py] = cam.worldToScreen(x, y);
      const pulse = this.reducedMotion ? 1 : 0.75 + 0.25 * Math.sin(time / 260);
      ctx.strokeStyle = `rgba(255,224,138,${pulse})`;
      ctx.lineWidth = Math.max(2.5, z * 0.07);
      ctx.strokeRect(px - 1, py - 1, z - gap + 2, th - gap + 2);
      // Équerres aux coins
      const c = Math.max(5, z * 0.22);
      ctx.strokeStyle = '#fff3c4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [cx, cy, dx, dy] of [
        [px - 4, py - 4, 1, 1],
        [px + z - gap + 4, py - 4, -1, 1],
        [px - 4, py + th - gap + 4, 1, -1],
        [px + z - gap + 4, py + th - gap + 4, -1, -1],
      ]) {
        ctx.moveTo(cx + dx * c, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + dy * c);
      }
      ctx.stroke();
    }
  }

  private crackPath(p: Path2D, px: number, py: number, w: number, h: number, x: number, y: number, dmg: number) {
    const cx = px + w * (0.35 + hash2(x, y, 11) * 0.3);
    const cy = py + h * (0.35 + hash2(x, y, 12) * 0.3);
    for (let i = 0; i < dmg + 1; i++) {
      const a = hash2(x, y, 20 + i) * Math.PI * 2;
      const len = (0.25 + hash2(x, y, 30 + i) * 0.25) * w;
      const mx = cx + Math.cos(a) * len * 0.5 + (hash2(x, y, 40 + i) - 0.5) * w * 0.15;
      const my = cy + Math.sin(a) * len * 0.5 * TILT;
      p.moveTo(cx, cy);
      p.lineTo(mx, my);
      p.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len * TILT);
    }
  }

  /** Repères d'échelle : lignes tous les 8 blocs et graduations en bord d'écran. */
  private drawScale(f: FaceData) {
    const ctx = this.ctx;
    const cam = this.camera;
    if (cam.zoom < 8) return;
    const vw = cam.visibleWorld();
    const [x0, y0] = cam.worldToScreen(0, 0);
    const [x1, y1] = cam.worldToScreen(f.size, f.size);
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = SCALE_STEP; k < f.size; k += SCALE_STEP) {
      if (k >= vw.minX && k <= vw.maxX) {
        const [sx] = cam.worldToScreen(k, 0);
        ctx.moveTo(sx, Math.max(0, y0));
        ctx.lineTo(sx, Math.min(this.h, y1));
      }
      if (k >= vw.minY && k <= vw.maxY) {
        const [, sy] = cam.worldToScreen(0, k);
        ctx.moveTo(Math.max(0, x0), sy);
        ctx.lineTo(Math.min(this.w, x1), sy);
      }
    }
    ctx.stroke();
    // Arête de la face (bords est, ouest et nord) : liseré clair.
    ctx.strokeStyle = 'rgba(255,240,200,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y1);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x1, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    // Graduations
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let k = 0; k <= f.size; k += SCALE_STEP) {
      const [sx] = cam.worldToScreen(k, 0);
      // En haut de la vue (le bas est occupé par les indicateurs), hors de la mini-carte.
      if (sx > 14 && sx < this.w - 110) this.label(String(k), sx, 12);
      const [, sy] = cam.worldToScreen(0, k);
      if (sy > 28 && sy < this.h - 40) this.label(String(k), 12, sy);
    }
  }

  private label(text: string, x: number, y: number) {
    const ctx = this.ctx;
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = 'rgba(10,12,28,0.6)';
    ctx.fillRect(x - w / 2, y - 7, w, 14);
    ctx.fillStyle = 'rgba(236,233,245,0.8)';
    ctx.fillText(text, x, y + 0.5);
  }

  private drawEffects(f: FaceData, time: number) {
    const ctx = this.ctx;
    const cam = this.camera;
    const z = cam.zoom;
    const th = z * TILT;
    // Flashs sur les blocs
    this.flashes = this.flashes.filter((fl) => {
      const age = time - fl.t0;
      const dur = fl.kind === 'refused' ? 420 : fl.kind === 'destroyed' || fl.kind === 'otherDestroyed' ? 520 : 220;
      if (age > dur || age < -50) return false;
      const k = 1 - Math.max(0, age) / dur;
      const { x, y } = toXY(fl.idx, f.size);
      let [px, py] = cam.worldToScreen(x, y);
      if (fl.kind === 'refused' && !this.reducedMotion) px += Math.sin(age / 18) * 3 * k;
      ctx.fillStyle =
        fl.kind === 'refused'
          ? `rgba(255,90,70,${0.55 * k})`
          : fl.kind === 'other'
            ? `rgba(255,255,255,${0.22 * k})`
            : `rgba(255,248,220,${(fl.kind === 'otherDestroyed' ? 0.4 : 0.7) * k})`;
      ctx.fillRect(px, py, z, th);
      if (fl.kind === 'destroyed' || fl.kind === 'otherDestroyed') {
        // Anneau de poussière
        const [cx, cy] = cam.worldToScreen(x + 0.5, y + 0.5);
        ctx.strokeStyle = `rgba(230,215,190,${0.5 * k})`;
        ctx.lineWidth = Math.max(1, z * 0.08 * k);
        ctx.beginPath();
        ctx.ellipse(cx, cy, z * (0.4 + (1 - k) * 0.9), th * (0.4 + (1 - k) * 0.9), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      return true;
    });
    // Fragments (coordonnées du monde, hauteur z)
    const dt = 1 / 60;
    this.particles = this.particles.filter((p) => {
      p.life += dt;
      if (p.life > p.max) return false;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vz -= 14 * dt;
      p.z = Math.max(0, p.z + p.vz * dt);
      const [px, py] = cam.worldToScreen(p.x, p.y);
      ctx.globalAlpha = 1 - p.life / p.max;
      ctx.fillStyle = p.color;
      const s = Math.max(1.5, p.size * z);
      ctx.fillRect(px - s / 2, py - p.z * z * WALL - s / 2, s, s);
      return true;
    });
    ctx.globalAlpha = 1;
    // Textes flottants (« +1 », « bloc ! ») au-dessus du bloc confirmé
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.max(12, Math.min(18, z * 0.38))}px system-ui, sans-serif`;
    this.texts = this.texts.filter((t) => {
      const age = (time - t.t0) / 900;
      if (age > 1 || age < -0.1) return false;
      const [px, py] = cam.worldToScreen(t.x, t.y);
      ctx.globalAlpha = 1 - Math.max(0, age);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(t.text, px + 1, py - age * z * 0.9 + 1);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, px, py - age * z * 0.9);
      return true;
    });
    ctx.globalAlpha = 1;
  }
}
