import { HINT_LABELS, type DiscoveryFragment, type DiscoveryLog, type HintLevel } from '../../shared/discoveries.js';

/**
 * Interface des découvertes collectives (« Le Signal »), commune aux deux
 * rendus : tout est en DOM, posé au-dessus du canevas. Aucune logique de jeu
 * ici : le client n'affiche que ce que le serveur a confirmé.
 */

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, ...children: Node[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  e.append(...children);
  return e;
}

const DATE_FMT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function fragmentHeading(f: Pick<DiscoveryFragment, 'code' | 'title'>): string {
  return `Fragment ${f.code} — ${f.title ?? '?'}`;
}

/** Archives du cube : fragments révélés (titre, message, couche, date) et symboles verrouillés. */
export function renderArchives(root: HTMLElement, summary: HTMLElement, log: DiscoveryLog | null) {
  if (!log) {
    summary.textContent = 'Aucune saison pour l\'instant.';
    root.replaceChildren();
    return;
  }
  const found = log.fragments.filter((f) => f.revealed).length;
  if (log.invalidProfile) {
    summary.textContent = `${log.seasonName} : aucune découverte cette saison (profil incompatible avec ce cube).`;
  } else if (log.fragments.length === 0) {
    summary.textContent = `${log.seasonName} : aucune découverte n'est prévue pour cette saison.`;
  } else {
    summary.textContent = `${log.seasonName}${log.seasonStatus === 'ended' ? ' (terminée)' : ''} · ${found} / ${log.fragments.length} fragments découverts par l'ensemble des mineurs`;
  }
  root.replaceChildren(
    ...log.fragments.map((f) => {
      if (f.revealed) {
        return h(
          'li',
          'frag revealed',
          undefined,
          h('span', 'frag-glyph', '◈'),
          h(
            'div',
            'frag-body',
            undefined,
            h('div', 'frag-head', fragmentHeading(f)),
            h('p', 'frag-text', f.text ?? ''),
            h('div', 'frag-meta', `Révélé à la couche ${f.layer}${f.revealedAt ? ` · ${DATE_FMT.format(f.revealedAt)}` : ''}`),
          ),
        );
      }
      return h(
        'li',
        'frag locked',
        undefined,
        h('span', 'frag-glyph', '⌬'),
        h(
          'div',
          'frag-body',
          undefined,
          h('div', 'frag-head', `Fragment ${f.code} — signal verrouillé`),
          h('div', 'frag-meta', log.seasonStatus === 'ended' ? 'Non découvert : la saison s\'est achevée avant.' : `Se révélera à la destruction complète de la couche ${f.layer}.`),
        ),
      );
    }),
  );
}

/** Texte de l'indice discret affiché près de la surface. */
export function hintText(level: HintLevel): string {
  return `◈ ${HINT_LABELS[level]}`;
}

/**
 * Annonce d'une découverte : impulsion cyan et violette, symbole, titre qui se
 * déchiffre, message. Non bloquante (seule la carte capte le toucher, loin du
 * bouton Miner) ; sans animation si « réduire les animations » est demandé.
 */
export class RevealOverlay {
  private timer = 0;
  private decode = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly reducedMotion: () => boolean,
    onOpenArchives: () => void,
  ) {
    root.querySelector('#discovery-close')!.addEventListener('click', () => this.hide());
    root.querySelector('#discovery-open')!.addEventListener('click', () => {
      this.hide();
      onOpenArchives();
    });
  }

  get visible() {
    return !this.root.hidden;
  }

  show(f: DiscoveryFragment, kicker = 'Nouveau fragment découvert') {
    const title = this.root.querySelector<HTMLElement>('#discovery-title')!;
    this.root.querySelector('#discovery-kicker')!.textContent = `${kicker} · ${f.code}`;
    this.root.querySelector('#discovery-text')!.textContent = f.text ?? '';
    this.root.querySelector('#discovery-meta')!.textContent = `Couche ${f.layer} entièrement détruite par les mineurs`;
    const full = (f.title ?? '').toUpperCase();
    window.clearTimeout(this.timer);
    window.clearInterval(this.decode);
    // Redémarre les animations CSS.
    this.root.hidden = true;
    void this.root.offsetWidth;
    this.root.hidden = false;
    this.root.classList.toggle('still', this.reducedMotion());
    if (this.reducedMotion()) {
      title.textContent = full;
    } else {
      // Titre « déchiffré » : symboles qui se résolvent en lettres, de gauche à droite.
      const glyphs = '◇◈⌬⟁△▽○◎◬';
      const start = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - start) / 900);
        const n = Math.floor(k * full.length);
        let s = full.slice(0, n);
        for (let i = n; i < full.length; i++) s += full[i] === ' ' ? ' ' : glyphs[(i * 7 + Math.floor(performance.now() / 60)) % glyphs.length];
        title.textContent = s;
        if (k >= 1) window.clearInterval(this.decode);
      };
      step();
      this.decode = window.setInterval(step, 50);
    }
    this.timer = window.setTimeout(() => this.hide(), 11_000);
  }

  hide() {
    window.clearTimeout(this.timer);
    window.clearInterval(this.decode);
    this.root.hidden = true;
  }
}

/**
 * Fragments déjà annoncés à ce navigateur (par saison), pour annoncer à la
 * reconnexion un fragment révélé pendant l'absence, une seule fois.
 */
export class SeenFragments {
  constructor(
    private readonly get: (k: string) => string | null,
    private readonly set: (k: string, v: string) => void,
  ) {}

  private read(): { season: number; ids: string[] } | null {
    try {
      const v = JSON.parse(this.get('tlb.signal.seen') ?? 'null') as { season: number; ids: string[] } | null;
      return v && typeof v.season === 'number' && Array.isArray(v.ids) ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * Fragments révélés que ce navigateur n'a pas encore annoncés. Première visite
   * de la saison : rien n'est rejoué (tout est dans les archives).
   */
  unseen(log: DiscoveryLog): DiscoveryFragment[] {
    const seen = this.read();
    const revealed = log.fragments.filter((f) => f.revealed);
    if (!seen || seen.season !== log.seasonId) return [];
    return revealed.filter((f) => !seen.ids.includes(f.id));
  }

  markAll(log: DiscoveryLog) {
    this.set('tlb.signal.seen', JSON.stringify({ season: log.seasonId, ids: log.fragments.filter((f) => f.revealed).map((f) => f.id) }));
  }
}
