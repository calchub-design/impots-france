import { BillboardLayer } from '../billboard.js';
import { hash2, toXY, visibleRange, type FaceData } from '../face.js';
import { attachGestures, type PointerKind } from '../gestures.js';
import type { ImpactKind, SurfaceState, WorldLayer } from '../surface.js';
import type { WorldView } from '../view.js';
import { ACTIVE_RATE, GLYPHS, PALETTE, RUNE_RATE, VEIN_RATE, css, layerColor, mix, plateNoise, scale, type RGB } from './material.js';
import { paintHologram, type HoloData } from './hologram.js';
import { PerspectiveCamera, type Pose, type Vec3 } from './persp.js';
import { drawCenteredMessage } from '../labels.js';

/**
 * Rendu « monolithe » : le cube colossal en vraie perspective (Canvas 2D).
 *
 * - Vue de minage : la surface fuit vers le lointain et se fond dans la brume
 *   nocturne ; les puits creusés montrent leurs parois et la couche du dessous ;
 *   au bord, la falaise des couches restantes plonge dans le vide.
 * - Vue monumentale : le monolithe entier, de 3/4, suspendu dans l'espace.
 *
 * Comme le rendu classique, il n'invente aucun état : il affiche les PV
 * transmis par le serveur, et ses effets ne suivent que des confirmations.
 * Les blocs hors champ ne sont pas dessinés ; le dessin n'a lieu que si
 * quelque chose change.
 */

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

interface Flash {
  idx: number;
  kind: ImpactKind;
  t0: number;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  t0: number;
}

type Pt = [number, number];

/**
 * Lot de polygones découpé en petits chemins. Mesuré dans Chromium : remplir
 * UN chemin de 2 400 quadrilatères coûte ~32 ms (Skia le traite comme une
 * seule forme complexe), contre ~1,2 ms en chemins de 24 : on regroupe donc
 * par couleur, mais par paquets.
 */
class Batch {
  private parts: Path2D[] = [];
  private cur: Path2D | null = null;
  private n = 0;
  static readonly SIZE = 32;

  private next(): Path2D {
    if (!this.cur || this.n >= Batch.SIZE) {
      this.cur = new Path2D();
      this.parts.push(this.cur);
      this.n = 0;
    }
    this.n++;
    return this.cur;
  }

  poly(q: Pt[]) {
    addPoly(this.next(), q);
  }

  dot(x: number, y: number, r: number) {
    addDot(this.next(), x, y, r);
  }

  fill(ctx: CanvasRenderingContext2D) {
    for (const p of this.parts) ctx.fill(p);
  }

  stroke(ctx: CanvasRenderingContext2D) {
    for (const p of this.parts) ctx.stroke(p);
  }
}

const NEAR_CLIP = 0.12;
const FOG_BUCKETS = 6;
/** Panneau : largeur relative à l'arête du cube, rapport hauteur/largeur, altitude. */
/** Écran holographique : largeur relative à l'arête du cube, rapport hauteur/largeur, altitude, position (au-delà du bord nord). */
const BOARD = { width: 1.1, aspect: 0.5, lift: 0.1, y: -2 };
const TEXTURE_STEPS = [384, 640, 896, 1200];

export class MonolithView implements WorldView {
  readonly kind = 'monolith' as const;
  readonly camera = new PerspectiveCamera();
  state: SurfaceState = { face: null, cubeSize: 1, selected: null, pending: new Set(), offline: false, message: null };
  lowFx = false;
  reducedMotion = false;
  layers: WorldLayer[] = [];
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
  private frameIntervals: number[] = [];
  /** Instant de la dernière image « utile » (hors images d'ambiance), pour mesurer la fluidité. */
  private lastAny = 0;
  private ambientNext = false;
  private framingKey = '';
  /** Largeur à l'écran du panneau lors de la dernière image (0 s'il est hors champ). */
  billboardScreenWidth = 0;
  private readonly stars: { x: number; y: number; s: number; a: number; p: number }[] = [];
  private readonly boardCanvas: HTMLCanvasElement = document.createElement('canvas');
  /** Ciel mis en cache : redessiné seulement si la taille ou l'orientation changent sensiblement. */
  /** Fond du ciel (dégradé + nébuleuses), périodique en largeur : peint une fois par taille, puis décalé. */
  private readonly nebulaCanvas: HTMLCanvasElement = document.createElement('canvas');
  private nebulaKey = '';
  private boardKey = '';

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    for (let i = 0; i < 220; i++) {
      this.stars.push({ x: hash2(i, 1, 3), y: hash2(i, 2, 3), s: 0.5 + hash2(i, 3, 3) * 1.3, a: 0.25 + hash2(i, 4, 3) * 0.6, p: hash2(i, 5, 3) * 6.28 });
    }
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
        pinch: (scaleF, cx, cy, dx, dy) => {
          this.camera.zoomAt(scaleF, cx, cy);
          this.camera.panByScreen(dx, dy);
          this.moved();
        },
        tap: (x, y, kind) => {
          const hit = this.camera.unproject(x, y);
          if (hit) this.onTap(hit[0], hit[1], kind);
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
      const hit = this.camera.unproject(e.clientX - r.left, e.clientY - r.top);
      const f = this.state.face;
      const idx = f && hit && hit[0] >= 0 && hit[1] >= 0 && hit[0] < f.size && hit[1] < f.size ? Math.floor(hit[1]) * f.size + Math.floor(hit[0]) : null;
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
    const f = this.state.face;
    if (f) {
      this.camera.cubeSize = Math.max(f.size, this.state.cubeSize);
      this.camera.surfaceZ = Math.max(1, this.state.cubeSize - f.layer);
    }
    this.reframe();
    this.requestRender();
  }

  /** Recalcule le cadrage monumental si le cube ou la vue ont changé. */
  private reframe() {
    const c = this.camera;
    const key = `${c.cubeSize}|${c.surfaceZ}|${c.viewW}|${c.viewH}`;
    if (key === this.framingKey) return;
    this.framingKey = key;
    // Le cadrage monumental inclut l'écran holographique au-dessus du cube.
    c.frameMonument(c.cubeSize * (BOARD.lift + BOARD.width * BOARD.aspect) * 0.85);
    c.minZoom = c.monumentalZoom;
    if (c.zoom < c.minZoom) c.zoom = c.minZoom;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    // Le coût de pixellisation domine (mesuré) : 1,5× sur mobile, 2× sur grand écran, 1× en effets réduits.
    const r0 = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(this.lowFx ? 1 : r0.width > 900 ? 2 : 1.5, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.camera.setViewport(this.w, this.h);
    this.reframe();
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

  get recentFrameTimes(): number[] {
    return [...this.frameTimes];
  }

  get recentFrameIntervals(): number[] {
    return [...this.frameIntervals];
  }

  /** Vue monumentale : tout le cube, de 3/4. */
  showMonument() {
    const c = this.camera;
    c.animateTo({ x: c.cubeSize / 2, y: c.cubeSize / 2, zoom: c.monumentalZoom }, this.reducedMotion ? 0 : 900);
    this.requestRender();
  }

  /**
   * « Regarder le panneau » : en attendant la refonte du panneau (étape
   * suivante, à valider), on montre le monolithe entier, où le panneau est
   * toujours visible au-dessus du bord nord.
   */
  lookAtBillboard() {
    this.showMonument();
  }

  /** Vrai si la caméra est (presque) en vue monumentale. */
  get monumental(): boolean {
    return this.camera.t > 0.6;
  }

  // --- Effets (déclenchés uniquement par des confirmations du serveur) ------

  impact(idx: number, kind: ImpactKind, color = PALETTE.gold, label?: string) {
    const f = this.state.face;
    if (!f) return;
    const now = performance.now();
    const H = this.camera.surfaceZ;
    const { x, y } = toXY(idx, f.size);
    this.flashes.push({ idx, kind, t0: now });
    if (this.flashes.length > 80) this.flashes.splice(0, this.flashes.length - 80);
    if (label) {
      this.texts.push({ x: x + 0.5, y: y + 0.5, text: label, color, t0: now });
      if (this.texts.length > 20) this.texts.shift();
    }
    const destroyed = kind === 'destroyed' || kind === 'otherDestroyed';
    const mine = kind === 'confirmed' || kind === 'destroyed';
    if (kind !== 'refused') {
      const n = this.lowFx || this.reducedMotion ? (destroyed ? 5 : 0) : destroyed ? (mine ? 28 : 12) : mine ? 8 : 2;
      const base = layerColor(f.layer, this.camera.cubeSize);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = (destroyed ? 2.4 : 1.3) * (0.4 + Math.random());
        const glow = i % 3 === 0;
        this.particles.push({
          x: x + 0.5 + (Math.random() - 0.5) * 0.5,
          y: y + 0.5 + (Math.random() - 0.5) * 0.5,
          z: H + 0.05,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          vz: 1.5 + Math.random() * (destroyed ? 4.5 : 2.5),
          life: 0,
          max: 0.5 + Math.random() * 0.6,
          color: glow ? (mine ? PALETTE.cyanSoft : PALETTE.amber) : css(scale(base, 1.1 + Math.random() * 0.5)),
          size: destroyed ? 0.08 + Math.random() * 0.08 : 0.05 + Math.random() * 0.05,
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
    // Fluidité réelle, glisser compris : intervalle entre deux images rapprochées (< 1 s),
    // en excluant les images d'ambiance au repos (volontairement espacées).
    const ambientFrame = this.ambientNext;
    this.ambientNext = false;
    if (!ambientFrame && this.lastAny && t - this.lastAny < 1000) {
      this.frameIntervals.push(t - this.lastAny);
      if (this.frameIntervals.length > 120) this.frameIntervals.shift();
    }
    this.lastAny = ambientFrame ? 0 : t;
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
    // Pulsation lente des lignes d'énergie : uniquement si visible et sans « mouvement réduit ».
    const ambient = !this.reducedMotion && !this.lowFx && this.state.face !== null && document.visibilityState === 'visible';
    if (keep || this.camera.animating || fxActive || this.state.pending.size > 0 || layersActive) this.requestRender();
    else if (ambient) {
      this.last = 0;
      setTimeout(() => {
        if (!this.raf) this.ambientNext = true;
        this.requestRender();
      }, 120); // ~8 images/s au repos pour l'ambiance, pas 60
    } else this.last = 0;
  };

  /** Polygone 3D découpé contre le plan proche puis projeté. */
  private poly(pts: Vec3[], p: Pose): Pt[] | null {
    const cam = this.camera;
    const cs = pts.map(([x, y, z]) => cam.toCamera(x, y, z, p));
    const out: Vec3[] = [];
    for (let i = 0; i < cs.length; i++) {
      const a = cs[i];
      const b = cs[(i + 1) % cs.length];
      const ain = a[2] >= NEAR_CLIP;
      const bin = b[2] >= NEAR_CLIP;
      if (ain) out.push(a);
      if (ain !== bin) {
        const k = (NEAR_CLIP - a[2]) / (b[2] - a[2]);
        out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, NEAR_CLIP]);
      }
    }
    if (out.length < 3) return null;
    return out.map(([xc, yc, zc]) => [p.cx + (p.focal * xc) / zc, p.cy - (p.focal * yc) / zc]);
  }

  private fogK(depth: number, p: Pose): number {
    const d = p.focal / this.camera.zoom;
    const span = d * 2.4 + this.camera.cubeSize * 0.6;
    return Math.max(0, Math.min(1, (depth - d * 0.85) / span));
  }

  private draw(time: number) {
    const ctx = this.ctx;
    const cam = this.camera;
    const p = cam.pose;
    this.billboardScreenWidth = 0;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawSkyCached(p);
    if (time < this.shakeUntil) {
      const k = (this.shakeUntil - time) / 180;
      ctx.translate((Math.random() - 0.5) * 5 * k, (Math.random() - 0.5) * 5 * k);
    }
    const f = this.state.face;
    if (f) {
      this.drawUnderGlow(p);
      this.drawSides(f, p, time);
      this.drawTop(f, p, time);
      this.drawEffects(f, p, time);
    }
    for (const l of this.layers) {
      if (l instanceof BillboardLayer) this.drawBillboard(l, p, time);
      else l.over?.(ctx, cam, time);
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // (Le vignettage est un calque CSS composé par le navigateur : aucun coût ici.)
    if (this.state.offline || this.state.message) {
      ctx.fillStyle = 'rgba(4,5,13,0.6)';
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.fillStyle = PALETTE.cyanSoft;
      drawCenteredMessage(ctx, this.state.message ?? 'Liaison perdue — reconnexion…', this.w, this.h);
    }
  }

  /**
   * Ciel cosmique : dégradé nuit, nébuleuses, étoiles et lueur d'horizon.
   * Le fond (dégradé, nébuleuses, étoiles) est peint une seule fois par taille dans un
   * motif qui se répète en largeur ; chaque image se contente de le décaler avec la
   * rotation de la caméra (deux copies), puis ajoute la lueur d'horizon.
   */
  private drawSkyCached(p: Pose) {
    const nc = this.nebulaCanvas;
    const nkey = `${this.canvas.width}|${this.canvas.height}`;
    if (nkey !== this.nebulaKey) {
      this.nebulaKey = nkey;
      nc.width = this.canvas.width;
      nc.height = this.canvas.height;
      this.paintSky(nc.getContext('2d', { alpha: false })!);
    }
    const ctx = this.ctx;
    const yaw = Math.atan2(p.r[1], p.r[0]);
    const off = Math.round(((((-yaw * 0.3) % 1) + 1) % 1) * nc.width);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(nc, off - nc.width, 0);
    ctx.drawImage(nc, off, 0);
    ctx.restore();
    // Lueur d'horizon (visible quand la caméra s'abaisse vers la vue monumentale).
    const pitch = Math.asin(-p.f[2]);
    const hy = p.cy - p.focal * Math.tan(pitch);
    if (hy > -this.h * 0.2 && hy < this.h) {
      const hg = ctx.createLinearGradient(0, hy - this.h * 0.25, 0, hy + this.h * 0.1);
      hg.addColorStop(0, 'rgba(65,224,255,0)');
      hg.addColorStop(0.75, 'rgba(65,224,255,0.07)');
      hg.addColorStop(1, 'rgba(138,92,255,0.0)');
      ctx.fillStyle = hg;
      ctx.fillRect(0, hy - this.h * 0.25, this.w, this.h * 0.35);
    }
  }

  /** Motif du ciel, périodique en largeur (les nébuleuses sont reproduites de part et d'autre). */
  private paintSky(n: CanvasRenderingContext2D) {
    n.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const g = n.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, PALETTE.void);
    g.addColorStop(0.55, PALETTE.night);
    g.addColorStop(1, PALETTE.deep);
    n.fillStyle = g;
    n.fillRect(0, 0, this.w, this.h);
    const nebulae: [number, number, number, string][] = [
      [0.2, 0.18, 0.55, 'rgba(110,60,190,0.16)'],
      [0.85, 0.35, 0.45, 'rgba(40,150,200,0.09)'],
      [0.55, 0.85, 0.6, 'rgba(90,40,150,0.12)'],
    ];
    for (const [nx, ny, nr, col] of nebulae) {
      const y = ny * this.h;
      const r = nr * Math.max(this.w, this.h);
      for (const dx of [-this.w, 0, this.w]) {
        const x = nx * this.w + dx;
        const ng = n.createRadialGradient(x, y, 0, x, y, r);
        ng.addColorStop(0, col);
        ng.addColorStop(1, 'rgba(0,0,0,0)');
        n.fillStyle = ng;
        n.fillRect(0, 0, this.w, this.h);
      }
    }
    for (const s of this.stars) {
      n.globalAlpha = s.a * (0.75 + 0.25 * Math.sin(s.p));
      n.fillStyle = s.p > 5.6 ? PALETTE.cyanSoft : '#e8e6ff';
      n.fillRect(s.x * this.w, s.y * this.h, s.s, s.s);
    }
    n.globalAlpha = 1;
  }

  /** Halo violet sous le monolithe : il paraît suspendu, chargé d'énergie. */
  private drawUnderGlow(p: Pose) {
    const S = this.camera.cubeSize;
    const c = this.camera.project(S / 2, S / 2, -S * 0.15, p);
    if (!c) return;
    const r = (p.focal * S * 0.9) / c[2];
    if (r < 4) return;
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], r);
    g.addColorStop(0, 'rgba(138,92,255,0.22)');
    g.addColorStop(0.5, 'rgba(65,224,255,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(c[0] - r, c[1] - r, r * 2, r * 2);
  }

  /** Faces latérales visibles du cube : une bande par couche restante, coutures lumineuses. */
  private drawSides(f: FaceData, p: Pose, time: number) {
    const ctx = this.ctx;
    const S = this.camera.cubeSize;
    const H = this.camera.surfaceZ;
    const C = p.c;
    type Face = { n: [number, number]; at: (u: number, z: number) => Vec3; shade: number; edgeHp: (u: number) => boolean };
    const top = H - 1;
    const faces: Face[] = [
      { n: [0, 1], at: (u, z) => [u, S, z], shade: 0.9, edgeHp: (u) => f.hp[(S - 1) * S + u] > 0 },
      { n: [1, 0], at: (u, z) => [S, u, z], shade: 0.46, edgeHp: (u) => f.hp[u * S + (S - 1)] > 0 },
      { n: [-1, 0], at: (u, z) => [0, u, z], shade: 0.52, edgeHp: (u) => f.hp[u * S] > 0 },
      { n: [0, -1], at: (u, z) => [u, 0, z], shade: 0.4, edgeHp: (u) => f.hp[u] > 0 },
    ];
    const pulse = this.reducedMotion ? 0.7 : 0.55 + 0.25 * Math.sin(time / 1400);
    for (const fc of faces) {
      // Face tournée vers la caméra ?
      const mid = fc.at(S / 2, H / 2);
      if ((C[0] - mid[0]) * fc.n[0] + (C[1] - mid[1]) * fc.n[1] <= 0) continue;
      // Couche courante : seulement les blocs de bord encore présents.
      const curCol = scale(layerColor(f.layer, S), fc.shade);
      const seg = new Batch();
      for (let u = 0; u < S; u++) {
        if (!fc.edgeHp(u)) continue;
        const q = this.poly([fc.at(u, top + 1), fc.at(u + 1, top + 1), fc.at(u + 1, top), fc.at(u, top)], p);
        if (q) seg.poly(q);
      }
      ctx.fillStyle = css(curCol);
      seg.fill(ctx);
      // Couches inférieures, des plus proches de la surface vers le fond.
      for (let k = top - 1; k >= 0; k--) {
        const layer = f.layer + (top - k);
        const q = this.poly([fc.at(0, k + 1), fc.at(S, k + 1), fc.at(S, k), fc.at(0, k)], p);
        if (!q) continue;
        // Strates : alternance marquée et assombrissement avec la profondeur (le vide sous les pieds).
        const band = scale(layerColor(layer, S), fc.shade * (k % 2 ? 1 : 0.82) * (0.45 + 0.55 * (k / Math.max(1, top))));
        ctx.fillStyle = css(band);
        ctx.beginPath();
        addPoly(ctx, q);
        ctx.fill();
        // Arête supérieure de chaque strate, discrètement éclairée.
        ctx.strokeStyle = 'rgba(160,190,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(q[0][0], q[0][1]);
        ctx.lineTo(q[1][0], q[1][1]);
        ctx.stroke();
        // Couture lumineuse toutes les 8 couches (lignes de structure).
        if ((S - 1 - layer) % 8 === 0) {
          const a = this.camera.project(...fc.at(0, k + 1), p);
          const b = this.camera.project(...fc.at(S, k + 1), p);
          if (a && b) {
            ctx.strokeStyle = `rgba(65,224,255,${0.28 * pulse})`;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]);
            ctx.stroke();
          }
        }
      }
      // Arêtes verticales éclairées : la silhouette du monolithe.
      ctx.strokeStyle = 'rgba(127,233,255,0.45)';
      ctx.lineWidth = 1.5;
      for (const u of [0, S]) {
        const a = this.camera.project(...fc.at(u, H), p);
        const b = this.camera.project(...fc.at(u, 0), p);
        if (a && b) {
          const g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
          g.addColorStop(0, 'rgba(127,233,255,0.55)');
          g.addColorStop(1, 'rgba(127,233,255,0)');
          ctx.strokeStyle = g;
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        }
      }
    }
  }

  /** Dessus de la couche courante : blocs pierre-tech, puits, runes, fissures, lignes d'énergie. */
  private drawTop(f: FaceData, p: Pose, time: number) {
    const ctx = this.ctx;
    const cam = this.camera;
    const S = f.size;
    const H = cam.surfaceZ;
    const base = layerColor(f.layer, cam.cubeSize);
    const below = layerColor(Math.min(f.layer + 1, cam.cubeSize - 1), cam.cubeSize);
    const vw = cam.visibleWorld();
    const r = visibleRange(S, vw.minX - 1, vw.minY - 1, vw.maxX + 1, vw.maxY + 1);
    if (r.x1 < r.x0 || r.y1 < r.y0) return;
    const lod = cam.t > 0.55 || cam.zoom < 7;

    // Fond de la face (joints) : un seul polygone.
    const plate = this.poly([[r.x0, r.y0, H], [r.x1 + 1, r.y0, H], [r.x1 + 1, r.y1 + 1, H], [r.x0, r.y1 + 1, H]], p);
    if (plate) {
      if (lod) ctx.fillStyle = css(scale(base, 0.82));
      else {
        const ys = plate.map((q) => q[1]);
        const jg = ctx.createLinearGradient(0, Math.max(...ys), 0, Math.min(...ys));
        jg.addColorStop(0, css(scale(base, 0.3)));
        jg.addColorStop(1, css(mix(scale(base, 0.3), PALETTE.fog, 0.8)));
        ctx.fillStyle = jg;
      }
      ctx.beginPath();
      addPoly(ctx, plate);
      ctx.fill();
    }

    const n = r.x1 - r.x0 + 2;
    const rowTop: (Pt | null)[][] = [[], []];
    const rowLow: (Pt | null)[][] = [[], []];
    const depthTop: number[][] = [[], []];
    const proj = (x: number, y: number, z: number): [Pt | null, number] => {
      const q = cam.project(x, y, z, p);
      return q ? [[q[0], q[1]], q[2]] : [null, -1];
    };
    const fillRow = (y: number, slot: number) => {
      for (let i = 0; i < n; i++) {
        const [a, da] = proj(r.x0 + i, y, H);
        rowTop[slot][i] = a;
        depthTop[slot][i] = da;
        rowLow[slot][i] = lod ? null : proj(r.x0 + i, y, H - 1)[0];
      }
    };

    const tiles = new Map<number, Batch>();
    const floors: Batch[] = Array.from({ length: FOG_BUCKETS }, () => new Batch());
    const walls = new Map<number, Batch>();
    const hi = new Path2D();
    const lo = new Path2D();
    const chamferLit = new Batch();
    const chamferShade = new Batch();
    const runes = new Path2D();
    const actives = new Batch();
    const activeGlyphs = new Path2D();
    const floorRunes = new Path2D();
    const veins = new Path2D();
    const cracks = new Path2D();
    const path = <K>(m: Map<K, Batch>, k: K) => {
      let v = m.get(k);
      if (!v) {
        v = new Batch();
        m.set(k, v);
      }
      return v;
    };

    // Blocs lointains (< 6 px) : les blocs consécutifs de même teinte sont fusionnés en une bande.
    let run: { key: number; a: Pt; b: Pt; c: Pt; d: Pt } | null = null;
    const flush = () => {
      if (run) path(tiles, run.key).poly([run.a, run.b, run.c, run.d]);
      run = null;
    };
    fillRow(r.y0, 0);
    for (let y = r.y0; y <= r.y1; y++) {
      fillRow(y + 1, 1);
      for (let x = r.x0; x <= r.x1; x++) {
        const i = x - r.x0;
        const a = rowTop[0][i];
        const b = rowTop[0][i + 1];
        const c = rowTop[1][i + 1];
        const d = rowTop[1][i];
        if (!a || !b || !c || !d) {
          flush();
          continue;
        }
        const depth = (depthTop[0][i] + depthTop[1][i + 1]) / 2;
        const fb = Math.min(FOG_BUCKETS - 1, Math.floor(this.fogK(depth, p) * FOG_BUCKETS));
        const idx = y * S + x;
        const hp = f.hp[idx];
        const width = Math.abs(b[0] - a[0]);
        // Trop lointain pour être distingué (< 2,5 px) : la plaque de fond embrumée suffit.
        if (!lod && width < 2.5 && idx !== this.state.selected) {
          flush();
          continue;
        }
        if (hp > 0) {
          // Teinte : plaques à grande échelle + légère variation par bloc (pas de damier).
          const v = Math.min(3, Math.floor((plateNoise(x, y, hash2) * 0.75 + hash2(x, y) * 0.25) * 4));
          if (lod) {
            // Vue lointaine : pas de joints, juste une teinte par bloc et quelques lueurs.
            path(tiles, (fb * 4 + v) * 4).poly([a, b, c, d]);
            if (hash2(x, y, 9) < ACTIVE_RATE) actives.dot((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, Math.max(0.8, Math.min(1.6, width * 0.18)));
            continue;
          }
          if (width < 6 && idx !== this.state.selected) {
            const dmg0 = Math.min(3, Math.ceil((1 - hp / f.maxHp) * 3));
            const key = (fb * 4 + v) * 4 + dmg0;
            if (run && run.key === key) {
              run.b = b;
              run.c = c;
            } else {
              flush();
              run = { key, a, b, c, d };
            }
            continue;
          }
          flush();
          const g = width > 6 ? 0.035 : 0.02;
          const q = inset([a, b, c, d], g);
          // Veines d'énergie : quelques joints parcourus d'une lueur cyan.
          if (!this.lowFx && hash2(x, y, 41) < VEIN_RATE) {
            veins.moveTo(b[0], b[1]);
            veins.lineTo(c[0], c[1]);
          }
          if (!this.lowFx && hash2(x, y, 43) < VEIN_RATE) {
            veins.moveTo(d[0], d[1]);
            veins.lineTo(c[0], c[1]);
          }
          const dmg = Math.min(3, Math.ceil((1 - hp / f.maxHp) * 3));
          path(tiles, (fb * 4 + v) * 4 + dmg).poly(q);
          if (width >= 18 && !this.lowFx) {
            // Bloc taillé : plateau central et chanfreins (éclairés au nord-ouest, ombrés au sud-est).
            const qi = inset(q, width >= 22 ? 0.14 : 0.18);
            chamferLit.poly([q[0], q[1], qi[1], qi[0]]);
            chamferLit.poly([q[0], qi[0], qi[3], q[3]]);
            chamferShade.poly([q[3], qi[3], qi[2], q[2]]);
            chamferShade.poly([q[1], q[2], qi[2], qi[1]]);
            hi.moveTo(qi[0][0], qi[0][1]);
            hi.lineTo(qi[1][0], qi[1][1]);
            lo.moveTo(q[3][0], q[3][1]);
            lo.lineTo(q[2][0], q[2][1]);
            const rr = hash2(x, y, 5);
            if (width >= 20 && rr < RUNE_RATE) glyph(hash2(x, y, 6) < ACTIVE_RATE / RUNE_RATE ? activeGlyphs : runes, q, Math.floor(hash2(x, y, 7) * GLYPHS.length));
            if (dmg > 0) crack(cracks, q, x, y, dmg);
          }
        } else {
          flush();
          if (lod) {
            floors[fb].poly([a, b, c, d]);
            continue;
          }
          const la = rowLow[0][i];
          const lb = rowLow[0][i + 1];
          const lc = rowLow[1][i + 1];
          const ld = rowLow[1][i];
          if (!la || !lb || !lc || !ld) continue;
          floors[fb].poly(inset([la, lb, lc, ld], 0.05));
          if (width >= 14 && hash2(x, y, 21) < 0.22) glyph(floorRunes, inset([la, lb, lc, ld], 0.1), Math.floor(hash2(x, y, 22) * GLYPHS.length));
          // Parois des blocs voisins visibles depuis la caméra.
          const C = p.c;
          if (y > 0 && f.hp[idx - S] > 0 && C[1] > y) path(walls, fb * 4 + 0).poly([a, b, lb, la]);
          if (x > 0 && f.hp[idx - 1] > 0 && C[0] > x) path(walls, fb * 4 + 1).poly([a, d, ld, la]);
          if (x < S - 1 && f.hp[idx + 1] > 0 && C[0] < x + 1) path(walls, fb * 4 + 1).poly([b, c, lc, lb]);
          if (y < S - 1 && f.hp[idx + S] > 0 && C[1] < y + 1) path(walls, fb * 4 + 2).poly([d, c, lc, ld]);
        }
      }
      flush();
      rowTop[0] = rowTop[1];
      rowLow[0] = rowLow[1];
      depthTop[0] = depthTop[1];
      rowTop[1] = [];
      rowLow[1] = [];
      depthTop[1] = [];
    }

    const fogged = (c: RGB, fb: number) => css(mix(c, PALETTE.fog, (fb / (FOG_BUCKETS - 1)) * 0.82));
    // 1. Fonds des puits (couche du dessous), runes enfouies.
    for (let fb = 0; fb < FOG_BUCKETS; fb++) {
      ctx.fillStyle = fogged(scale(below, lod ? 0.35 : 0.42), fb);
      floors[fb].fill(ctx);
    }
    if (!this.lowFx) {
      ctx.strokeStyle = 'rgba(138,92,255,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke(floorRunes);
    }
    // 2. Parois (nord éclairée, côtés plus sombres, sud dans l'ombre).
    const wallShade = [0.68, 0.48, 0.36];
    for (const [k, batch] of walls) {
      const fb = Math.floor(k / 4);
      ctx.fillStyle = fogged(scale(base, wallShade[k % 4]), fb);
      batch.fill(ctx);
    }
    // 3. Dessus des blocs.
    // Quatre teintes de plaques : de l'ardoise sombre à une pierre plus froide et plus claire.
    const plates: RGB[] = [scale(base, 0.74), scale(base, 0.86), mix(scale(base, 0.96), [70, 92, 140], 0.25), mix(scale(base, 1.06), [96, 84, 150], 0.22)];
    for (const [k, batch] of tiles) {
      const fb = Math.floor(k / 16);
      const v = Math.floor(k / 4) % 4;
      const dmg = k % 4;
      ctx.fillStyle = fogged(scale(plates[v], 1 - dmg * 0.1), fb);
      batch.fill(ctx);
    }
    if (!lod && !this.lowFx) {
      ctx.fillStyle = 'rgba(190,210,255,0.09)';
      chamferLit.fill(ctx);
      ctx.fillStyle = 'rgba(0,0,8,0.32)';
      chamferShade.fill(ctx);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(190,210,255,0.16)';
      ctx.stroke(hi);
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.stroke(lo);
      ctx.strokeStyle = 'rgba(127,233,255,0.2)';
      ctx.stroke(runes);
    }
    // 4. Éléments lumineux (mode additif) : runes activées, fissures, lignes d'énergie.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pulse = this.reducedMotion ? 0.8 : 0.6 + 0.4 * Math.sin(time / 900);
    ctx.fillStyle = `rgba(255,196,107,${(lod ? 0.22 : 0.5) * pulse})`;
    actives.fill(ctx);
    ctx.strokeStyle = `rgba(65,224,255,${0.35 * pulse})`;
    ctx.lineWidth = 1.2;
    ctx.stroke(veins);
    if (!lod) {
      ctx.strokeStyle = `rgba(255,196,107,${0.55 * pulse})`;
      ctx.lineWidth = 1.4;
      ctx.stroke(activeGlyphs);
    }
    ctx.strokeStyle = 'rgba(255,170,80,0.75)';
    ctx.lineWidth = Math.max(1, cam.zoom * 0.03);
    ctx.stroke(cracks);
    this.drawSeams(f, r, p, pulse);
    ctx.restore();

    // 5. Survol, coups en attente, sélection.
    if (this.hover !== null && this.hover !== this.state.selected && f.hp[this.hover] > 0) this.outline(this.hover, 'rgba(220,240,255,0.55)', 1.5, p);
    for (const idx of this.state.pending) this.outline(idx, 'rgba(127,233,255,0.95)', 2, p, [4, 3], time);
    if (this.state.selected !== null && f.hp[this.state.selected] > 0) this.drawSelection(this.state.selected, p, time);
  }

  /** Lignes de structure tous les 8 blocs, comme des circuits sous la pierre. */
  private drawSeams(f: FaceData, r: { x0: number; y0: number; x1: number; y1: number }, p: Pose, pulse: number) {
    const ctx = this.ctx;
    const H = this.camera.surfaceZ;
    ctx.strokeStyle = `rgba(65,224,255,${0.22 * pulse})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let k = 0; k <= f.size; k += 8) {
      if (k >= r.x0 && k <= r.x1 + 1) {
        const a = this.camera.project(k, r.y0, H, p);
        const b = this.camera.project(k, r.y1 + 1, H, p);
        if (a && b) {
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
        }
      }
      if (k >= r.y0 && k <= r.y1 + 1) {
        const a = this.camera.project(r.x0, k, H, p);
        const b = this.camera.project(r.x1 + 1, k, H, p);
        if (a && b) {
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
        }
      }
    }
    ctx.stroke();
  }

  private quad(idx: number, p: Pose, z = this.camera.surfaceZ): Pt[] | null {
    const f = this.state.face!;
    const { x, y } = toXY(idx, f.size);
    return this.poly([[x, y, z], [x + 1, y, z], [x + 1, y + 1, z], [x, y + 1, z]], p);
  }

  private outline(idx: number, color: string, width: number, p: Pose, dash?: number[], time = 0) {
    const q = this.quad(idx, p);
    if (!q) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) {
      ctx.setLineDash(dash);
      ctx.lineDashOffset = -time / 40;
    }
    ctx.beginPath();
    addPoly(ctx, inset(q, 0.04));
    ctx.stroke();
    ctx.restore();
  }

  /** Sélection holographique : cadre cyan, équerres et faisceau vertical. */
  private drawSelection(idx: number, p: Pose, time: number) {
    const f = this.state.face!;
    const H = this.camera.surfaceZ;
    const q = this.quad(idx, p);
    if (!q) return;
    const ctx = this.ctx;
    const pulse = this.reducedMotion ? 1 : 0.75 + 0.25 * Math.sin(time / 260);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(65,224,255,${0.16 * pulse})`;
    ctx.beginPath();
    addPoly(ctx, q);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = `rgba(127,233,255,${pulse})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    addPoly(ctx, q);
    ctx.stroke();
    // Équerres hors du bloc
    const c = centroid(q);
    const out = q.map(([x, y]) => [c[0] + (x - c[0]) * 1.22, c[1] + (y - c[1]) * 1.22] as Pt);
    ctx.strokeStyle = '#e6fbff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const pt = out[i];
      const prev = out[(i + 3) % 4];
      const next = out[(i + 1) % 4];
      ctx.moveTo(pt[0] + (prev[0] - pt[0]) * 0.25, pt[1] + (prev[1] - pt[1]) * 0.25);
      ctx.lineTo(pt[0], pt[1]);
      ctx.lineTo(pt[0] + (next[0] - pt[0]) * 0.25, pt[1] + (next[1] - pt[1]) * 0.25);
    }
    ctx.stroke();
    // Faisceau vertical : repère visible de loin.
    const { x, y } = toXY(idx, f.size);
    const a = this.camera.project(x + 0.5, y + 0.5, H, p);
    const b = this.camera.project(x + 0.5, y + 0.5, H + 4, p);
    if (a && b) {
      const g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
      g.addColorStop(0, `rgba(127,233,255,${0.55 * pulse})`);
      g.addColorStop(1, 'rgba(127,233,255,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = g;
      ctx.lineWidth = Math.max(2, Math.abs(q[1][0] - q[0][0]) * 0.18);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Données de l'écran holographique : celles du panneau + couche courante calculée ici. */
  private holoData(layer: BillboardLayer): HoloData | null {
    const d = layer.data;
    const f = this.state.face;
    if (!d) return null;
    let alive = 0;
    if (f) for (let i = 0; i < f.hp.length; i++) if (f.hp[i] > 0) alive++;
    return {
      seasonName: d.seasonName,
      countdown: d.countdown,
      top: d.top,
      brigade: d.brigade,
      progress: d.progress,
      layer: f?.layer ?? 0,
      layers: this.camera.cubeSize,
      layerLeft: f ? alive / f.hp.length : 1,
      finalStone: d.finalStone,
      notice: d.notice ?? null,
    };
  }

  /**
   * Écran holographique du classement, flottant au-dessus du bord nord du
   * monolithe. Il pivote pour faire face à la caméra (lisible sous tous les
   * angles), est projeté par deux faisceaux depuis l'arête du cube, et
   * s'atténue en vue de minage pour ne jamais masquer la surface.
   */
  private drawBillboard(layer: BillboardLayer, p: Pose, time: number) {
    const data = this.holoData(layer);
    if (!data) return;
    const S = this.camera.cubeSize;
    const H = this.camera.surfaceZ;
    const W = S * BOARD.width;
    const zb = H + S * BOARD.lift;
    const zt = zb + W * BOARD.aspect;
    const cx = S / 2;
    const cy = BOARD.y;
    // Axe horizontal de l'écran = axe droit de la caméra : l'écran fait face au regard.
    const rx = p.r[0];
    const ry = p.r[1];
    const TL = this.camera.project(cx - rx * W / 2, cy - ry * W / 2, zt, p);
    const TR = this.camera.project(cx + rx * W / 2, cy + ry * W / 2, zt, p);
    const BL = this.camera.project(cx - rx * W / 2, cy - ry * W / 2, zb, p);
    if (!TL || !TR || !BL) return;
    const wpx = Math.hypot(TR[0] - TL[0], TR[1] - TL[1]);
    if (wpx < 40) return;
    const onScreen = Math.max(TL[1], TR[1]) > 0 && Math.min(TL[1], BL[1]) < this.h && Math.max(TL[0], TR[0]) > 0 && Math.min(TL[0], TR[0]) < this.w;
    if (!onScreen) return;
    this.billboardScreenWidth = wpx;
    // Présence pleine en vue monumentale, discrète en vue de minage.
    const t = this.camera.t;
    const alpha = 0.28 + 0.72 * Math.min(1, t * 1.6);
    const ctx = this.ctx;
    // Faisceaux de projection depuis l'arête nord du cube.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const side of [-1, 1]) {
      const ex = cx + side * W * 0.28;
      const base = this.camera.project(ex, 0, H, p);
      const a = this.camera.project(cx + side * (rx * W) / 2, cy + side * (ry * W) / 2, zb, p);
      const b = this.camera.project(cx + side * (rx * W) * 0.15, cy + side * (ry * W) * 0.15, zb, p);
      if (!base || !a || !b) continue;
      const g = ctx.createLinearGradient(base[0], base[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      g.addColorStop(0, `rgba(65,224,255,${0.32 * alpha})`);
      g.addColorStop(1, 'rgba(65,224,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(base[0], base[1]);
      ctx.lineTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.closePath();
      ctx.fill();
      // Émetteur
      const er = Math.max(2, wpx * 0.012);
      const eg = ctx.createRadialGradient(base[0], base[1], 0, base[0], base[1], er * 4);
      eg.addColorStop(0, `rgba(180,245,255,${0.9 * alpha})`);
      eg.addColorStop(1, 'rgba(65,224,255,0)');
      ctx.fillStyle = eg;
      ctx.fillRect(base[0] - er * 4, base[1] - er * 4, er * 8, er * 8);
    }
    ctx.restore();
    // Texture : résolution par paliers (pas de repeinte à chaque variation de taille pendant
    // un glisser), repeinte 4 fois/s au plus pour le scintillement et le compte à rebours.
    const need = wpx * this.dpr;
    const cw = TEXTURE_STEPS.find((w) => w >= need) ?? TEXTURE_STEPS[TEXTURE_STEPS.length - 1];
    const ch = Math.round(cw * BOARD.aspect);
    const bc = this.boardCanvas;
    if (bc.width !== cw || bc.height !== ch) {
      bc.width = cw;
      bc.height = ch;
      this.boardKey = '';
    }
    const tick = this.reducedMotion ? 0 : Math.floor(time / 250);
    const bkey = `${cw}|${tick}|${JSON.stringify(data)}`;
    if (bkey !== this.boardKey) {
      this.boardKey = bkey;
      paintHologram(bc.getContext('2d')!, cw, ch, data, time, this.reducedMotion);
    }
    ctx.save();
    ctx.setTransform(
      (this.dpr * (TR[0] - TL[0])) / cw,
      (this.dpr * (TR[1] - TL[1])) / cw,
      (this.dpr * (BL[0] - TL[0])) / ch,
      (this.dpr * (BL[1] - TL[1])) / ch,
      this.dpr * TL[0],
      this.dpr * TL[1],
    );
    // Voile sombre sous la lumière : garde le texte lisible devant le cube.
    ctx.globalAlpha = 0.5 * alpha;
    ctx.fillStyle = '#060a1e';
    ctx.beginPath();
    const k = ch * 0.07;
    ctx.moveTo(k, ch * 0.01);
    ctx.lineTo(cw - k, ch * 0.01);
    ctx.lineTo(cw * 0.995, k);
    ctx.lineTo(cw * 0.995, ch - k);
    ctx.lineTo(cw - k, ch * 0.99);
    ctx.lineTo(k, ch * 0.99);
    ctx.lineTo(cw * 0.005, ch - k);
    ctx.lineTo(cw * 0.005, k);
    ctx.closePath();
    ctx.fill();
    // Hologramme : lumière ajoutée, léger scintillement.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha * (this.reducedMotion ? 1 : 0.94 + 0.06 * Math.sin(time / 90));
    ctx.drawImage(bc, 0, 0);
    ctx.restore();
  }

  private drawEffects(f: FaceData, p: Pose, time: number) {
    const ctx = this.ctx;
    const cam = this.camera;
    const H = cam.surfaceZ;
    this.flashes = this.flashes.filter((fl) => {
      const age = time - fl.t0;
      const dur = fl.kind === 'refused' ? 420 : fl.kind === 'destroyed' || fl.kind === 'otherDestroyed' ? 600 : 240;
      if (age > dur || age < -50) return false;
      const k = 1 - Math.max(0, age) / dur;
      const destroyed = fl.kind === 'destroyed' || fl.kind === 'otherDestroyed';
      const q = this.quad(fl.idx, p, destroyed ? H - 1 : H) ?? this.quad(fl.idx, p);
      if (!q) return true;
      let jx = 0;
      if (fl.kind === 'refused' && !this.reducedMotion) jx = Math.sin(age / 18) * 3 * k;
      ctx.save();
      ctx.globalCompositeOperation = fl.kind === 'refused' ? 'source-over' : 'lighter';
      ctx.fillStyle =
        fl.kind === 'refused'
          ? `rgba(255,90,74,${0.55 * k})`
          : fl.kind === 'other'
            ? `rgba(65,224,255,${0.18 * k})`
            : fl.kind === 'confirmed'
              ? `rgba(127,233,255,${0.55 * k})`
              : `rgba(255,190,110,${(fl.kind === 'otherDestroyed' ? 0.35 : 0.65) * k})`;
      ctx.beginPath();
      addPoly(ctx, q.map(([x, y]) => [x + jx, y] as Pt));
      ctx.fill();
      if (destroyed) {
        // Anneau de poussière lumineuse qui s'élargit.
        const { x, y } = toXY(fl.idx, f.size);
        const rad = 0.5 + (1 - k) * 1.3;
        const ring: Pt[] = [];
        for (let i = 0; i < 20; i++) {
          const a = (i / 20) * Math.PI * 2;
          const s = cam.project(x + 0.5 + Math.cos(a) * rad, y + 0.5 + Math.sin(a) * rad, H, p);
          if (s) ring.push([s[0], s[1]]);
        }
        if (ring.length > 3) {
          ctx.strokeStyle = `rgba(255,214,150,${0.5 * k})`;
          ctx.lineWidth = Math.max(1, cam.zoom * 0.07 * k);
          ctx.beginPath();
          addPoly(ctx, ring);
          ctx.stroke();
        }
      }
      ctx.restore();
      return true;
    });
    const dt = 1 / 60;
    this.particles = this.particles.filter((pt) => {
      pt.life += dt;
      if (pt.life > pt.max) return false;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vz -= 12 * dt;
      pt.z = Math.max(H - 1, pt.z + pt.vz * dt);
      const s = cam.project(pt.x, pt.y, pt.z, p);
      if (!s) return true;
      const size = Math.max(1.5, (p.focal * pt.size) / s[2]);
      ctx.globalAlpha = 1 - pt.life / pt.max;
      ctx.fillStyle = pt.color;
      ctx.fillRect(s[0] - size / 2, s[1] - size / 2, size, size);
      return true;
    });
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.texts = this.texts.filter((t) => {
      const age = (time - t.t0) / 900;
      if (age > 1 || age < -0.1) return false;
      const s = cam.project(t.x, t.y, H + 0.4 + age * 1.6, p);
      if (!s) return true;
      ctx.font = `800 ${Math.max(12, Math.min(18, (p.focal * 0.38) / s[2]))}px system-ui, sans-serif`;
      ctx.globalAlpha = 1 - Math.max(0, age);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(t.text, s[0] + 1, s[1] + 1);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, s[0], s[1]);
      return true;
    });
    ctx.globalAlpha = 1;
  }
}

// --- Aides géométriques -------------------------------------------------------

function addPoly(target: Path2D | CanvasRenderingContext2D, q: Pt[]) {
  target.moveTo(q[0][0], q[0][1]);
  for (let i = 1; i < q.length; i++) target.lineTo(q[i][0], q[i][1]);
  target.closePath();
}

function addDot(target: Path2D, x: number, y: number, r: number) {
  target.moveTo(x + r, y);
  target.arc(x, y, r, 0, Math.PI * 2);
}

function centroid(q: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of q) {
    x += p[0];
    y += p[1];
  }
  return [x / q.length, y / q.length];
}

/** Réduit un quadrilatère vers son centre (joints entre blocs). */
function inset(q: Pt[], k: number): Pt[] {
  const c = centroid(q);
  return q.map(([x, y]) => [x + (c[0] - x) * k, y + (c[1] - y) * k] as Pt);
}

/** Point (u, v) ∈ [0,1]² dans un quadrilatère projeté (interpolation bilinéaire). */
function bilerp(q: Pt[], u: number, v: number): Pt {
  const top: Pt = [q[0][0] + (q[1][0] - q[0][0]) * u, q[0][1] + (q[1][1] - q[0][1]) * u];
  const bot: Pt = [q[3][0] + (q[2][0] - q[3][0]) * u, q[3][1] + (q[2][1] - q[3][1]) * u];
  return [top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v];
}

function glyph(target: Path2D, q: Pt[], g: number) {
  for (const [u0, v0, u1, v1] of GLYPHS[g]) {
    const a = bilerp(q, 0.2 + u0 * 0.6, 0.2 + v0 * 0.6);
    const b = bilerp(q, 0.2 + u1 * 0.6, 0.2 + v1 * 0.6);
    target.moveTo(a[0], a[1]);
    target.lineTo(b[0], b[1]);
  }
}

/** Fissures : la lumière intérieure de l'artefact affleure quand il est endommagé. */
function crack(target: Path2D, q: Pt[], x: number, y: number, dmg: number) {
  const cu = 0.35 + hash2(x, y, 11) * 0.3;
  const cv = 0.35 + hash2(x, y, 12) * 0.3;
  const c = bilerp(q, cu, cv);
  for (let i = 0; i < dmg + 1; i++) {
    const a = hash2(x, y, 20 + i) * Math.PI * 2;
    const len = 0.22 + hash2(x, y, 30 + i) * 0.22;
    const m = bilerp(q, cu + Math.cos(a) * len * 0.5 + (hash2(x, y, 40 + i) - 0.5) * 0.12, cv + Math.sin(a) * len * 0.5);
    const e = bilerp(q, Math.max(0.05, Math.min(0.95, cu + Math.cos(a) * len)), Math.max(0.05, Math.min(0.95, cv + Math.sin(a) * len)));
    target.moveTo(c[0], c[1]);
    target.lineTo(m[0], m[1]);
    target.lineTo(e[0], e[1]);
  }
}
