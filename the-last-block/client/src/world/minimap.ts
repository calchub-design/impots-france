import type { ViewCamera as Camera } from './view.js';
import type { FaceData } from './face.js';
import { rgb, strataColor } from './palette.js';

/** Couleur d'une couche pour la mini-carte (le rendu « monolithe » fournit sa propre palette). */
export type LayerTint = (layer: number, size: number) => [number, number, number];

/**
 * Mini-carte : toute la face à raison d'un pixel par bloc (image mise en
 * cache, régénérée quand les PV changent), rectangle de la vue courante,
 * bloc sélectionné. Un toucher ou un glisser déplace la caméra.
 */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private img: HTMLCanvasElement = document.createElement('canvas');
  private imgVersion = -1;
  private dpr = 1;
  version = 0;
  face: FaceData | null = null;
  cubeSize = 1;
  selected: number | null = null;
  markers: { idx: number; color: string }[] = [];
  tint: LayerTint = (layer, size) => rgb(strataColor(layer, size));

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly onJump: (wx: number, wy: number, final: boolean) => void,
  ) {
    this.ctx = canvas.getContext('2d')!;
    let dragging = false;
    const jump = (e: PointerEvent, final: boolean) => {
      const f = this.face;
      if (!f) return;
      const r = canvas.getBoundingClientRect();
      const wx = ((e.clientX - r.left) / r.width) * f.size;
      const wy = ((e.clientY - r.top) / r.height) * f.size;
      this.onJump(Math.max(0, Math.min(f.size, wx)), Math.max(0, Math.min(f.size, wy)), final);
    };
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      canvas.setPointerCapture?.(e.pointerId);
      jump(e, false);
      e.preventDefault();
      e.stopPropagation();
    });
    canvas.addEventListener('pointermove', (e) => dragging && jump(e, false));
    canvas.addEventListener('pointerup', (e) => {
      if (dragging) jump(e, true);
      dragging = false;
    });
    canvas.addEventListener('pointercancel', () => (dragging = false));
  }

  private rebuild(f: FaceData) {
    this.img.width = f.size;
    this.img.height = f.size;
    const ictx = this.img.getContext('2d')!;
    const data = ictx.createImageData(f.size, f.size);
    const [r, g, b] = this.tint(f.layer, Math.max(this.cubeSize, f.size));
    for (let i = 0; i < f.size * f.size; i++) {
      const hp = f.hp[i];
      const k = hp > 0 ? 0.55 + 0.45 * (hp / f.maxHp) : 0.12;
      data.data[i * 4] = r * k;
      data.data[i * 4 + 1] = g * k;
      data.data[i * 4 + 2] = b * k;
      data.data[i * 4 + 3] = 255;
    }
    ictx.putImageData(data, 0, 0);
    this.imgVersion = this.version;
  }

  draw() {
    const f = this.face;
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(r.width * this.dpr);
    const h = Math.round(r.height * this.dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0d1d';
    ctx.fillRect(0, 0, w, h);
    if (!f) return;
    if (this.imgVersion !== this.version || this.img.width !== f.size) this.rebuild(f);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.img, 0, 0, w, h);
    const s = w / f.size;
    for (const m of this.markers) {
      ctx.fillStyle = m.color;
      ctx.fillRect((m.idx % f.size) * s - 1, Math.floor(m.idx / f.size) * s - 1, Math.max(3, s + 2), Math.max(3, s + 2));
    }
    if (this.selected !== null) {
      ctx.fillStyle = '#ffe08a';
      ctx.fillRect((this.selected % f.size) * s - 1, Math.floor(this.selected / f.size) * s - 1, Math.max(3, s + 2), Math.max(3, s + 2));
    }
    const v = this.camera.visibleWorld();
    ctx.strokeStyle = '#ffe08a';
    ctx.lineWidth = Math.max(1.5, this.dpr * 1.2);
    const x0 = Math.max(0, v.minX) * s;
    const y0 = Math.max(0, v.minY) * s;
    const x1 = Math.min(f.size, v.maxX) * s;
    const y1 = Math.min(f.size, v.maxY) * s;
    if (x1 > x0 && y1 > y0) ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
}
