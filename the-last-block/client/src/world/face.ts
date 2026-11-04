/**
 * Modèle d'une face jouable du cube.
 *
 * Le serveur ne connaît qu'une surface minable : le dessus de la couche
 * courante (grille taille × taille, index = y × taille + x). C'est la face
 * `top`. Les autres identifiants sont réservés pour une évolution future et
 * ne sont PAS jouables aujourd'hui.
 *
 * Ce module ne touche pas au DOM (testé par Vitest).
 */

export type FaceId = 'top';

export interface FaceData {
  faceId: FaceId;
  size: number;
  /** Couche serveur dont cette face est le dessus. */
  layer: number;
  maxHp: number;
  /** PV par bloc (référence partagée avec l'état client, mis à jour par le serveur uniquement). */
  hp: readonly number[];
}

export function toXY(idx: number, size: number): { x: number; y: number } {
  return { x: idx % size, y: Math.floor(idx / size) };
}

export function toIdx(x: number, y: number, size: number): number {
  return y * size + x;
}

export function inFace(x: number, y: number, size: number): boolean {
  return x >= 0 && y >= 0 && x < size && y < size && Number.isInteger(x) && Number.isInteger(y);
}

export function isAlive(face: FaceData, x: number, y: number): boolean {
  return inFace(x, y, face.size) && face.hp[toIdx(x, y, face.size)] > 0;
}

/** Voisins orthogonaux présents dans la face. */
export function neighbours(x: number, y: number, size: number): { x: number; y: number }[] {
  return [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 },
  ].filter((p) => inFace(p.x, p.y, size));
}

/**
 * Bloc vivant le plus proche d'un point (coordonnées en blocs, réelles),
 * recherche par anneaux carrés croissants. Renvoie null s'il n'y en a aucun
 * dans `maxRadius` blocs.
 */
export function nearestAlive(face: FaceData, px: number, py: number, maxRadius = face.size): number | null {
  const size = face.size;
  const cx = Math.min(size - 1, Math.max(0, Math.floor(px)));
  const cy = Math.min(size - 1, Math.max(0, Math.floor(py)));
  let best: number | null = null;
  let bestD = Infinity;
  for (let r = 0; r <= maxRadius; r++) {
    // Un bloc de l'anneau r est à une distance ≥ r - 1 du point : on peut s'arrêter.
    if (best !== null && (r - 1) ** 2 > bestD) break;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        if (!isAlive(face, x, y)) continue;
        const d = (x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2;
        if (d < bestD) {
          bestD = d;
          best = toIdx(x, y, size);
        }
      }
    }
  }
  return best;
}

/** Plage de blocs (bornes incluses) intersectant un rectangle du monde. */
export function visibleRange(size: number, minX: number, minY: number, maxX: number, maxY: number) {
  return {
    x0: Math.max(0, Math.floor(minX)),
    y0: Math.max(0, Math.floor(minY)),
    x1: Math.min(size - 1, Math.ceil(maxX) - 1),
    y1: Math.min(size - 1, Math.ceil(maxY) - 1),
  };
}

/** Bruit déterministe [0, 1) par bloc (texture, fissures) : identique pour tous les clients. */
export function hash2(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
