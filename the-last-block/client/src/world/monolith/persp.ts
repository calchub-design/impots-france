import type { ViewBounds, ViewCamera } from '../view.js';

/**
 * Caméra en VRAIE perspective au-dessus du cube (sans moteur 3D : quelques
 * produits scalaires par point). Une seule caméra, deux perceptions :
 *
 * - vue de minage (zoom élevé) : plongée à 46°, axes alignés sur l'écran,
 *   la surface fuit vers l'horizon et s'estompe dans la brume ;
 * - vue monumentale (zoom faible) : contre-plongée légère de 3/4 qui montre
 *   le cube entier, sa hauteur et ses strates, suspendu dans le vide.
 *
 * Le passage de l'une à l'autre est continu et piloté par le zoom (`t`).
 * Repère du monde : x vers l'est, y vers le sud (comme la grille du serveur),
 * z vers le haut ; le dessus de la couche courante est à z = `surfaceZ`.
 * Aucun accès au DOM : testée par Vitest.
 */

const DEG = Math.PI / 180;
export const MINING_POSE = { pitch: 35 * DEG, yaw: 0 };
export const MONUMENT_POSE = { pitch: 25 * DEG, yaw: -34 * DEG };
export const FOV_Y = 58 * DEG;
const NEAR = 0.05;

export type Vec3 = [number, number, number];

export interface Pose {
  t: number;
  /** Position de la caméra. */
  c: Vec3;
  /** Repère caméra : avant, droite, haut. */
  f: Vec3;
  r: Vec3;
  u: Vec3;
  focal: number;
  cx: number;
  cy: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => v * v * (3 - 2 * v);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export class PerspectiveCamera implements ViewCamera {
  x = 0;
  y = 0;
  zoom = 40;
  minZoom = 5;
  maxZoom = 96;
  viewW = 1;
  viewH = 1;
  vx = 0;
  vy = 0;
  friction = 4.5;
  inertia = true;
  bounds: ViewBounds = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  /** Arête du cube et altitude du dessus de la couche courante (en blocs). */
  cubeSize = 32;
  surfaceZ = 32;
  /** Zoom auquel le cube entier tient à l'écran (calculé par `frameMonument`). */
  monumentalZoom = 6;
  /** Rotation choisie par le joueur autour du monolithe (vue monumentale). */
  yawUser = 0;
  private anim: { from: { x: number; y: number; zoom: number }; to: { x: number; y: number; zoom: number }; t: number; duration: number } | null = null;
  private cacheKey = '';
  private cache: Pose | null = null;

  /** Degré de « vue monumentale » : 0 = minage, 1 = monument. */
  get t(): number {
    const zA = this.monumentalZoom;
    const zB = Math.max(zA * 1.35, Math.min(zA * 3.4, 30));
    return smooth(clamp01((Math.log(zB) - Math.log(this.zoom)) / (Math.log(zB) - Math.log(zA))));
  }

  get focal(): number {
    return this.viewH / 2 / Math.tan(FOV_Y / 2);
  }

  /** Pose pour un point visé, un zoom et un degré de monumentalité donnés. */
  poseAt(x: number, y: number, zoom: number, t: number): Pose {
    const pitch = lerp(MINING_POSE.pitch, MONUMENT_POSE.pitch, t);
    const yaw = lerp(MINING_POSE.yaw, MONUMENT_POSE.yaw + this.yawUser, t);
    // En vue monumentale, on vise le centre du cube, à mi-hauteur.
    const k = smooth(t);
    const tx = lerp(x, this.cubeSize / 2, k);
    const ty = lerp(y, this.cubeSize / 2, k);
    const tz = lerp(this.surfaceZ, this.surfaceZ * 0.45, k);
    const focal = this.focal;
    const d = focal / zoom;
    const hx = Math.sin(yaw);
    const hy = -Math.cos(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const f: Vec3 = [hx * cp, hy * cp, -sp];
    const r: Vec3 = [Math.cos(yaw), Math.sin(yaw), 0];
    const u: Vec3 = [hx * sp, hy * sp, cp];
    const c: Vec3 = [tx - f[0] * d, ty - f[1] * d, tz - f[2] * d];
    return { t, c, f, r, u, focal, cx: this.viewW / 2, cy: this.viewH / 2 };
  }

  get pose(): Pose {
    const key = `${this.x}|${this.y}|${this.zoom}|${this.viewW}|${this.viewH}|${this.surfaceZ}|${this.cubeSize}|${this.monumentalZoom}|${this.yawUser}`;
    if (key !== this.cacheKey || !this.cache) {
      this.cacheKey = key;
      this.cache = this.poseAt(this.x, this.y, this.zoom, this.t);
    }
    return this.cache;
  }

  /** Projection d'un point du monde : [x écran, y écran, profondeur] ou null s'il est derrière la caméra. */
  project(x: number, y: number, z: number, p: Pose = this.pose): [number, number, number] | null {
    const dx = x - p.c[0];
    const dy = y - p.c[1];
    const dz = z - p.c[2];
    const zc = dx * p.f[0] + dy * p.f[1] + dz * p.f[2];
    if (zc < NEAR) return null;
    const xc = dx * p.r[0] + dy * p.r[1];
    const yc = dx * p.u[0] + dy * p.u[1] + dz * p.u[2];
    return [p.cx + (p.focal * xc) / zc, p.cy - (p.focal * yc) / zc, zc];
  }

  /** Coordonnées caméra (pour le découpage contre le plan proche). */
  toCamera(x: number, y: number, z: number, p: Pose = this.pose): Vec3 {
    const dx = x - p.c[0];
    const dy = y - p.c[1];
    const dz = z - p.c[2];
    return [dx * p.r[0] + dy * p.r[1], dx * p.u[0] + dy * p.u[1] + dz * p.u[2], dx * p.f[0] + dy * p.f[1] + dz * p.f[2]];
  }

  /** Rayon du pixel (sx, sy) intersecté avec le plan horizontal z = planeZ ; null si le rayon ne le coupe pas. */
  unproject(sx: number, sy: number, planeZ = this.surfaceZ, p: Pose = this.pose): [number, number] | null {
    const a = (sx - p.cx) / p.focal;
    const b = -(sy - p.cy) / p.focal;
    const dir: Vec3 = [p.f[0] + p.r[0] * a + p.u[0] * b, p.f[1] + p.r[1] * a + p.u[1] * b, p.f[2] + p.u[2] * b];
    if (dir[2] > -1e-6) return null;
    const k = (planeZ - p.c[2]) / dir[2];
    if (k <= 0) return null;
    return [p.c[0] + dir[0] * k, p.c[1] + dir[1] * k];
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    const s = this.project(wx, wy, this.surfaceZ);
    return s ? [s[0], s[1]] : [-1e5, -1e5];
  }

  /** Point de la surface sous le pixel ; au-dessus de l'horizon, point lointain dans la même direction. */
  screenToWorld(sx: number, sy: number): [number, number] {
    const hit = this.unproject(sx, sy);
    if (hit) return hit;
    const p = this.pose;
    const far = this.cubeSize * 4;
    const a = (sx - p.cx) / p.focal;
    const hx = p.f[0] + p.r[0] * a;
    const hy = p.f[1] + p.r[1] * a;
    const n = Math.hypot(hx, hy) || 1;
    return [p.c[0] + (hx / n) * far, p.c[1] + (hy / n) * far];
  }

  /** Boîte englobante de la surface visible (pour le culling et la mini-carte). */
  visibleWorld() {
    const pts = [
      [0, 0],
      [this.viewW, 0],
      [0, this.viewH],
      [this.viewW, this.viewH],
      [this.viewW / 2, 0],
    ].map(([sx, sy]) => this.screenToWorld(sx, sy));
    const lim = this.cubeSize * 2;
    const xs = pts.map((p) => Math.max(-lim, Math.min(this.cubeSize + lim, p[0])));
    const ys = pts.map((p) => Math.max(-lim, Math.min(this.cubeSize + lim, p[1])));
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }

  setViewport(w: number, h: number) {
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    this.clamp();
  }

  setBounds(b: ViewBounds) {
    this.bounds = b;
    this.clamp();
  }

  /**
   * Calcule le zoom monumental : le cube entier (et le panneau au-dessus) tient
   * dans la vue. Quelques itérations suffisent (l'emprise varie presque
   * linéairement avec le zoom).
   */
  frameMonument(extraTop = 0): number {
    const S = this.cubeSize;
    const H = this.surfaceZ;
    const corners: [number, number, number][] = [];
    for (const x of [0, S]) for (const y of [0, S]) for (const z of [0, H + extraTop]) corners.push([x, y, z]);
    let zoom = Math.min(this.viewW, this.viewH) / (S * 1.6);
    for (let i = 0; i < 6; i++) {
      const p = this.poseAt(S / 2, S / 2, zoom, 1);
      const pts = corners.map(([x, y, z]) => this.project(x, y, z, p)).filter((q): q is [number, number, number] => q !== null);
      if (pts.length < corners.length) {
        zoom *= 0.7;
        continue;
      }
      const w = Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0]));
      const h = Math.max(...pts.map((q) => q[1])) - Math.min(...pts.map((q) => q[1]));
      zoom *= Math.min((this.viewW * 0.84) / w, (this.viewH * 0.7) / h);
    }
    this.monumentalZoom = Math.max(1, zoom);
    return this.monumentalZoom;
  }

  /** Compatibilité : zoom minimal = zoom monumental. */
  fitZoom(): number {
    return this.monumentalZoom / 0.95;
  }

  panByScreen(dx: number, dy: number) {
    this.anim = null;
    if (this.t > 0.6) {
      // Vue monumentale : glisser fait tourner le regard autour du monolithe.
      this.yawUser = Math.max(-1.3, Math.min(1.3, this.yawUser + dx * 0.006));
      return;
    }
    // Exact en perspective : le point saisi au centre doit se retrouver sous le
    // doigt déplacé de (dx, dy). La caméra se translate donc de W(c) − W(c + d).
    const [x0, y0] = this.screenToWorld(this.viewW / 2, this.viewH / 2);
    const [x1, y1] = this.screenToWorld(this.viewW / 2 + dx, this.viewH / 2 + dy);
    // Garde-fou : près de l'horizon, un petit geste ne doit pas projeter au loin.
    const max = Math.max(4, this.cubeSize / 4);
    this.x += Math.max(-max, Math.min(max, x0 - x1));
    this.y += Math.max(-max, Math.min(max, y0 - y1));
    this.clamp();
  }

  fling(pxPerSecX: number, pxPerSecY: number) {
    if (!this.inertia || this.t > 0.6) return;
    const k = 0.05;
    const [x0, y0] = this.screenToWorld(this.viewW / 2, this.viewH / 2);
    const [x1, y1] = this.screenToWorld(this.viewW / 2 + Math.max(-4000, Math.min(4000, pxPerSecX)) * k, this.viewH / 2 + Math.max(-4000, Math.min(4000, pxPerSecY)) * k);
    this.vx = (x0 - x1) / k;
    this.vy = (y0 - y1) / k;
  }

  stop() {
    this.vx = 0;
    this.vy = 0;
    this.anim = null;
  }

  zoomAt(factor: number, sx = this.viewW / 2, sy = this.viewH / 2) {
    this.anim = null;
    const before = this.unproject(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    const after = this.unproject(sx, sy);
    if (before && after && this.t < 0.5) {
      this.x += before[0] - after[0];
      this.y += before[1] - after[1];
    }
    this.clamp();
  }

  animateTo(to: Partial<{ x: number; y: number; zoom: number }>, duration = 450) {
    this.vx = this.vy = 0;
    const target = {
      x: to.x ?? this.x,
      y: to.y ?? this.y,
      zoom: Math.max(this.minZoom, Math.min(this.maxZoom, to.zoom ?? this.zoom)),
    };
    if (duration <= 0) {
      Object.assign(this, target);
      this.anim = null;
      this.clamp();
      return;
    }
    this.anim = { from: { x: this.x, y: this.y, zoom: this.zoom }, to: target, t: 0, duration };
  }

  get animating(): boolean {
    return this.anim !== null || Math.abs(this.vx) > 0.01 || Math.abs(this.vy) > 0.01;
  }

  update(dtMs: number): boolean {
    const dt = Math.min(0.05, Math.max(0, dtMs / 1000));
    // En revenant au minage, la rotation choisie s'efface doucement.
    if (this.yawUser !== 0 && this.t < 0.3) {
      this.yawUser *= Math.exp(-6 * dt);
      if (Math.abs(this.yawUser) < 0.002) this.yawUser = 0;
    }
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(a.duration, a.t + dtMs);
      const k = a.t / a.duration;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.x = a.from.x + (a.to.x - a.from.x) * e;
      this.y = a.from.y + (a.to.y - a.from.y) * e;
      this.zoom = a.from.zoom * Math.pow(a.to.zoom / a.from.zoom, e);
      if (a.t >= a.duration) this.anim = null;
      this.clamp();
      return true;
    }
    if (Math.abs(this.vx) < 0.01 && Math.abs(this.vy) < 0.01) {
      this.vx = this.vy = 0;
      return this.yawUser !== 0 && this.t < 0.3;
    }
    const bx = this.x;
    const by = this.y;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const decay = Math.exp(-this.friction * dt);
    this.vx *= decay;
    this.vy *= decay;
    this.clamp();
    if (this.x === bx) this.vx = 0;
    if (this.y === by) this.vy = 0;
    return true;
  }

  clamp() {
    const b = this.bounds;
    this.x = Math.max(b.minX, Math.min(b.maxX, this.x));
    this.y = Math.max(b.minY, Math.min(b.maxY, this.y));
  }
}
