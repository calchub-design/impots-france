import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from '../client/src/world/monolith/persp.js';

function cam(size = 48, layer = 0) {
  const c = new PerspectiveCamera();
  c.setViewport(390, 700);
  c.cubeSize = size;
  c.surfaceZ = size - layer;
  c.setBounds({ minX: 0, maxX: size, minY: 0, maxY: size });
  c.frameMonument();
  c.minZoom = c.monumentalZoom;
  c.animateTo({ x: size / 2, y: size / 2, zoom: 30 }, 0);
  return c;
}

describe('caméra en perspective (rendu monolithe)', () => {
  it('le point visé est au centre de l\'écran et vaut « zoom » pixels par bloc', () => {
    const c = cam();
    const [sx, sy] = c.worldToScreen(24, 24);
    expect(sx).toBeCloseTo(195, 6);
    expect(sy).toBeCloseTo(350, 6);
    const [ex] = c.worldToScreen(25, 24);
    expect(ex - sx).toBeCloseTo(30, 6);
  });

  it('écran → surface → écran : aller-retour exact', () => {
    const c = cam();
    for (const [x, y] of [[10, 600], [200, 300], [380, 650], [50, 120]]) {
      const [wx, wy] = c.screenToWorld(x, y);
      const [sx, sy] = c.worldToScreen(wx, wy);
      expect(sx).toBeCloseTo(x, 5);
      expect(sy).toBeCloseTo(y, 5);
    }
  });

  it('vraie perspective : les blocs lointains (nord) sont plus petits que les proches', () => {
    const c = cam();
    const width = (y: number) => c.worldToScreen(25, y)[0] - c.worldToScreen(24, y)[0];
    expect(width(30)).toBeGreaterThan(width(24));
    expect(width(24)).toBeGreaterThan(width(10));
    expect(width(10) / width(30)).toBeLessThan(0.6);
  });

  it('vue de minage au zoom habituel, vue monumentale au zoom minimal, transition continue', () => {
    const c = cam();
    expect(c.t).toBe(0);
    c.animateTo({ zoom: c.monumentalZoom }, 0);
    expect(c.t).toBe(1);
    let prev = 1;
    for (let z = c.monumentalZoom; z <= 30; z *= 1.15) {
      c.animateTo({ zoom: z }, 0);
      expect(c.t).toBeLessThanOrEqual(prev + 1e-9);
      prev = c.t;
    }
  });

  it('cadrage monumental : les 8 coins du cube sont à l\'écran', () => {
    for (const [size, w, h] of [[32, 390, 700], [48, 390, 700], [64, 1280, 860], [10, 740, 300]]) {
      const c = new PerspectiveCamera();
      c.setViewport(w, h);
      c.cubeSize = size;
      c.surfaceZ = size;
      c.frameMonument();
      c.animateTo({ x: size / 2, y: size / 2, zoom: c.monumentalZoom }, 0);
      for (const x of [0, size]) for (const y of [0, size]) for (const z of [0, size]) {
        const p = c.project(x, y, z);
        expect(p, `${size} ${x},${y},${z}`).not.toBeNull();
        expect(p![0]).toBeGreaterThanOrEqual(0);
        expect(p![0]).toBeLessThanOrEqual(w);
        expect(p![1]).toBeGreaterThanOrEqual(0);
        expect(p![1]).toBeLessThanOrEqual(h);
      }
    }
  });

  it('glisser : la surface suit le doigt (le point saisi reste sous le doigt)', () => {
    const c = cam();
    const [wx, wy] = c.screenToWorld(195, 350);
    c.panByScreen(60, -40);
    const [sx, sy] = c.worldToScreen(wx, wy);
    expect(sx).toBeCloseTo(255, 3);
    expect(sy).toBeCloseTo(310, 3);
  });

  it('zoom ancré : le point sous le doigt ne bouge pas (vue de minage)', () => {
    const c = cam();
    const [wx, wy] = c.screenToWorld(300, 500);
    c.zoomAt(1.3, 300, 500);
    const [sx, sy] = c.worldToScreen(wx, wy);
    expect(sx).toBeCloseTo(300, 3);
    expect(sy).toBeCloseTo(500, 3);
  });

  it('en vue monumentale, glisser fait tourner autour du monolithe sans déplacer la cible', () => {
    const c = cam();
    c.animateTo({ zoom: c.monumentalZoom }, 0);
    const x = c.x;
    c.panByScreen(100, 0);
    expect(c.x).toBe(x);
    expect(c.yawUser).toBeCloseTo(0.6, 6);
  });

  it('au-dessus de l\'horizon : pas d\'intersection, mais un point lointain fini', () => {
    const c = cam();
    c.animateTo({ zoom: c.monumentalZoom }, 0);
    expect(c.unproject(195, 0)).toBeNull();
    const [wx, wy] = c.screenToWorld(195, 0);
    expect(Number.isFinite(wx) && Number.isFinite(wy)).toBe(true);
  });

  it('inertie bornée puis arrêt ; limites de la face respectées', () => {
    const c = cam();
    c.fling(-1500, 0);
    let frames = 0;
    while (c.update(16) && frames < 2000) frames++;
    expect(frames).toBeLessThan(400);
    expect(c.x).toBeLessThanOrEqual(48);
    c.panByScreen(-1e5, -1e5);
    for (let i = 0; i < 50; i++) c.panByScreen(-1e5, -1e5);
    expect(c.x).toBeLessThanOrEqual(48);
    expect(c.y).toBeGreaterThanOrEqual(0);
  });
});

describe('échelle locale (balises de présence)', () => {
  it('vaut le zoom au point visé et diminue avec la distance', () => {
    const c = cam(48);
    c.animateTo({ x: 24, y: 30, zoom: 32 }, 0);
    c.update(16);
    expect(c.scaleAt(24, 30)).toBeCloseTo(32, 0);
    expect(c.scaleAt(24, 10)).toBeLessThan(c.scaleAt(24, 30) * 0.8);
  });
});
