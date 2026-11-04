import { describe, expect, it } from 'vitest';
import { placeLabels, type LabelRequest, type PlacedLabel } from '../client/src/world/labels.js';

const overlap = (a: PlacedLabel, b: PlacedLabel) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe('pseudos sans chevauchement', () => {
  it('une étiquette seule se place centrée au-dessus de son marqueur', () => {
    const [p] = placeLabels([{ id: 1, ax: 100, ay: 100, w: 60, h: 16, priority: 0 }], 400, 400);
    expect(p).toEqual({ id: 1, x: 70, y: 84, w: 60, h: 16 });
  });

  it('deux mineurs voisins : la seconde étiquette se décale au lieu de chevaucher', () => {
    const reqs: LabelRequest[] = [
      { id: 1, ax: 100, ay: 100, w: 60, h: 16, priority: 1 },
      { id: 2, ax: 110, ay: 102, w: 60, h: 16, priority: 0 },
    ];
    const out = placeLabels(reqs, 400, 400);
    expect(out).toHaveLength(2);
    expect(overlap(out[0], out[1])).toBe(false);
  });

  it('foule dense (300 marqueurs, 50 tirages) : jamais de chevauchement, toujours dans la vue', () => {
    for (let s = 1; s <= 50; s++) {
      const r = rng(s);
      const reqs: LabelRequest[] = Array.from({ length: 300 }, (_, i) => ({
        id: i,
        ax: 40 + r() * 300,
        ay: 40 + r() * 500,
        w: 30 + r() * 70,
        h: 16,
        priority: r(),
      }));
      const out = placeLabels(reqs, 390, 600);
      expect(out.length).toBeGreaterThan(5);
      for (let i = 0; i < out.length; i++) {
        expect(out[i].x).toBeGreaterThanOrEqual(0);
        expect(out[i].y).toBeGreaterThanOrEqual(0);
        expect(out[i].x + out[i].w).toBeLessThanOrEqual(390);
        expect(out[i].y + out[i].h).toBeLessThanOrEqual(600);
        for (let j = i + 1; j < out.length; j++) expect(overlap(out[i], out[j])).toBe(false);
      }
    }
  });

  it('la priorité la plus haute (allié) est toujours affichée, même au milieu de la foule', () => {
    const reqs: LabelRequest[] = Array.from({ length: 40 }, (_, i) => ({ id: i, ax: 200, ay: 200, w: 80, h: 16, priority: 0 }));
    reqs.push({ id: 99, ax: 200, ay: 200, w: 80, h: 16, priority: 10 });
    const out = placeLabels(reqs, 400, 400);
    expect(out.some((p) => p.id === 99)).toBe(true);
    expect(out.length).toBeLessThan(41);
  });

  it('les zones réservées (ex. bandeau) ne sont jamais recouvertes', () => {
    const reserved = [{ id: -1, x: 0, y: 0, w: 400, h: 40 }];
    const out = placeLabels([{ id: 1, ax: 100, ay: 45, w: 60, h: 16, priority: 0 }], 400, 400, reserved);
    for (const p of out) expect(overlap(p, reserved[0])).toBe(false);
  });

  it('une étiquette sans place proche est masquée plutôt qu\'éloignée de son marqueur', () => {
    const reqs: LabelRequest[] = Array.from({ length: 30 }, (_, i) => ({ id: i, ax: 100, ay: 100, w: 60, h: 16, priority: 30 - i }));
    const out = placeLabels(reqs, 400, 400);
    for (const p of out) {
      expect(Math.abs(p.x + p.w / 2 - 100)).toBeLessThanOrEqual(60 + 72);
      expect(Math.abs(p.y + p.h - 100)).toBeLessThanOrEqual(48);
    }
  });
});
