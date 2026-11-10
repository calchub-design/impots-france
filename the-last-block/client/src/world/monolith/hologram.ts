/**
 * Écran holographique du classement, peint dans une texture (fond
 * transparent) puis posé dans la scène du monolithe en mode additif.
 *
 * Contenu : saison et compte à rebours, trois meilleurs mineurs, brigade en
 * tête (provisoire), anneau de progression du cube, couche courante, alerte
 * éventuelle (Pierre finale en jeu, couche presque terminée).
 */

import { countLabel } from '../../text.js';

export interface HoloData {
  seasonName: string;
  countdown: string;
  top: { name: string; color: string; hits: number }[];
  brigade: { name: string; hits: number; eligible: boolean } | null;
  /** Fraction du cube détruite (0..1). */
  progress: number;
  layer: number;
  layers: number;
  /** Fraction restante de la couche courante (0..1). */
  layerLeft: number;
  finalStone: boolean;
  /** Annonce temporaire du Signal (nouveau fragment, indice). */
  notice?: string | null;
}

const CYAN = '127,233,255';
const GOLD = '#ffd27a';
const MEDALS = ['#ffd24a', '#dfe6f2', '#e0995a'];

/** Alerte affichée sur l'écran (null si rien de notable). */
export function holoAlert(d: HoloData): string | null {
  if (d.finalStone) return '◆ PIERRE FINALE EN JEU';
  if (d.notice) return `◈ ${d.notice.toUpperCase()}`;
  if (d.layer === d.layers - 1) return '▲ DERNIÈRE COUCHE';
  if (d.layerLeft > 0 && d.layerLeft < 0.1) return `▲ COUCHE ${d.layer + 1} PRESQUE TERMINÉE`;
  return null;
}

function fmtPct(f: number): string {
  return `${(f * 100).toFixed(f > 0 && f < 0.01 ? 2 : 1).replace('.', ',')} %`;
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

/**
 * Police réduite jusqu'à ce que le texte tienne (au plus jusqu'à `min` × taille), puis
 * troncature en dernier recours : les libellés courts ne sont jamais coupés.
 */
function fitFont(ctx: CanvasRenderingContext2D, text: string, font: (px: number) => string, size: number, max: number, min = 0.62): string {
  for (let k = 1; k >= min - 1e-9; k -= 0.04) {
    ctx.font = font(size * k);
    if (ctx.measureText(text).width <= max) return text;
  }
  return fit(ctx, text, max);
}

function chamfer(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number) {
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

/** Peint l'écran holographique dans un canevas w × h (fond transparent). */
export function paintHologram(ctx: CanvasRenderingContext2D, w: number, h: number, d: HoloData, time: number, reducedMotion: boolean) {
  ctx.clearRect(0, 0, w, h);
  const u = h / 100; // unité de mise en page
  const c = u * 7;
  // Fond translucide et halo de bord.
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, 'rgba(40,140,200,0.20)');
  bg.addColorStop(1, 'rgba(110,60,200,0.16)');
  chamfer(ctx, u, u, w - 2 * u, h - 2 * u, c);
  ctx.fillStyle = bg;
  ctx.fill();
  // Lignes de balayage (défilent lentement).
  ctx.save();
  ctx.clip();
  const off = reducedMotion ? 0 : (time / 60) % (u * 3);
  ctx.fillStyle = `rgba(${CYAN},0.06)`;
  for (let y = off; y < h; y += u * 3) ctx.fillRect(0, y, w, u * 0.7);
  ctx.restore();
  // Double cadre lumineux et équerres.
  ctx.shadowColor = `rgba(${CYAN},0.9)`;
  ctx.shadowBlur = u * 3;
  ctx.strokeStyle = `rgba(${CYAN},0.85)`;
  ctx.lineWidth = u * 0.7;
  chamfer(ctx, u, u, w - 2 * u, h - 2 * u, c);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = `rgba(${CYAN},0.3)`;
  ctx.lineWidth = u * 0.35;
  chamfer(ctx, u * 3.2, u * 3.2, w - u * 6.4, h - u * 6.4, c * 0.7);
  ctx.stroke();

  const pad = u * 9;
  const left = pad;
  const right = w - pad;
  ctx.textBaseline = 'middle';
  // En-tête : saison + compte à rebours
  ctx.shadowColor = `rgba(${CYAN},0.8)`;
  ctx.shadowBlur = u * 2;
  ctx.fillStyle = `rgba(${CYAN},1)`;
  ctx.font = `800 ${u * 10.5}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(fit(ctx, `◈ ${d.seasonName.toUpperCase()}`, w * 0.45), left, u * 14);
  ctx.textAlign = 'right';
  ctx.fillStyle = `rgba(${CYAN},0.9)`;
  ctx.fillText(fitFont(ctx, d.countdown.toUpperCase(), (px) => `700 ${px}px system-ui, sans-serif`, u * 8.5, w * 0.42), right, u * 14);
  ctx.fillStyle = `rgba(${CYAN},0.35)`;
  ctx.fillRect(left, u * 21, right - left, u * 0.5);

  // Colonne gauche : top 3
  const colW = (right - left) * 0.58;
  ctx.textAlign = 'left';
  ctx.font = `700 ${u * 7}px system-ui, sans-serif`;
  ctx.fillStyle = `rgba(${CYAN},0.85)`;
  ctx.fillText('MEILLEURS MINEURS', left, u * 29);
  for (let i = 0; i < 3; i++) {
    const e = d.top[i];
    const y = u * (41.5 + i * 13.5);
    // Badge hexagonal
    const r = u * 5.4;
    const bx = left + r;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k + Math.PI / 6;
      ctx[k ? 'lineTo' : 'moveTo'](bx + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.shadowColor = MEDALS[i];
    ctx.shadowBlur = u * 2.5;
    ctx.fillStyle = MEDALS[i];
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#10121f';
    ctx.textAlign = 'center';
    ctx.font = `800 ${u * 7}px system-ui, sans-serif`;
    ctx.fillText(String(i + 1), bx, y + u * 0.3);
    ctx.textAlign = 'left';
    ctx.shadowColor = e ? e.color : 'transparent';
    ctx.shadowBlur = u * 2;
    ctx.fillStyle = e ? e.color : 'rgba(255,255,255,0.35)';
    const scoreTxt = e ? e.hits.toLocaleString('fr-FR') : '';
    ctx.font = `700 ${u * 10}px ui-monospace, Menlo, monospace`;
    const sw = ctx.measureText(scoreTxt).width;
    ctx.fillText(fitFont(ctx, e ? e.name : '—', (px) => `800 ${px}px system-ui, sans-serif`, u * 11, colW - r * 2 - sw - u * 6), left + r * 2 + u * 3, y);
    if (e) {
      ctx.textAlign = 'right';
      ctx.shadowColor = `rgba(${CYAN},0.7)`;
      ctx.fillStyle = '#eaf9ff';
      ctx.font = `700 ${u * 10}px ui-monospace, Menlo, monospace`;
      ctx.fillText(scoreTxt, left + colW, y);
    }
    ctx.shadowBlur = 0;
  }

  // Colonne droite : anneau de progression du cube
  const cx = left + colW + (right - left - colW) / 2 + u * 2;
  const cy = u * 51;
  const rr = Math.min((right - left - colW) / 2 - u * 4, u * 21);
  ctx.lineWidth = u * 3;
  ctx.strokeStyle = `rgba(${CYAN},0.18)`;
  ctx.beginPath();
  ctx.arc(cx, cy, rr, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowColor = GOLD;
  ctx.shadowBlur = u * 3;
  ctx.strokeStyle = d.finalStone ? '#ff8a5a' : GOLD;
  ctx.beginPath();
  ctx.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + Math.max(0.03, d.progress) * Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  // Graduations
  ctx.strokeStyle = `rgba(${CYAN},0.4)`;
  ctx.lineWidth = u * 0.4;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (rr + u * 2.2), cy + Math.sin(a) * (rr + u * 2.2));
    ctx.lineTo(cx + Math.cos(a) * (rr + u * 3.6), cy + Math.sin(a) * (rr + u * 3.6));
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = GOLD;
  ctx.shadowBlur = u * 2;
  ctx.fillText(fitFont(ctx, fmtPct(d.progress), (px) => `800 ${px}px system-ui, sans-serif`, u * 12, rr * 1.7), cx, cy - u * 4);
  ctx.shadowBlur = 0;
  ctx.fillStyle = `rgba(${CYAN},0.85)`;
  const sub = (px: number) => `700 ${px}px system-ui, sans-serif`;
  ctx.fillText(fitFont(ctx, 'EXCAVÉ', sub, u * 6, rr * 1.6), cx, cy + u * 6);
  ctx.fillText(fitFont(ctx, `COUCHE ${Math.min(d.layer + 1, d.layers)}/${d.layers}`, sub, u * 6, rr * 1.6), cx, cy + u * 12.5);

  // Pied : brigade en tête, puis l'alerte éventuelle sur sa propre ligne (jamais tronquée).
  const alert = holoAlert(d);
  ctx.fillStyle = `rgba(${CYAN},0.35)`;
  ctx.fillRect(left, u * (alert ? 77 : 80), right - left, u * 0.5);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#eaf9ff';
  const brig = d.brigade
    ? `⚑ EN TÊTE : ${d.brigade.name} — ${countLabel(d.brigade.hits, 'coup')} · ${d.brigade.eligible ? 'provisoire' : 'en formation'}`
    : '⚑ AUCUNE BRIGADE EN TÊTE POUR L\'INSTANT';
  ctx.fillText(fitFont(ctx, brig, (px) => `700 ${px}px system-ui, sans-serif`, u * (alert ? 6.6 : 8), right - left), left, u * (alert ? 84 : 89));
  if (alert) {
    const pulse = reducedMotion ? 1 : 0.6 + 0.4 * Math.sin(time / 220);
    ctx.textAlign = 'center';
    ctx.shadowColor = alert.startsWith('◈') ? '#41e0ff' : '#ffb35c';
    ctx.shadowBlur = u * 3;
    ctx.fillStyle = alert.startsWith('◈') ? `rgba(160,240,255,${pulse})` : `rgba(255,190,110,${pulse})`;
    ctx.fillText(fitFont(ctx, alert, (px) => `800 ${px}px system-ui, sans-serif`, u * 6.6, right - left), (left + right) / 2, u * 91.5);
    ctx.shadowBlur = 0;
  }
}
