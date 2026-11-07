import type { MissionHistoryDay, MissionsState } from '../../shared/missions.js';

/**
 * Panneau « Missions du jour » (DOM, commun aux deux rendus). Affiche
 * uniquement l'état envoyé par le serveur : aucune progression n'est
 * calculée dans le navigateur.
 */

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, ...children: Node[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  e.append(...children);
  return e;
}

const TIME = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export function missionsDone(s: MissionsState | null): { done: number; total: number } {
  const list = s?.missions ?? [];
  return { done: list.filter((m) => m.done).length, total: list.length };
}

export function resetText(s: MissionsState, now: number): string {
  const ms = Math.max(0, s.resetsAt - now);
  const hh = Math.floor(ms / 3_600_000);
  const mm = Math.floor((ms % 3_600_000) / 60_000);
  return `Nouvelles missions dans ${hh > 0 ? `${hh} h ${String(mm).padStart(2, '0')}` : `${mm} min`} (00 h UTC)`;
}

export function renderMissions(
  root: { list: HTMLElement; reset: HTMLElement; rank: HTMLElement; history: HTMLElement },
  s: MissionsState | null,
  history: MissionHistoryDay[],
  now: number,
) {
  if (!s || s.seasonId === null) {
    root.reset.textContent = '';
    root.list.replaceChildren(h('li', 'mission empty', 'Aucune mission pendant l\'intersaison.'));
    root.rank.replaceChildren();
    root.history.replaceChildren();
    return;
  }
  root.reset.textContent = resetText(s, now);
  root.list.replaceChildren(
    ...s.missions.map((m) => {
      const bar = h('div', 'mission-bar');
      const fill = h('div', 'mission-fill');
      fill.style.width = `${(m.progress / m.target) * 100}%`;
      bar.append(fill);
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', m.title);
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(m.target));
      bar.setAttribute('aria-valuenow', String(m.progress));
      return h(
        'li',
        `mission${m.done ? ' done' : ''}`,
        undefined,
        h('span', 'mission-glyph', m.done ? '◈' : '◇'),
        h(
          'div',
          'mission-body',
          undefined,
          h('div', 'mission-head', undefined, h('span', 'mission-title', m.title), h('span', 'mission-count', m.done ? 'Accomplie' : `${m.progress} / ${m.target}`)),
          h('div', 'mission-desc', m.description),
          bar,
          ...(m.done && m.completedAt ? [h('div', 'mission-meta', `Accomplie à ${TIME.format(m.completedAt)}`)] : []),
        ),
      );
    }),
  );
  const parts: Node[] = [
    h('div', 'rank-title', s.rank ? s.rank.title : 'Aucun rang pour l\'instant'),
    h('div', 'rank-sub', `${s.seasonCompleted} mission${s.seasonCompleted > 1 ? 's' : ''} accomplie${s.seasonCompleted > 1 ? 's' : ''} cette saison${s.nextRank ? ` · prochain rang : ${s.nextRank.title} à ${s.nextRank.at}` : ''}`),
  ];
  if (s.reward) {
    parts.push(h('div', `rank-reward${s.reward.unlocked ? ' unlocked' : ''}`, s.reward.unlocked ? `${s.reward.label} : débloquée (Profil)` : `${s.reward.label} : accomplissez les ${s.missions.length} missions d'une même journée`));
  }
  root.rank.replaceChildren(...parts);
  const titles = new Map(s.missions.map((m) => [m.id, m.title]));
  root.history.replaceChildren(
    ...(history.length
      ? history.slice(0, 14).map((d) =>
          h(
            'li',
            undefined,
            undefined,
            h('span', 'hist-day', DAY.format(Date.parse(`${d.day}T00:00:00Z`))),
            h('span', 'hist-glyphs', s.missions.map((m) => (d.missions.includes(m.id) ? '◈' : '◇')).join(' ')),
            h('span', 'hist-names', d.missions.map((id) => titles.get(id) ?? id).join(', ')),
          ),
        )
      : [h('li', 'muted', 'Aucune mission accomplie pour l\'instant cette saison.')]),
  );
}
