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

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Deux rectangles se chevauchent-ils (avec une marge en px) ? */
export function rectsOverlap(a: ScreenRect, b: ScreenRect, margin = 0): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

/**
 * L'écran holographique est-il lisible à l'écran ? Assez large (35 % de la vue),
 * assez opaque (il s'estompe en vue de minage) et visible aux deux tiers au moins.
 * Dans ce cas le bandeau compact, qui répète le même classement, est masqué.
 */
export function boardReadable(rect: ScreenRect | null, alpha: number, viewW: number, viewH: number): boolean {
  if (!rect || rect.w <= 0 || rect.h <= 0 || alpha < 0.45 || rect.w < viewW * 0.35) return false;
  const vw = Math.max(0, Math.min(viewW, rect.x + rect.w) - Math.max(0, rect.x));
  const vh = Math.max(0, Math.min(viewH, rect.y + rect.h) - Math.max(0, rect.y));
  return (vw * vh) / (rect.w * rect.h) >= 0.66;
}

/**
 * Découpe un message en lignes tenant dans `maxWidth` (mesure du contexte courant),
 * au plus `maxLines` lignes ; la dernière est terminée par « … » si le texte déborde.
 */
export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines = 4): string[] {
  const lines: string[] = [];
  let line = '';
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = words[i];
    if (lines.length === maxLines) {
      line = '';
      const last = lines.length - 1;
      let cut = lines[last];
      while (cut && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
      lines[last] = `${cut.trimEnd()}…`;
      return lines;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Message centré sur plusieurs lignes (indisponibilité, maintenance, intersaison). */
export function drawCenteredMessage(ctx: CanvasRenderingContext2D, text: string, w: number, h: number) {
  const size = Math.max(14, Math.min(20, w / 26));
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, text, Math.max(120, w - 48));
  const lh = size * 1.35;
  const y0 = h / 2 - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, w / 2, y0 + i * lh));
}
