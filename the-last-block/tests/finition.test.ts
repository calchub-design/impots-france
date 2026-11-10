import { describe, expect, it } from 'vitest';
import { countLabel, plural } from '../client/src/text.js';
import { boardReadable, placeLabels, rectsOverlap } from '../client/src/world/labels.js';
import { PerspectiveCamera } from '../client/src/world/monolith/persp.js';

describe('accords en nombre (interface)', () => {
  it('singulier pour 0 et 1, pluriel au-delà (règle française)', () => {
    expect(countLabel(0, 'actif')).toBe('0 actif');
    expect(countLabel(1, 'coup')).toBe('1 coup');
    expect(countLabel(2, 'coup')).toBe('2 coups');
    expect(countLabel(1234, 'coup')).toMatch(/^1\s234 coups$/);
    expect(countLabel(1, 'membre')).toBe('1 membre');
    expect(plural(3, 'bloc détruit', 'blocs détruits')).toBe('blocs détruits');
    expect(plural(1, 'bloc détruit', 'blocs détruits')).toBe('bloc détruit');
  });
});

describe('écran holographique : lisibilité et place à l\'écran', () => {
  const W = 390;
  const H = 700;
  it('lisible seulement s\'il est assez grand, assez opaque et visible aux deux tiers', () => {
    const r = { x: 60, y: 40, w: 260, h: 140 };
    expect(boardReadable(r, 1, W, H)).toBe(true);
    expect(boardReadable(r, 0.3, W, H)).toBe(false); // estompé (vue de minage)
    expect(boardReadable({ ...r, w: 100 }, 1, W, H)).toBe(false); // trop petit
    expect(boardReadable({ ...r, y: -110 }, 1, W, H)).toBe(false); // sorti par le haut
    expect(boardReadable({ ...r, x: 200 }, 1, W, H)).toBe(true); // 73 % visible
    expect(boardReadable({ ...r, x: 260 }, 1, W, H)).toBe(false); // à moitié hors champ
    expect(boardReadable(null, 1, W, H)).toBe(false);
  });

  it('chevauchement de rectangles (mini-carte sous l\'écran holographique)', () => {
    const map = { x: 298, y: 8, w: 84, h: 100 };
    expect(rectsOverlap({ x: 150, y: 30, w: 200, h: 120 }, map)).toBe(true);
    expect(rectsOverlap({ x: 20, y: 30, w: 200, h: 120 }, map)).toBe(false);
    expect(rectsOverlap({ x: 20, y: 30, w: 276, h: 120 }, map, 4)).toBe(true);
  });

  it('les pseudos ne se posent pas sur une zone réservée (écran holographique)', () => {
    const holo = { id: -100, x: 100, y: 50, w: 240, h: 130 };
    const placed = placeLabels([{ id: 0, ax: 200, ay: 120, w: 70, h: 18, priority: 1 }], W, H, [holo]);
    for (const p of placed) expect(rectsOverlap(p, holo)).toBe(false);
  });
});

describe('cadrage monumental avec l\'écran holographique', () => {
  /** Mêmes proportions que le rendu monolithe (largeur 1,5 × arête, rapport 0,56). */
  function framed(size: number, w: number, h: number) {
    const c = new PerspectiveCamera();
    c.setViewport(w, h);
    c.cubeSize = size;
    c.surfaceZ = size;
    c.setBounds({ minX: 0, maxX: size, minY: 0, maxY: size });
    const BW = size * 1.5;
    const zb = size + size * 0.1;
    const board = { width: BW, y: -2, zb, zt: zb + BW * 0.56 };
    c.frameMonument(0, board, { fillW: 0.94, fillH: 0.88, bottomInset: 40 });
    c.minZoom = c.monumentalZoom; // comme le rendu (reframe)
    c.animateTo({ x: size / 2, y: size / 2, zoom: c.monumentalZoom }, 0);
    return { c, board };
  }

  for (const [size, w, h] of [[4, 376, 600], [12, 376, 600], [40, 376, 600], [12, 690, 520], [12, 740, 300]] as const) {
    it(`cube ${size}, vue ${w}×${h} : cube et écran entiers, centrés, grands`, () => {
      const { c, board } = framed(size, w, h);
      const p = c.pose;
      const pts: [number, number][] = [];
      for (const x of [0, size]) for (const y of [0, size]) for (const z of [0, size]) pts.push(c.project(x, y, z, p)!.slice(0, 2) as [number, number]);
      for (const s of [-1, 1]) for (const z of [board.zb, board.zt]) pts.push(c.project(size / 2 + (s * p.r[0] * board.width) / 2, board.y + (s * p.r[1] * board.width) / 2, z, p)!.slice(0, 2) as [number, number]);
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      // Tout est à l'écran, au-dessus de la bande des pastilles (40 px).
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...xs)).toBeLessThanOrEqual(w);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...ys)).toBeLessThanOrEqual(h - 40);
      // Centré (à 2 px près) et occupant l'essentiel de la zone utile.
      expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - w / 2)).toBeLessThan(2);
      expect(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - (h - 40) / 2)).toBeLessThan(2);
      const fill = Math.max((Math.max(...xs) - Math.min(...xs)) / (w * 0.94), (Math.max(...ys) - Math.min(...ys)) / ((h - 40) * 0.88));
      expect(fill).toBeGreaterThan(0.97);
    });
  }

  it('le décalage ne s\'applique qu\'en vue monumentale : la vue de minage reste centrée sur le point visé', () => {
    const { c } = framed(12, 376, 600);
    expect(Math.abs(c.monumentOffsetX) + Math.abs(c.monumentOffsetY)).toBeGreaterThan(5);
    c.animateTo({ x: 6, y: 6, zoom: 30 }, 0);
    expect(c.t).toBeLessThan(0.02);
    const [sx, sy] = c.worldToScreen(6, 6);
    expect(sx).toBeCloseTo(188, 0);
    expect(sy).toBeCloseTo(300, 0);
  });
});
