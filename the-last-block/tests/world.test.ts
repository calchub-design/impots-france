import { describe, expect, it } from 'vitest';
import { Camera, TILT } from '../client/src/world/camera.js';
import { hash2, nearestAlive, toIdx, toXY, visibleRange, type FaceData } from '../client/src/world/face.js';
import { GestureTracker, TAP_SLOP, type GestureHandlers } from '../client/src/world/gestures.js';

function face(size: number, dead: number[] = []): FaceData {
  const hp = new Array(size * size).fill(3);
  for (const d of dead) hp[d] = 0;
  return { faceId: 'top', size, layer: 0, maxHp: 3, hp };
}

describe('face', () => {
  it('conversions index ⇄ coordonnées', () => {
    for (const idx of [0, 5, 31, 32, 1023]) expect(toIdx(toXY(idx, 32).x, toXY(idx, 32).y, 32)).toBe(idx);
    expect(toXY(33, 32)).toEqual({ x: 1, y: 1 });
  });

  it('bloc vivant le plus proche : ignore les blocs détruits, respecte le rayon', () => {
    const f = face(8, [toIdx(4, 4, 8), toIdx(5, 4, 8), toIdx(4, 5, 8), toIdx(3, 4, 8), toIdx(4, 3, 8)]);
    const n = nearestAlive(f, 4.5, 4.5)!;
    const p = toXY(n, 8);
    expect(Math.max(Math.abs(p.x - 4), Math.abs(p.y - 4))).toBe(1);
    expect(f.hp[n]).toBeGreaterThan(0);
    expect(nearestAlive(face(4, Array.from({ length: 16 }, (_, i) => i)), 1, 1)).toBeNull();
    const lonely = face(16, Array.from({ length: 256 }, (_, i) => i).filter((i) => i !== toIdx(15, 15, 16)));
    expect(nearestAlive(lonely, 0, 0, 3)).toBeNull();
    expect(nearestAlive(lonely, 0, 0)).toBe(toIdx(15, 15, 16));
  });

  it('point hors de la face : on cherche depuis le bord le plus proche', () => {
    expect(nearestAlive(face(8), -5, -5)).toBe(0);
    expect(nearestAlive(face(8), 50, 3.5)).toBe(toIdx(7, 3, 8));
  });

  it('plage visible bornée à la face (culling)', () => {
    expect(visibleRange(64, 10.2, 5.5, 20.1, 9.9)).toEqual({ x0: 10, y0: 5, x1: 20, y1: 9 });
    expect(visibleRange(64, -10, -10, 1000, 1000)).toEqual({ x0: 0, y0: 0, x1: 63, y1: 63 });
  });

  it('bruit de texture déterministe', () => {
    expect(hash2(3, 4)).toBe(hash2(3, 4));
    expect(hash2(3, 4)).not.toBe(hash2(4, 3));
    for (let i = 0; i < 100; i++) expect(hash2(i, i * 7)).toBeLessThan(1);
  });
});

describe('caméra', () => {
  const cam = () => {
    const c = new Camera();
    c.setViewport(400, 600);
    c.setBounds({ minX: 0, maxX: 64, minY: 0, maxY: 64 });
    c.animateTo({ x: 32, y: 32, zoom: 40 }, 0);
    return c;
  };

  it('écran ⇄ monde aller-retour, centre de l\'écran = centre de caméra', () => {
    const c = cam();
    expect(c.worldToScreen(32, 32)).toEqual([200, 300]);
    const [wx, wy] = c.screenToWorld(123, 456);
    const [sx, sy] = c.worldToScreen(wx, wy);
    expect(sx).toBeCloseTo(123, 9);
    expect(sy).toBeCloseTo(456, 9);
    // Inclinaison : un bloc est moins haut que large.
    expect(c.worldToScreen(32, 33)[1] - 300).toBeCloseTo(40 * TILT, 9);
  });

  it('glisser : la caméra suit le doigt', () => {
    const c = cam();
    c.panByScreen(80, 0); // doigt vers la droite : on voit plus à gauche
    expect(c.x).toBeCloseTo(30, 9);
    c.panByScreen(0, -40 * TILT);
    expect(c.y).toBeCloseTo(33, 9);
  });

  it('limites : le centre ne sort pas de la face', () => {
    const c = cam();
    c.panByScreen(1e6, 1e6);
    expect([c.x, c.y]).toEqual([0, 0]);
    c.panByScreen(-1e7, -1e7);
    expect([c.x, c.y]).toEqual([64, 64]);
  });

  it('zoom borné et ancré sous le pointeur', () => {
    const c = cam();
    const [wx, wy] = c.screenToWorld(300, 100);
    c.zoomAt(1.5, 300, 100);
    const [wx2, wy2] = c.screenToWorld(300, 100);
    expect(wx2).toBeCloseTo(wx, 9);
    expect(wy2).toBeCloseTo(wy, 9);
    c.zoomAt(1000);
    expect(c.zoom).toBe(c.maxZoom);
    c.zoomAt(0.0001);
    expect(c.zoom).toBe(c.minZoom);
  });

  it('inertie : le lancer décélère puis s\'arrête', () => {
    const c = cam();
    c.fling(-800, 0); // doigt lancé vers la gauche : on avance vers la droite
    let moved = 0;
    let frames = 0;
    const x0 = c.x;
    while (c.update(16) && frames < 1000) frames++;
    moved = c.x - x0;
    expect(moved).toBeGreaterThan(2);
    expect(moved).toBeLessThan(10);
    expect(c.animating).toBe(false);
    expect(frames).toBeLessThan(200);
  });

  it('sans inertie (préférence de mouvement réduit), le lancer n\'a pas d\'effet', () => {
    const c = cam();
    c.inertia = false;
    c.fling(-3000, 0);
    expect(c.update(16)).toBe(false);
  });

  it('animation vers une cible (recentrer) puis arrêt exact', () => {
    const c = cam();
    c.animateTo({ x: 10, y: 50, zoom: 60 }, 300);
    for (let i = 0; i < 30; i++) c.update(16);
    expect([c.x, c.y, c.zoom]).toEqual([10, 50, 60]);
    expect(c.animating).toBe(false);
  });
});

describe('gestes', () => {
  function rec() {
    const log: string[] = [];
    const h: GestureHandlers = {
      start: () => log.push('start'),
      pan: (dx, dy) => log.push(`pan ${dx},${dy}`),
      panEnd: (vx, vy) => log.push(`end ${Math.round(vx)},${Math.round(vy)}`),
      pinch: (s) => log.push(`pinch ${s.toFixed(2)}`),
      tap: (x, y, k) => log.push(`tap ${x},${y},${k}`),
    };
    return { log, g: new GestureTracker(h) };
  }

  it('toucher bref sans mouvement : sélection', () => {
    const { log, g } = rec();
    g.down(1, 100, 100, 0, 'touch');
    g.move(1, 104, 103, 50);
    g.up(1, 104, 103, 120);
    expect(log).toEqual(['start', 'tap 104,103,touch']);
  });

  it('au-delà du seuil : glisser, jamais de sélection', () => {
    const { log, g } = rec();
    g.down(1, 100, 100, 0, 'touch');
    g.move(1, 100 + TAP_SLOP.touch + 1, 100, 30);
    g.move(1, 130, 100, 60);
    g.up(1, 130, 100, 70);
    expect(log.some((l) => l.startsWith('tap'))).toBe(false);
    expect(log.filter((l) => l.startsWith('pan'))).toEqual(['pan 11,0', 'pan 19,0']);
    expect(log.at(-1)).toMatch(/^end \d+,0$/);
  });

  it('la souris a un seuil plus fin que le doigt', () => {
    const { log, g } = rec();
    g.down(1, 0, 0, 0, 'mouse');
    g.move(1, 7, 0, 10);
    g.up(1, 7, 0, 20);
    expect(log.some((l) => l.startsWith('tap'))).toBe(false);
    const t = rec();
    t.g.down(1, 0, 0, 0, 'touch');
    t.g.move(1, 7, 0, 10);
    t.g.up(1, 7, 0, 20);
    expect(t.log.at(-1)).toBe('tap 7,0,touch');
  });

  it('appui long immobile : pas de sélection (évite les sélections involontaires)', () => {
    const { log, g } = rec();
    g.down(1, 10, 10, 0, 'touch');
    g.up(1, 10, 10, 900);
    expect(log).toEqual(['start']);
  });

  it('doigt arrêté avant de lever : pas d\'inertie', () => {
    const { log, g } = rec();
    g.down(1, 0, 0, 0, 'touch');
    g.move(1, 50, 0, 20);
    g.move(1, 100, 0, 40);
    g.up(1, 100, 0, 400);
    expect(log.at(-1)).toBe('end 0,0');
  });

  it('pincer : zoom, puis le doigt restant déplace sans sélectionner', () => {
    const { log, g } = rec();
    g.down(1, 100, 100, 0, 'touch');
    g.down(2, 200, 100, 5, 'touch');
    g.move(2, 300, 100, 30); // écart 100 → 200
    expect(log).toContain('pinch 2.00');
    g.up(2, 300, 100, 40);
    g.move(1, 120, 100, 60);
    g.up(1, 120, 100, 80);
    expect(log.some((l) => l.startsWith('tap'))).toBe(false);
    expect(log).toContain('pan 20,0');
  });
});
