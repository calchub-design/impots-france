import { CEREMONY_MS, CEREMONY_STEPS, ceremonyPosition, DONATION_AMOUNT_PENDING, type SeasonArchive } from '../../shared/ceremony.js';
import { plural } from './text.js';

/**
 * Cérémonie de fin de saison (DOM au-dessus de la scène, commune aux deux rendus).
 *
 * Elle ne fait que montrer l'archive envoyée par le serveur : la revoir ne change
 * rien à l'état du jeu. Synchronisée sur l'instant de clôture (horloge serveur),
 * elle peut être avancée (« Suivant ») ou passée (« Passer ») à tout moment, et se
 * ferme d'elle-même à la fin : elle ne bloque jamais la navigation (menu, barre du
 * haut et barre d'action restent accessibles).
 */

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, ...children: Node[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  e.append(...children);
  return e;
}

const NUM = (n: number) => n.toLocaleString('fr-FR');
const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

export function endReasonLabel(r: SeasonArchive['endReason']): string {
  return r === 'completed' ? 'cube entièrement miné' : r === 'timeout' ? 'temps écoulé' : 'clôture par l\'organisation';
}

/** Contenu d'un moment de la cérémonie (pur : testable, réutilisé par le Hall). */
export function ceremonyStep(step: (typeof CEREMONY_STEPS)[number]['id'], a: SeasonArchive, brigadeColor: (name: string) => string): { kicker: string; nodes: Node[] } {
  switch (step) {
    case 'silence':
      return {
        kicker: `${a.seasonName} · ${endReasonLabel(a.endReason)}`,
        nodes: [
          h('div', 'cer-title', 'SAISON TERMINÉE — TRANSMISSION EN COURS'),
          h('div', 'cer-sub', 'Le minage est suspendu. Le monolithe se tait.'),
          h('div', 'cer-stats', `${NUM(a.totals.hits)} coups · ${NUM(a.totals.blocksDestroyed)} / ${NUM(a.totals.totalBlocks)} blocs détruits · ${NUM(a.totals.miners)} mineur${a.totals.miners > 1 ? 's' : ''}`),
        ],
      };
    case 'champion':
      if (!a.champion) return { kicker: 'Champion de saison', nodes: [h('div', 'cer-sub', 'Aucun mineur n\'a contribué cette saison : aucun champion n\'est désigné.')] };
      return {
        kicker: 'Champion de saison',
        nodes: [
          h('div', 'cer-name', a.champion.name),
          h('div', 'cer-sub', `Rang final : ${a.champion.rank} · ${NUM(a.champion.hits)} ${plural(a.champion.hits, 'coup')} · ${NUM(a.champion.blocks)} ${plural(a.champion.blocks, 'bloc détruit', 'blocs détruits')}`),
          ...(a.podium.length > 1
            ? [h('div', 'cer-podium', a.podium.slice(1).map((p) => `${p.rank}. ${p.name} (${NUM(p.hits)})`).join(' · '))]
            : []),
        ],
      };
    case 'brigade': {
      if (!a.championBrigade) {
        return {
          kicker: 'Brigade championne',
          nodes: [h('div', 'cer-sub', `Aucune brigade qualifiée : le titre exige au moins ${a.brigadeMinSize} membres et une contribution.`)],
        };
      }
      const em = h('span', 'cer-emblem', a.championBrigade.emblem);
      em.style.setProperty('--bc', brigadeColor(a.championBrigade.name));
      return {
        kicker: 'Brigade championne',
        nodes: [
          em,
          h('div', 'cer-name', a.championBrigade.name),
          h('div', 'cer-sub', `Contribution collective : ${NUM(a.championBrigade.hits)} coups · ${a.championBrigade.members} membre${a.championBrigade.members > 1 ? 's' : ''}`),
        ],
      };
    }
    case 'stone':
      if (a.finalStone) {
        return {
          kicker: 'Pierre finale',
          nodes: [
            h('div', 'cer-glyph', '◆'),
            h('div', 'cer-name', a.finalStone.name),
            h('div', 'cer-sub', 'a détruit le dernier bloc du cube.'),
            h('div', 'cer-note', 'Distinction honorifique, indépendante du championnat.'),
          ],
        };
      }
      return {
        kicker: 'Pierre finale',
        nodes: [
          h('div', 'cer-sub', 'Aucune Pierre finale n\'a été attribuée.'),
          h('div', 'cer-note', a.endReason === 'timeout' ? 'Le temps de la saison a expiré avant la destruction du dernier bloc.' : 'La saison a été clôturée avant la destruction du dernier bloc.'),
        ],
      };
    case 'secrets': {
      const nodes: Node[] = [];
      if (a.discoveriesTotal === 0) nodes.push(h('div', 'cer-sub', 'Aucune découverte n\'était prévue cette saison.'));
      else if (a.discoveries.length === 0) nodes.push(h('div', 'cer-sub', `Aucun fragment n'a été révélé (0 / ${a.discoveriesTotal}).`));
      else {
        nodes.push(h('div', 'cer-sub', `${a.discoveries.length} / ${a.discoveriesTotal} fragments révélés par les mineurs`));
        nodes.push(h('ol', 'cer-frags', undefined, ...a.discoveries.map((f) => h('li', undefined, undefined, h('b', undefined, `${f.code} — ${f.title}`), h('span', undefined, f.text)))));
      }
      nodes.push(h('div', 'cer-transmission', '« Fin de transmission. Le signal se tait… pour l\'instant. »'));
      return { kicker: 'Les secrets du cube', nodes };
    }
    case 'cause': {
      const d = a.donation;
      const assoc = d.associationName
        ? h('div', 'cer-sub', `En l'honneur du champion de la saison, l'éditeur prévoit un don à ${d.associationName}.`)
        : h('div', 'cer-sub', 'Association partenaire à annoncer.');
      const nodes: Node[] = [assoc];
      if (d.associationName && d.associationUrl) {
        nodes.push(h('a', 'cer-link', 'Site de l\'association', ...[]));
        const link = nodes[nodes.length - 1] as HTMLAnchorElement;
        link.href = d.associationUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      nodes.push(h('div', 'cer-amount', d.amountLabel ?? DONATION_AMOUNT_PENDING));
      nodes.push(
        h(
          'div',
          'cer-note',
          'Ce don est fait par l\'éditeur. Ce n\'est ni un gain ni une récompense du champion : il ne le reçoit pas et ne le contrôle pas. Aucune collecte n\'est organisée dans le jeu.',
        ),
      );
      return { kicker: 'La cause de la saison', nodes };
    }
  }
}

export class CeremonyPlayer {
  private timer = 0;
  private index = 0;
  private archive: SeasonArchive | null = null;
  onClose: (archive: SeasonArchive) => void = () => {};

  constructor(
    private readonly root: HTMLElement,
    private readonly reducedMotion: () => boolean,
    private readonly brigadeColor: (name: string) => string,
  ) {
    root.querySelector('#cer-next')!.addEventListener('click', () => this.go(this.index + 1));
    root.querySelector('#cer-skip')!.addEventListener('click', () => this.close());
  }

  get playing() {
    return !this.root.hidden;
  }

  get step(): string | null {
    return this.playing ? CEREMONY_STEPS[this.index].id : null;
  }

  /**
   * Lance la cérémonie. `elapsedMs` : temps écoulé depuis la clôture (synchronisation des
   * joueurs connectés) ; 0 pour la revoir depuis le début. Rien n'est lancé si elle est finie.
   */
  play(archive: SeasonArchive, elapsedMs = 0): boolean {
    const pos = ceremonyPosition(elapsedMs);
    if (!pos) return false;
    this.archive = archive;
    this.root.hidden = false;
    this.root.classList.toggle('still', this.reducedMotion());
    this.root.parentElement?.classList.add('ceremony-on');
    this.root.querySelector('#cer-steps')!.replaceChildren(...CEREMONY_STEPS.map(() => h('span')));
    this.go(pos.index, pos.inStepMs);
    return true;
  }

  private go(index: number, inStepMs = 0) {
    window.clearTimeout(this.timer);
    if (!this.archive) return;
    if (index >= CEREMONY_STEPS.length) return this.close();
    this.index = index;
    const step = CEREMONY_STEPS[index];
    const { kicker, nodes } = ceremonyStep(step.id, this.archive, this.brigadeColor);
    const panel = this.root.querySelector<HTMLElement>('.cer-panel')!;
    panel.dataset.step = step.id;
    // Relance l'animation d'entrée du moment.
    panel.classList.remove('enter');
    void panel.offsetWidth;
    panel.classList.add('enter');
    this.root.dataset.step = step.id;
    this.root.querySelector('#cer-kicker')!.textContent = kicker;
    this.root.querySelector('#cer-body')!.replaceChildren(...nodes);
    this.root.querySelectorAll('#cer-steps span').forEach((s, i) => s.classList.toggle('on', i <= index));
    (this.root.querySelector('#cer-next') as HTMLButtonElement).textContent = index === CEREMONY_STEPS.length - 1 ? 'Terminer' : 'Suivant';
    this.timer = window.setTimeout(() => this.go(index + 1), Math.max(500, step.ms - inStepMs));
  }

  close() {
    window.clearTimeout(this.timer);
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.root.parentElement?.classList.remove('ceremony-on');
    if (this.archive) this.onClose(this.archive);
  }
}

/** Dates d'une saison pour le Hall des champions. */
export function seasonDates(a: SeasonArchive): string {
  return `du ${DATE.format(a.startsAt)} au ${DATE.format(a.endedAt)}`;
}

export { CEREMONY_MS };
