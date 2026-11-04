/** Palette des strates : du sable en surface à la roche profonde puis au cœur violet. */
export const STRATA = ['#c9a36b', '#b48a5a', '#9c7a58', '#866b55', '#6f5d55', '#5c5260', '#4b4766', '#3f3d6e', '#383677', '#4a3a86'];

export function strataColor(layer: number, size: number): string {
  const t = size <= 1 ? 0 : layer / (size - 1);
  return STRATA[Math.min(STRATA.length - 1, Math.round(t * (STRATA.length - 1)))];
}

export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function shade(hex: string, f: number): string {
  const [r, g, b] = rgb(hex);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

/** Couleur stable dérivée d'un nom (brigades) : teinte HSL. */
export function nameHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}
