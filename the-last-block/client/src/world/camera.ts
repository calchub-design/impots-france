/**
 * Caméra 2.5D au-dessus d'une face plane.
 *
 * - (x, y) : point du monde (en blocs) au centre de l'écran ;
 * - zoom : pixels par bloc horizontalement ;
 * - tilt : écrasement vertical (< 1) donnant l'impression d'une surface vue
 *   légèrement de biais ; la face avant des blocs devient visible.
 *
 * Sans accès au DOM : testable et indépendante du rendu. La navigation ne
 * modifie que l'affichage ; elle n'influe ni sur la cadence ni sur la portée
 * du minage (le serveur ne connaît pas la caméra).
 */

export interface CameraView {
  x: number;
  y: number;
  zoom: number;
}

export interface CameraBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export const TILT = 0.78;

export class Camera {
  x = 0;
  y = 0;
  zoom = 40;
  minZoom = 12;
  maxZoom = 96;
  viewW = 1;
  viewH = 1;
  /** Vitesse d'inertie, en blocs par seconde. */
  vx = 0;
  vy = 0;
  /** Frottement : fraction de vitesse conservée par seconde (exp). */
  friction = 4.5;
  inertia = true;
  bounds: CameraBounds = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  private anim: { from: CameraView; to: CameraView; t: number; duration: number } | null = null;

  setViewport(w: number, h: number) {
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    this.clamp();
  }

  setBounds(b: CameraBounds) {
    this.bounds = b;
    this.clamp();
  }

  /** Zoom qui fait tenir une largeur × hauteur (en blocs) dans la vue. */
  fitZoom(w: number, h: number): number {
    return Math.min(this.viewW / w, this.viewH / (h * TILT));
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.x) * this.zoom + this.viewW / 2, (wy - this.y) * this.zoom * TILT + this.viewH / 2];
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.viewW / 2) / this.zoom + this.x, (sy - this.viewH / 2) / (this.zoom * TILT) + this.y];
  }

  /** Rectangle du monde visible. */
  visibleWorld() {
    const [minX, minY] = this.screenToWorld(0, 0);
    const [maxX, maxY] = this.screenToWorld(this.viewW, this.viewH);
    return { minX, minY, maxX, maxY };
  }

  /** Déplacement suivant le doigt (dx, dy en pixels écran). */
  panByScreen(dx: number, dy: number) {
    this.anim = null;
    this.x -= dx / this.zoom;
    this.y -= dy / (this.zoom * TILT);
    this.clamp();
  }

  /** Lancer : vitesse du doigt en px/s convertie en blocs/s. */
  fling(pxPerSecX: number, pxPerSecY: number) {
    if (!this.inertia) return;
    const max = 4000;
    const fx = Math.max(-max, Math.min(max, pxPerSecX));
    const fy = Math.max(-max, Math.min(max, pxPerSecY));
    this.vx = -fx / this.zoom;
    this.vy = -fy / (this.zoom * TILT);
  }

  stop() {
    this.vx = 0;
    this.vy = 0;
    this.anim = null;
  }

  /** Zoom multiplicatif en gardant fixe le point du monde sous (sx, sy). */
  zoomAt(factor: number, sx = this.viewW / 2, sy = this.viewH / 2) {
    this.anim = null;
    const [wx, wy] = this.screenToWorld(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    // Replace le point (wx, wy) sous le pointeur.
    this.x = wx - (sx - this.viewW / 2) / this.zoom;
    this.y = wy - (sy - this.viewH / 2) / (this.zoom * TILT);
    this.clamp();
  }

  animateTo(to: Partial<CameraView>, duration = 450) {
    this.vx = this.vy = 0;
    const target: CameraView = {
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

  /** Avance la caméra de `dtMs`. Renvoie vrai si elle a bougé. */
  update(dtMs: number): boolean {
    const dt = Math.min(0.05, Math.max(0, dtMs / 1000));
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(a.duration, a.t + dtMs);
      const k = easeInOut(a.t / a.duration);
      this.x = a.from.x + (a.to.x - a.from.x) * k;
      this.y = a.from.y + (a.to.y - a.from.y) * k;
      this.zoom = a.from.zoom * Math.pow(a.to.zoom / a.from.zoom, k);
      if (a.t >= a.duration) this.anim = null;
      this.clamp();
      return true;
    }
    if (Math.abs(this.vx) < 0.01 && Math.abs(this.vy) < 0.01) {
      this.vx = this.vy = 0;
      return false;
    }
    const bx = this.x;
    const by = this.y;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const decay = Math.exp(-this.friction * dt);
    this.vx *= decay;
    this.vy *= decay;
    this.clamp();
    // Contre une limite : la vitesse s'annule.
    if (this.x === bx) this.vx = 0;
    if (this.y === by) this.vy = 0;
    return true;
  }

  /** Le centre de la vue reste dans les limites : un bord de face peut venir au plus au milieu de l'écran. */
  clamp() {
    const b = this.bounds;
    this.x = Math.max(b.minX, Math.min(b.maxX, this.x));
    this.y = Math.max(b.minY, Math.min(b.maxY, this.y));
  }
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
