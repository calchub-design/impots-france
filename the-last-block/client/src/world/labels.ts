/**
 * Placement des étiquettes sans chevauchement (pseudos des mineurs).
 *
 * Glouton par priorité : chaque étiquette essaie quelques positions autour de
 * son point d'ancrage (au-dessus, décalée à droite, à gauche, plus haut) et
 * n'est affichée que si elle ne touche aucune étiquette déjà placée. Une
 * étiquette qui ne trouve pas de place est masquée (le marqueur reste visible).
 * Fonction pure, testée dans tests/labels.test.ts.
 */

export interface LabelRequest {
  id: number;
  /** Point d'ancrage à l'écran : l'étiquette se place au-dessus. */
  ax: number;
  ay: number;
  w: number;
  h: number;
  /** Plus grand = placé en premier (alliés, observations récentes, proches). */
  priority: number;
}

export interface PlacedLabel {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const GAP = 3;

function candidates(r: LabelRequest): [number, number][] {
  const { ax, ay, w, h } = r;
  return [
    [ax - w / 2, ay - h],
    [ax + 6, ay - h * 0.9],
    [ax - w - 6, ay - h * 0.9],
    [ax - w / 2, ay - 2 * h - 2 * GAP - 1],
    [ax + 6, ay - 2 * h - 2 * GAP - 1],
    [ax - w - 6, ay - 2 * h - 2 * GAP - 1],
  ];
}

function hits(a: PlacedLabel, b: PlacedLabel): boolean {
  return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
}

export function placeLabels(reqs: LabelRequest[], viewW: number, viewH: number, reserved: PlacedLabel[] = []): PlacedLabel[] {
  const order = [...reqs].sort((a, b) => b.priority - a.priority || a.id - b.id);
  const placed: PlacedLabel[] = [];
  const taken = [...reserved];
  for (const r of order) {
    for (const [cx, cy] of candidates(r)) {
      // Reste dans la vue (marge de 2 px).
      const x = Math.max(2, Math.min(viewW - r.w - 2, cx));
      const y = Math.max(2, Math.min(viewH - r.h - 2, cy));
      // Une étiquette repoussée trop loin de son marqueur serait trompeuse.
      if (Math.abs(x + r.w / 2 - r.ax) > r.w / 2 + 12 + r.w || Math.abs(y + r.h - r.ay) > 3 * r.h) continue;
      const box = { id: r.id, x, y, w: r.w, h: r.h };
      if (taken.some((t) => hits(t, box))) continue;
      placed.push(box);
      taken.push(box);
      break;
    }
  }
  return placed;
}
