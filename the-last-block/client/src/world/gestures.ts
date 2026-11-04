/**
 * Reconnaissance des gestes sur la surface : toucher bref (sélection),
 * glisser (déplacement de caméra avec lancer), pincer (zoom).
 *
 * `GestureTracker` est une logique pure (testée par Vitest) ; `attachGestures`
 * la relie aux événements pointeur et molette du navigateur.
 */

export type PointerKind = 'mouse' | 'touch' | 'pen';

/** Déplacement maximal (px) pour qu'un appui reste un toucher et non un glisser. */
export const TAP_SLOP: Record<PointerKind, number> = { mouse: 5, touch: 10, pen: 8 };
/** Durée maximale d'un toucher (ms). */
export const TAP_MAX_MS = 500;

export interface GestureHandlers {
  /** Premier appui : arrête l'inertie en cours. */
  start(): void;
  pan(dx: number, dy: number): void;
  /** Fin de glisser avec la vitesse du doigt (px/s). */
  panEnd(vx: number, vy: number): void;
  /** Pincement : facteur relatif depuis le dernier appel, centre et déplacement du centre. */
  pinch(scale: number, cx: number, cy: number, dx: number, dy: number): void;
  tap(x: number, y: number, kind: PointerKind): void;
}

interface Pt {
  x: number;
  y: number;
  sx: number;
  sy: number;
  t0: number;
  kind: PointerKind;
}

type Mode = 'idle' | 'pending' | 'pan' | 'pinch' | 'afterPinch';

export class GestureTracker {
  private pts = new Map<number, Pt>();
  mode: Mode = 'idle';
  private samples: { x: number; y: number; t: number }[] = [];
  private pinchDist = 0;
  private pinchCx = 0;
  private pinchCy = 0;

  constructor(private readonly h: GestureHandlers) {}

  down(id: number, x: number, y: number, t: number, kind: PointerKind) {
    if (this.pts.size >= 2) return; // au-delà de deux doigts : ignoré
    this.pts.set(id, { x, y, sx: x, sy: y, t0: t, kind });
    if (this.pts.size === 1) {
      this.mode = 'pending';
      this.samples = [{ x, y, t }];
      this.h.start();
    } else {
      this.mode = 'pinch';
      const [a, b] = [...this.pts.values()];
      this.pinchDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      this.pinchCx = (a.x + b.x) / 2;
      this.pinchCy = (a.y + b.y) / 2;
    }
  }

  move(id: number, x: number, y: number, t: number) {
    const p = this.pts.get(id);
    if (!p) return;
    const px = p.x;
    const py = p.y;
    p.x = x;
    p.y = y;
    if (this.mode === 'pending') {
      if (Math.hypot(x - p.sx, y - p.sy) > TAP_SLOP[p.kind]) {
        this.mode = 'pan';
        this.h.pan(x - p.sx, y - p.sy);
        this.sample(x, y, t);
      }
      return;
    }
    if (this.mode === 'pan' || this.mode === 'afterPinch') {
      this.h.pan(x - px, y - py);
      this.sample(x, y, t);
      return;
    }
    if (this.mode === 'pinch' && this.pts.size === 2) {
      const [a, b] = [...this.pts.values()];
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      this.h.pinch(dist / this.pinchDist, cx, cy, cx - this.pinchCx, cy - this.pinchCy);
      this.pinchDist = dist;
      this.pinchCx = cx;
      this.pinchCy = cy;
    }
  }

  up(id: number, x: number, y: number, t: number) {
    const p = this.pts.get(id);
    if (!p) return;
    p.x = x;
    p.y = y;
    this.pts.delete(id);
    if (this.mode === 'pending') {
      if (Math.hypot(x - p.sx, y - p.sy) <= TAP_SLOP[p.kind] && t - p.t0 <= TAP_MAX_MS) this.h.tap(x, y, p.kind);
      this.mode = 'idle';
    } else if (this.mode === 'pan' || this.mode === 'afterPinch') {
      if (this.pts.size === 0) {
        this.sample(x, y, t);
        const v = this.velocity(t);
        this.h.panEnd(v.vx, v.vy);
        this.mode = 'idle';
      }
    } else if (this.mode === 'pinch') {
      // Il reste un doigt : il continue de déplacer la caméra, sans jamais produire de toucher.
      this.mode = this.pts.size === 1 ? 'afterPinch' : 'idle';
      const rest = [...this.pts.values()][0];
      if (rest) this.samples = [{ x: rest.x, y: rest.y, t }];
    }
    if (this.pts.size === 0 && this.mode !== 'idle') this.mode = 'idle';
  }

  cancel(id: number) {
    this.pts.delete(id);
    if (this.pts.size === 0) this.mode = 'idle';
  }

  private sample(x: number, y: number, t: number) {
    this.samples.push({ x, y, t });
    while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift();
  }

  /** Vitesse moyenne sur les ~100 dernières ms ; nulle si le doigt s'est arrêté avant de lever. */
  private velocity(t: number): { vx: number; vy: number } {
    const s = this.samples;
    if (s.length < 2) return { vx: 0, vy: 0 };
    const a = s[0];
    const b = s[s.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0 || t - b.t > 80) return { vx: 0, vy: 0 };
    return { vx: ((b.x - a.x) / dt) * 1000, vy: ((b.y - a.y) / dt) * 1000 };
  }
}

/** Relie le suivi des gestes et la molette à un élément. Renvoie une fonction de nettoyage. */
export function attachGestures(el: HTMLElement, h: GestureHandlers, onWheel: (deltaY: number, x: number, y: number) => void) {
  const tracker = new GestureTracker(h);
  const pos = (e: PointerEvent | WheelEvent) => {
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const kind = (e: PointerEvent): PointerKind => (e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse');
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    el.setPointerCapture?.(e.pointerId);
    const [x, y] = pos(e);
    tracker.down(e.pointerId, x, y, e.timeStamp, kind(e));
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    const [x, y] = pos(e);
    tracker.move(e.pointerId, x, y, e.timeStamp);
  };
  const onUp = (e: PointerEvent) => {
    const [x, y] = pos(e);
    tracker.up(e.pointerId, x, y, e.timeStamp);
  };
  const onCancel = (e: PointerEvent) => tracker.cancel(e.pointerId);
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const [x, y] = pos(e);
    // deltaMode 1 = lignes (souris classique sous Firefox).
    onWheel(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY, x, y);
  };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('wheel', wheel, { passive: false });
  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onCancel);
    el.removeEventListener('wheel', wheel);
  };
}
