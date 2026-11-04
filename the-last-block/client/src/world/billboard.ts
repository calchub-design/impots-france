import type { ViewCamera as Camera } from './view.js';
import type { WorldLayer } from './surface.js';

/**
 * Panneau lumineux monumental, planté au-delà du bord nord de la face.
 * Il fait partie du décor (il défile avec la caméra) : on le découvre en
 * remontant vers le nord ou via « Regarder le panneau ». Il ne montre que le
 * top 3, la meilleure brigade, l'avancement et la saison : le classement
 * complet reste dans l'onglet Classement.
 */

export interface BillboardData {
  seasonName: string;
  countdown: string;
  top: { name: string; color: string; hits: number }[];
  brigade: { name: string; hits: number; eligible: boolean } | null;
  progress: number; // 0..1
  finalStone: boolean;
}

/** Dimensions en blocs (largeur) et en hauteurs de bloc (vertical). */
export const BOARD = { width: 22, posts: 2.2, height: 8 };

/** Position de caméra (y) qui centre le panneau à l'écran, indépendamment du zoom. */
export function billboardCameraY(tilt: number): number {
  return -(BOARD.posts + BOARD.height / 2) / tilt;
}

export class BillboardLayer implements WorldLayer {
  data: BillboardData | null = null;
  faceSize = 32;
  reducedMotion = false;

  animating() {
    return false;
  }

  under(ctx: CanvasRenderingContext2D, cam: Camera, time: number) {
    const d = this.data;
    if (!d) return;
    const z = cam.zoom;
    const w = Math.min(BOARD.width, this.faceSize + 4) * z;
    const [cx, baseY] = cam.worldToScreen(this.faceSize / 2, 0);
    const postH = BOARD.posts * z;
    const h = BOARD.height * z;
    const left = cx - w / 2;
    const bottom = baseY - postH;
    const top = bottom - h;
    // Hors champ : rien à dessiner.
    if (bottom < -10 || top > cam.viewH || left > cam.viewW || left + w < 0) return;
    // Piliers et ombres
    ctx.fillStyle = '#25213d';
    const pw = Math.max(4, z * 0.6);
    for (const px of [left + w * 0.16, left + w * 0.84 - pw]) {
      ctx.fillRect(px, bottom - 2, pw, postH + 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(px + pw, bottom, pw * 0.4, postH);
      ctx.fillStyle = '#25213d';
    }
    this.paintPanel(ctx, left, top, w, h, time);
  }

  /**
   * Dessine le panneau (cadre, ampoules, contenu) dans le rectangle donné.
   * Utilisé par le rendu classique et, via une texture, par le rendu « monolithe ».
   */
  paintPanel(ctx: CanvasRenderingContext2D, left: number, top: number, w: number, h: number, time: number) {
    const d = this.data;
    if (!d) return;
    const z = h / BOARD.height;
    const bottom = top + h;
    // Cadre et écran
    ctx.fillStyle = '#2e2a4a';
    roundRect(ctx, left, top, w, h, z * 0.35);
    ctx.fill();
    const inset = Math.max(4, z * 0.3);
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, '#17143a');
    grad.addColorStop(1, '#0c0a22');
    ctx.fillStyle = grad;
    roundRect(ctx, left + inset, top + inset, w - 2 * inset, h - 2 * inset, z * 0.2);
    ctx.fill();
    // Ampoules
    const n = Math.max(6, Math.floor(w / Math.max(10, z * 0.9)));
    for (let i = 0; i < n; i++) {
      const on = this.reducedMotion ? i % 2 === 0 : Math.sin(time / 250 - i * 0.6) > 0;
      ctx.fillStyle = on ? '#ffd76a' : '#5b4a22';
      const bx = left + inset + ((w - 2 * inset) * i) / (n - 1);
      ctx.beginPath();
      ctx.arc(bx, top + inset / 2, Math.max(1.5, z * 0.09), 0, Math.PI * 2);
      ctx.arc(bx, bottom - inset / 2, Math.max(1.5, z * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }
    // Contenu (taille du texte proportionnelle au zoom : il fait partie du décor)
    const u = h / 10;
    const x0 = left + inset * 2.2;
    const x1 = left + w - inset * 2.2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffe08a';
    ctx.font = `800 ${u * 0.95}px system-ui, sans-serif`;
    ctx.fillText('★ PANNEAU DES MINEURS', x0, top + u * 1.5);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#b9b4dc';
    ctx.font = `600 ${u * 0.62}px system-ui, sans-serif`;
    ctx.fillText(`${d.seasonName}${d.countdown ? ' · ' + d.countdown : ''}`, x1, top + u * 1.5);
    const medals = ['#ffd24a', '#d5dbe6', '#d08a4a'];
    for (let i = 0; i < 3; i++) {
      const e = d.top[i];
      const y = top + u * (3 + i * 1.45);
      ctx.fillStyle = medals[i];
      ctx.beginPath();
      ctx.arc(x0 + u * 0.45, y, u * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1405';
      ctx.textAlign = 'center';
      ctx.font = `800 ${u * 0.55}px system-ui, sans-serif`;
      ctx.fillText(String(i + 1), x0 + u * 0.45, y + 0.5);
      ctx.textAlign = 'left';
      ctx.font = `700 ${u * 0.82}px system-ui, sans-serif`;
      ctx.fillStyle = e ? e.color : 'rgba(255,255,255,0.35)';
      ctx.fillText(e ? e.name : '—', x0 + u * 1.2, y);
      if (e) {
        ctx.textAlign = 'right';
        ctx.fillStyle = '#f4f1ea';
        ctx.font = `700 ${u * 0.82}px ui-monospace, Menlo, monospace`;
        ctx.fillText(e.hits.toLocaleString('fr-FR'), x1, y);
      }
    }
    ctx.textAlign = 'left';
    ctx.font = `600 ${u * 0.62}px system-ui, sans-serif`;
    ctx.fillStyle = '#b9b4dc';
    const by = top + u * 7.35;
    ctx.fillText(
      d.brigade ? `⚑ Meilleure brigade : ${d.brigade.name} (${d.brigade.hits.toLocaleString('fr-FR')})${d.brigade.eligible ? '' : ' — en formation'}` : '⚑ Aucune brigade pour l\'instant',
      x0,
      by,
    );
    // Progression
    const py = top + u * 8.5;
    ctx.fillStyle = '#26224a';
    roundRect(ctx, x0, py - u * 0.22, x1 - x0, u * 0.44, u * 0.22);
    ctx.fill();
    ctx.fillStyle = d.finalStone ? '#ff7a5a' : '#f2c14e';
    roundRect(ctx, x0, py - u * 0.22, Math.max(u * 0.44, (x1 - x0) * d.progress), u * 0.44, u * 0.22);
    ctx.fill();
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ece9f5';
    ctx.font = `700 ${u * 0.55}px system-ui, sans-serif`;
    const pct = `${(d.progress * 100).toFixed(d.progress > 0 && d.progress < 0.01 ? 2 : 1).replace('.', ',')} %`;
    ctx.fillText(`${d.finalStone ? '◆ Pierre finale en jeu · ' : ''}cube miné : ${pct}`, x1, py - u * 0.6);
  }

  /** Lueur du panneau projetée sur le nord de la face (impression de hauteur et de lumière). */
  over(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (!this.data) return;
    const z = cam.zoom;
    const w = Math.min(BOARD.width, this.faceSize + 4) * z;
    const [cx, baseY] = cam.worldToScreen(this.faceSize / 2, 0);
    this.glow(ctx, cx, baseY, w, z, cam);
  }

  private glow(ctx: CanvasRenderingContext2D, cx: number, baseY: number, w: number, z: number, cam: Camera) {
    if (baseY < -z * 6 || baseY > cam.viewH + z * 6) return;
    const g = ctx.createRadialGradient(cx, baseY, z, cx, baseY, w * 0.7);
    g.addColorStop(0, 'rgba(255,215,106,0.16)');
    g.addColorStop(1, 'rgba(255,215,106,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - w, baseY - z * 2, w * 2, w * 0.8);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
