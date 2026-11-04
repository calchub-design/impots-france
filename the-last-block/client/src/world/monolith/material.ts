/**
 * Matériau « pierre-tech » du monolithe : teintes froides (ardoise bleutée en
 * surface, violet profond vers le cœur), joints sombres, lignes de structure
 * cyan, runes rares, lumière ambrée dans les fissures.
 */

export type RGB = [number, number, number];

export const PALETTE = {
  void: '#04050d',
  night: '#0b0c22',
  deep: '#140b2c',
  /** Brume lointaine : plus claire et plus bleue que la pierre (perspective atmosphérique). */
  fog: [34, 42, 92] as RGB,
  joint: '#070914',
  cyan: '#41e0ff',
  cyanSoft: '#7fe9ff',
  amber: '#ffb35c',
  gold: '#ffd27a',
  violet: '#8a5cff',
  danger: '#ff5a4a',
};

/** Strates : de l'ardoise bleutée (surface) au cœur violet (fond du cube). */
const STRATA_TECH: RGB[] = [
  [64, 76, 108],
  [58, 68, 104],
  [52, 60, 100],
  [50, 54, 98],
  [52, 50, 100],
  [56, 46, 104],
  [62, 44, 110],
  [70, 42, 118],
  [80, 42, 128],
  [92, 44, 140],
];

export function layerColor(layer: number, size: number): RGB {
  const t = size <= 1 ? 0 : Math.max(0, Math.min(1, layer / (size - 1)));
  const f = t * (STRATA_TECH.length - 1);
  const i = Math.floor(f);
  const k = f - i;
  const a = STRATA_TECH[i];
  const b = STRATA_TECH[Math.min(STRATA_TECH.length - 1, i + 1)];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function mix(a: RGB, b: RGB, k: number): RGB {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function scale(a: RGB, f: number): RGB {
  return [a[0] * f, a[1] * f, a[2] * f];
}

export function css(c: RGB, alpha = 1): string {
  const r = Math.max(0, Math.min(255, Math.round(c[0])));
  const g = Math.max(0, Math.min(255, Math.round(c[1])));
  const b = Math.max(0, Math.min(255, Math.round(c[2])));
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Glyphes gravés : figures abstraites (anneaux, arcs, points) décrites par
 * des segments dans un carré unité. Aucune ressemblance voulue avec un
 * alphabet connu : une écriture d'origine inconnue.
 */
export const GLYPHS: [number, number, number, number][][] = [
  // anneau percé d'un rayon
  [
    [0.82, 0.5, 0.759, 0.688],
    [0.759, 0.688, 0.599, 0.804],
    [0.599, 0.804, 0.401, 0.804],
    [0.401, 0.804, 0.241, 0.688],
    [0.241, 0.688, 0.18, 0.5],
    [0.18, 0.5, 0.241, 0.312],
    [0.241, 0.312, 0.401, 0.196],
    [0.401, 0.196, 0.599, 0.196],
    [0.599, 0.196, 0.759, 0.312],
    [0.759, 0.312, 0.82, 0.5],
    [0.5, 0.18, 0.5, 0.5],
  ],
  // deux arcs opposés
  [
    [0.181, 0.384, 0.253, 0.267],
    [0.253, 0.267, 0.365, 0.188],
    [0.365, 0.188, 0.5, 0.16],
    [0.5, 0.16, 0.635, 0.188],
    [0.635, 0.188, 0.747, 0.267],
    [0.747, 0.267, 0.819, 0.384],
    [0.669, 0.562, 0.62, 0.634],
    [0.62, 0.634, 0.544, 0.675],
    [0.544, 0.675, 0.456, 0.675],
    [0.456, 0.675, 0.38, 0.634],
    [0.38, 0.634, 0.331, 0.562],
  ],
  // triade de points autour d'un anneau
  [
    [0.47, 0.25, 0.53, 0.25],
    [0.5, 0.22, 0.5, 0.28],
    [0.25, 0.68, 0.31, 0.68],
    [0.28, 0.65, 0.28, 0.71],
    [0.69, 0.68, 0.75, 0.68],
    [0.72, 0.65, 0.72, 0.71],
    [0.62, 0.55, 0.597, 0.621],
    [0.597, 0.621, 0.537, 0.664],
    [0.537, 0.664, 0.463, 0.664],
    [0.463, 0.664, 0.403, 0.621],
    [0.403, 0.621, 0.38, 0.55],
    [0.38, 0.55, 0.403, 0.479],
    [0.403, 0.479, 0.463, 0.436],
    [0.463, 0.436, 0.537, 0.436],
    [0.537, 0.436, 0.597, 0.479],
    [0.597, 0.479, 0.62, 0.55],
  ],
  // anneau ouvert et rayon
  [
    [0.8, 0.5, 0.749, 0.667],
    [0.749, 0.667, 0.615, 0.777],
    [0.615, 0.777, 0.441, 0.794],
    [0.441, 0.794, 0.288, 0.712],
    [0.288, 0.712, 0.206, 0.559],
    [0.206, 0.559, 0.223, 0.385],
    [0.223, 0.385, 0.333, 0.251],
    [0.333, 0.251, 0.5, 0.2],
    [0.5, 0.5, 0.8, 0.5],
  ],
  // anneaux jumeaux
  [
    [0.5, 0.5, 0.471, 0.588],
    [0.471, 0.588, 0.396, 0.643],
    [0.396, 0.643, 0.304, 0.643],
    [0.304, 0.643, 0.229, 0.588],
    [0.229, 0.588, 0.2, 0.5],
    [0.2, 0.5, 0.229, 0.412],
    [0.229, 0.412, 0.304, 0.357],
    [0.304, 0.357, 0.396, 0.357],
    [0.396, 0.357, 0.471, 0.412],
    [0.471, 0.412, 0.5, 0.5],
    [0.8, 0.5, 0.771, 0.588],
    [0.771, 0.588, 0.696, 0.643],
    [0.696, 0.643, 0.604, 0.643],
    [0.604, 0.643, 0.529, 0.588],
    [0.529, 0.588, 0.5, 0.5],
    [0.5, 0.5, 0.529, 0.412],
    [0.529, 0.412, 0.604, 0.357],
    [0.604, 0.357, 0.696, 0.357],
    [0.696, 0.357, 0.771, 0.412],
    [0.771, 0.412, 0.8, 0.5],
  ],
  // cible concentrique
  [
    [0.83, 0.5, 0.767, 0.694],
    [0.767, 0.694, 0.602, 0.814],
    [0.602, 0.814, 0.398, 0.814],
    [0.398, 0.814, 0.233, 0.694],
    [0.233, 0.694, 0.17, 0.5],
    [0.17, 0.5, 0.233, 0.306],
    [0.233, 0.306, 0.398, 0.186],
    [0.398, 0.186, 0.602, 0.186],
    [0.602, 0.186, 0.767, 0.306],
    [0.767, 0.306, 0.83, 0.5],
    [0.64, 0.5, 0.613, 0.582],
    [0.613, 0.582, 0.543, 0.633],
    [0.543, 0.633, 0.457, 0.633],
    [0.457, 0.633, 0.387, 0.582],
    [0.387, 0.582, 0.36, 0.5],
    [0.36, 0.5, 0.387, 0.418],
    [0.387, 0.418, 0.457, 0.367],
    [0.457, 0.367, 0.543, 0.367],
    [0.543, 0.367, 0.613, 0.418],
    [0.613, 0.418, 0.64, 0.5],
    [0.47, 0.5, 0.53, 0.5],
    [0.5, 0.47, 0.5, 0.53],
  ],
];

/** Proportion de blocs gravés et « activés » (déterministe par bloc). */
export const RUNE_RATE = 0.05;
export const ACTIVE_RATE = 0.008;
/** Proportion de joints parcourus par une veine d'énergie. */
export const VEIN_RATE = 0.035;

/**
 * Bruit de valeur à grande échelle (plaques de plusieurs blocs) : casse
 * l'effet de damier par des variations lentes de teinte et de luminosité.
 */
export function plateNoise(x: number, y: number, h: (x: number, y: number, s: number) => number): number {
  const s = 5.5;
  const fx = x / s;
  const fy = y / s;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const kx = fx - ix;
  const ky = fy - iy;
  const sm = (t: number) => t * t * (3 - 2 * t);
  const a = h(ix, iy, 31);
  const b = h(ix + 1, iy, 31);
  const c = h(ix, iy + 1, 31);
  const d = h(ix + 1, iy + 1, 31);
  const top = a + (b - a) * sm(kx);
  const bot = c + (d - c) * sm(kx);
  return top + (bot - top) * sm(ky);
}
