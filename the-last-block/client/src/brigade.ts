import type { BrigadeObjectivesInfo } from '../../shared/brigades.js';
import { plural } from './text.js';

/**
 * Identité, objectifs et distinctions de brigade (DOM, commun aux deux rendus).
 * Affiche uniquement l'état envoyé par le serveur.
 */

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, ...children: Node[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  e.append(...children);
  return e;
}

const NUM = (n: number) => n.toLocaleString('fr-FR');
const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const TIER = ['I', 'II', 'III', 'IV', 'V'];

export interface BrigadeDom {
  emblem: HTMLElement;
  title: HTMLElement;
  totals: HTMLElement;
  objectives: HTMLElement;
  distinctions: HTMLElement;
  former: HTMLElement;
}

/** Remplissage d'une jauge à segments égaux : paliers franchis + fraction du palier en cours. */
export function segmentedFill(tiers: number[], value: number): number {
  const n = tiers.length;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    if (value < tiers[i]) return (i + (value - prev) / (tiers[i] - prev)) / n;
    prev = tiers[i];
  }
  return 1;
}

export function renderBrigadeObjectives(dom: BrigadeDom, o: BrigadeObjectivesInfo | undefined, color: string) {
  if (!o) {
    for (const el of Object.values(dom)) el.replaceChildren();
    return;
  }
  dom.emblem.textContent = o.emblem;
  dom.emblem.className = `brigade-emblem frame-${o.frame}`;
  dom.emblem.style.setProperty('--bc', color);
  dom.title.textContent = o.title ?? 'Aucun titre pour l\'instant';
  dom.totals.textContent = `Contribution collective : ${NUM(o.totals.hits)} ${plural(o.totals.hits, 'coup')} · ${NUM(o.totals.blocks)} ${plural(o.totals.blocks, 'bloc détruit', 'blocs détruits')} cette saison`;
  if (!o.objectives.length) {
    dom.objectives.replaceChildren(h('li', 'muted', 'Pas d\'objectif pendant l\'intersaison.'));
  } else {
    dom.objectives.replaceChildren(
      ...o.objectives.map((ob) => {
        const max = ob.tiers[ob.tiers.length - 1];
        const bar = h('div', 'bobj-bar');
        const fill = h('div', 'bobj-fill');
        fill.style.width = `${segmentedFill(ob.tiers, ob.value) * 100}%`;
        bar.append(fill);
        // Jauge par paliers : un segment de même largeur par palier (lisible même si les seuils croissent vite).
        ob.tiers.forEach((_, i) => {
          const tick = h('span', `bobj-tick${i < ob.reached ? ' reached' : ''}`, TIER[i]);
          tick.style.left = `${((i + 1) / ob.tiers.length) * 100}%`;
          bar.append(tick);
        });
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-label', ob.title);
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', String(max));
        bar.setAttribute('aria-valuenow', String(ob.value));
        const next = ob.tiers[ob.reached];
        const status = next === undefined ? 'Tous les paliers atteints' : `${NUM(ob.value)} / ${NUM(next)} pour le palier ${TIER[ob.reached]}`;
        const parts: Node[] = [
          h('div', 'bobj-head', undefined, h('span', 'bobj-title', ob.title), h('span', 'bobj-count', status)),
          h('div', 'bobj-desc', ob.description),
          bar,
        ];
        if (ob.minHits) {
          // Contributeurs qui comptent (au moins minHits coups pour la brigade).
          const who = o.contributors.filter((c) => c.hits >= ob.minHits!);
          parts.push(h('div', 'bobj-who', who.length ? `Comptent : ${who.map((c) => c.name + (c.member ? '' : ' (parti)')).join(', ')}` : 'Personne n\'a encore atteint le minimum.'));
        }
        return h('li', `bobj${ob.reached === ob.tiers.length ? ' complete' : ''}`, undefined, ...parts);
      }),
    );
  }
  dom.distinctions.replaceChildren(
    ...(o.distinctions.length
      ? o.distinctions.map((d) => h('li', undefined, undefined, h('span', 'dist-glyph', '◈'), h('span', 'dist-label', d.label), h('span', 'dist-meta', `${d.seasonName} · ${DATE.format(d.unlockedAt)}`)))
      : [h('li', 'muted', 'Aucune distinction pour l\'instant.')]),
  );
  const former = o.contributors.filter((c) => !c.member && c.hits > 0);
  dom.former.textContent = former.length
    ? `Anciens membres (contributions acquises à la brigade) : ${former.map((c) => `${c.name} ${NUM(c.hits)}`).join(', ')}`
    : '';
}
