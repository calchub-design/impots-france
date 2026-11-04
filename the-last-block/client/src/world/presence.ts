import { PRESENCE_WINDOW_MS, type PresenceEntry } from '../../../shared/protocol.js';
import type { ViewCamera as Camera } from './view.js';
import { toXY } from './face.js';
import type { WorldLayer } from './surface.js';
import { placeLabels, type LabelRequest, type PlacedLabel } from './labels.js';

/**
 * Marqueurs des autres mineurs : uniquement des observations réelles (dernier
 * bloc frappé il y a moins de 20 s, transmis par le serveur). Aucun joueur
 * n'est inventé ; un marqueur s'estompe avec l'âge de l'observation puis
 * disparaît. Sans donnée, rien n'est affiché.
 */

export interface PresenceMarker extends PresenceEntry {
  /** Instant local (performance.now) de réception. */
  receivedAt: number;
}

/**
 * Couleurs des brigades : palette choisie pour rester distinctes entre elles
 * et du doré (sélection), du rouge (refus) et du cyan de l'interface.
 * Attribution stable : dérivée du nom, identique pour tous les joueurs.
 */
export const BRIGADE_COLORS = ['#5ef2b0', '#ff7ad1', '#9aa6ff', '#ffa24c', '#c98bff', '#b8f25e', '#ff6f91', '#47d6c8', '#f2e35e', '#6fb7ff'];

export function brigadeColor(name: string | null): string {
  if (!name) return 'rgba(220,220,235,0.85)';
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  return BRIGADE_COLORS[h % BRIGADE_COLORS.length];
}

/** Âge actuel (ms) d'une observation. */
export function presenceAge(m: PresenceMarker, now: number): number {
  return m.ageMs + (now - m.receivedAt);
}

/** Regroupe les observations par bloc (plusieurs mineurs sur le même bloc). */
export function groupByBlock(markers: PresenceMarker[], now: number): Map<number, PresenceMarker[]> {
  const out = new Map<number, PresenceMarker[]>();
  for (const m of markers) {
    if (presenceAge(m, now) > PRESENCE_WINDOW_MS) continue;
    const list = out.get(m.block) ?? [];
    list.push(m);
    out.set(m.block, list);
  }
  return out;
}

export class PresenceLayer implements WorldLayer {
  markers: PresenceMarker[] = [];
  faceSize = 32;
  myId: string | null = null;
  myBrigade: string | null = null;
  reducedMotion = false;
  /** Zones de l'écran couvertes par l'interface (bandeau, mini-carte…), à laisser libres. */
  reserved: PlacedLabel[] = [];

  /** Animation continue seulement pendant le balancement des pioches (observations < 2,5 s). */
  animating() {
    if (this.reducedMotion) return false;
    const now = performance.now();
    return this.markers.some((m) => m.playerId !== this.myId && presenceAge(m, now) < 2500);
  }

  /**
   * Balises des mineurs : faisceau vertical et drone aux couleurs de la
   * brigade, à l'échelle de la perspective (les lointains sont plus petits),
   * puis étiquettes placées sans chevauchement (world/labels.ts).
   */
  over(ctx: CanvasRenderingContext2D, cam: Camera, time: number) {
    const now = performance.now();
    const groups = groupByBlock(
      this.markers.filter((m) => m.playerId !== this.myId),
      now,
    );
    if (groups.size === 0) return;
    const W = cam.viewW;
    const H = cam.viewH;
    const reqs: LabelRequest[] = [];
    const labels: { text: string; color: string; alpha: number; ally: boolean; ax: number; ay: number }[] = [];
    for (const [block, all] of groups) {
      const { x, y } = toXY(block, this.faceSize);
      const [sx, sy] = cam.worldToScreen(x + 0.5, y + 0.5);
      if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 100) continue;
      const s = cam.scaleAt ? cam.scaleAt(x + 0.5, y + 0.5) : cam.zoom;
      if (!(s > 0.8)) continue;
      const list = [...all].sort((a, b) => presenceAge(a, now) - presenceAge(b, now));
      const m = list[0];
      const age = presenceAge(m, now);
      const fresh = age < 2500;
      const alpha = Math.max(0.3, 1 - age / PRESENCE_WINDOW_MS);
      const ally = !!this.myBrigade && list.some((e) => e.brigadeName === this.myBrigade);
      const color = brigadeColor(ally ? this.myBrigade : m.brigadeName);
      const beamH = Math.max(12, Math.min(96, s * 1.9));
      const bw = Math.max(1.5, Math.min(6, s * 0.12)) * (ally ? 1.6 : 1);
      const d = Math.max(3.5, Math.min(11, s * 0.22)) * (ally ? 1.2 : 1);
      const bob = fresh && !this.reducedMotion ? Math.sin(time / 260 + block) * d * 0.25 : 0;
      const top = sy - beamH + bob;
      ctx.save();
      ctx.globalAlpha = alpha;
      // Anneau au sol (et onde de frappe tant que l'observation est fraîche)
      ctx.globalCompositeOperation = 'lighter';
      const gr = Math.max(3, s * 0.42);
      ctx.strokeStyle = color;
      ctx.lineWidth = ally ? 2 : 1.3;
      ctx.beginPath();
      ctx.ellipse(sx, sy, gr, gr * 0.5, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (fresh && !this.reducedMotion) {
        const k = (age % 900) / 900;
        ctx.globalAlpha = alpha * (1 - k) * 0.8;
        ctx.beginPath();
        ctx.ellipse(sx, sy, gr * (1 + k * 1.4), gr * 0.5 * (1 + k * 1.4), 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = alpha;
      }
      // Faisceau
      const g = ctx.createLinearGradient(sx, sy, sx, top);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.globalAlpha = alpha * 0.75;
      ctx.fillRect(sx - bw / 2, top, bw, sy - top);
      ctx.restore();
      // Drone (losange) au sommet du faisceau
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = color;
      ctx.shadowBlur = d * 1.2;
      ctx.fillStyle = 'rgba(8,10,26,0.9)';
      ctx.strokeStyle = color;
      ctx.lineWidth = ally ? 2.2 : 1.6;
      ctx.beginPath();
      ctx.moveTo(sx, top - d);
      ctx.lineTo(sx + d * 0.8, top);
      ctx.lineTo(sx, top + d);
      ctx.lineTo(sx - d * 0.8, top);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, top, d * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Étiquette : seulement quand le marqueur est assez proche pour être lu.
      if (s >= 14 || (ally && s >= 8)) {
        const text = `${ally ? '⚑ ' : ''}${m.name}${list.length > 1 ? ` +${list.length - 1}` : ''}`;
        ctx.font = LABEL_FONT;
        const w = Math.ceil(ctx.measureText(text).width) + 14;
        reqs.push({ id: labels.length, ax: sx, ay: top - d - 2, w, h: LABEL_H, priority: (ally ? 1000 : 0) + (fresh ? 100 : 0) + Math.min(99, s) });
        labels.push({ text, color, alpha, ally, ax: sx, ay: top - d - 2 });
      }
    }
    const placed = placeLabels(reqs, W, H, this.reserved);
    ctx.save();
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const p of placed) {
      const l = labels[p.id];
      ctx.globalAlpha = l.alpha;
      // Étiquette décalée : un fil la relie à son drone.
      const lx = Math.max(p.x + 4, Math.min(p.x + p.w - 4, l.ax));
      if (Math.hypot(lx - l.ax, p.y + p.h - l.ay) > 6) {
        ctx.strokeStyle = l.color;
        ctx.lineWidth = 1;
        ctx.globalAlpha = l.alpha * 0.6;
        ctx.beginPath();
        ctx.moveTo(lx, p.y + p.h);
        ctx.lineTo(l.ax, l.ay);
        ctx.stroke();
        ctx.globalAlpha = l.alpha;
      }
      ctx.fillStyle = 'rgba(8,10,26,0.82)';
      ctx.beginPath();
      ctx.roundRect(p.x, p.y, p.w, p.h, 4);
      ctx.fill();
      ctx.fillStyle = l.color;
      ctx.fillRect(p.x, p.y + 2, l.ally ? 3 : 2, p.h - 4);
      ctx.fillText(l.text, p.x + 8, p.y + p.h / 2 + 0.5);
    }
    ctx.restore();
  }
}

const LABEL_FONT = '700 11px system-ui, sans-serif';
const LABEL_H = 17;
