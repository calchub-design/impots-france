import { PRESENCE_WINDOW_MS, type PresenceEntry } from '../../../shared/protocol.js';
import type { ViewCamera as Camera } from './view.js';
import { toXY } from './face.js';
import { nameHue } from './palette.js';
import type { WorldLayer } from './surface.js';

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

export function brigadeColor(name: string | null): string {
  return name ? `hsl(${nameHue(name)}, 75%, 62%)` : 'rgba(220,220,235,0.85)';
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

  /** Animation continue seulement pendant le balancement des pioches (observations < 2,5 s). */
  animating() {
    if (this.reducedMotion) return false;
    const now = performance.now();
    return this.markers.some((m) => m.playerId !== this.myId && presenceAge(m, now) < 2500);
  }

  over(ctx: CanvasRenderingContext2D, cam: Camera, time: number) {
    const now = performance.now();
    const groups = groupByBlock(
      this.markers.filter((m) => m.playerId !== this.myId),
      now,
    );
    if (groups.size === 0) return;
    const z = cam.zoom;
    const v = cam.visibleWorld();
    ctx.textBaseline = 'middle';
    for (const [block, list] of groups) {
      const { x, y } = toXY(block, this.faceSize);
      if (x + 1 < v.minX || x > v.maxX || y + 1 < v.minY || y > v.maxY) continue;
      const m = list[0];
      const age = presenceAge(m, now);
      const fresh = age < 2500;
      const alpha = Math.max(0.25, 1 - age / PRESENCE_WINDOW_MS);
      const [cx, cy] = cam.worldToScreen(x + 0.5, y + 0.5);
      const r = Math.max(6, Math.min(16, z * 0.32));
      const ally = !!this.myBrigade && m.brigadeName === this.myBrigade;
      ctx.globalAlpha = alpha;
      // Anneau aux couleurs de la brigade (gris : sans brigade)
      ctx.lineWidth = ally ? 3.5 : 2.5;
      ctx.strokeStyle = brigadeColor(m.brigadeName);
      ctx.fillStyle = 'rgba(10,12,28,0.78)';
      ctx.beginPath();
      ctx.arc(cx, cy - r * 0.6, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Pioche animée tant que l'observation est fraîche
      const swing = fresh && !this.reducedMotion ? Math.sin(time / 90) * 0.5 : 0;
      ctx.save();
      ctx.translate(cx, cy - r * 0.6);
      ctx.rotate(-0.6 + swing);
      ctx.fillStyle = '#ccb38a';
      ctx.fillRect(-r * 0.08, -r * 0.1, r * 0.16, r * 0.75);
      ctx.fillStyle = '#e8e6f0';
      ctx.beginPath();
      ctx.moveTo(-r * 0.62, -r * 0.05);
      ctx.quadraticCurveTo(0, -r * 0.55, r * 0.62, -r * 0.05);
      ctx.lineTo(r * 0.5, 0.06 * r);
      ctx.quadraticCurveTo(0, -r * 0.3, -r * 0.5, 0.06 * r);
      ctx.fill();
      ctx.restore();
      // Étiquette : nom (+ nombre de mineurs sur ce bloc), seulement si lisible
      if (z >= 24) {
        const label = `${ally ? '⚑ ' : ''}${m.name}${list.length > 1 ? ` +${list.length - 1}` : ''}`;
        ctx.font = `700 ${Math.min(12, Math.max(10, z * 0.24))}px system-ui, sans-serif`;
        const w = ctx.measureText(label).width + 10;
        const ly = cy - r * 1.6 - 9;
        ctx.fillStyle = 'rgba(10,12,28,0.8)';
        ctx.fillRect(cx - w / 2, ly - 8, w, 16);
        ctx.fillStyle = brigadeColor(m.brigadeName);
        ctx.textAlign = 'center';
        ctx.fillText(label, cx, ly + 0.5);
      } else if (list.length > 1) {
        ctx.font = '700 10px system-ui, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(String(list.length), cx, cy - r * 0.6);
      }
      ctx.globalAlpha = 1;
    }
  }
}
