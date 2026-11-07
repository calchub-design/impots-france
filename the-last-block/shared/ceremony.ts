/**
 * Cérémonie de fin de saison et Hall des champions : types publics partagés.
 *
 * L'archive d'une saison est construite UNE fois par le serveur, dans la même
 * transaction que la clôture, à partir des seules données validées (classement
 * archivé, Pierre finale, découvertes révélées). Revoir la cérémonie ne fait
 * que relire cette archive : rien n'est recalculé ni réattribué.
 */

export interface ArchivePlayer {
  name: string;
  /** Rang final (méthode de classement et de départage du serveur). */
  rank: number;
  hits: number;
  blocks: number;
}

export interface SeasonArchive {
  seasonId: number;
  /** Numéro de saison (identifiant croissant). */
  number: number;
  seasonName: string;
  startsAt: number;
  /** Fin officielle (échéance pour une fin par le temps). */
  endedAt: number;
  endReason: 'completed' | 'timeout' | 'admin';
  /** Instant réel de la clôture par le serveur : départ de la cérémonie synchronisée. */
  closedAt: number;
  /** Champion de saison (null : aucune contribution). */
  champion: ArchivePlayer | null;
  /** Podium (au plus trois mineurs). */
  podium: ArchivePlayer[];
  /** Brigade championne (null : aucune brigade qualifiée). */
  championBrigade: { name: string; emblem: string; hits: number; members: number } | null;
  /** Effectif minimal exigé pour le titre de brigade championne. */
  brigadeMinSize: number;
  /** Auteur du dernier bloc (null : cube non terminé). Distinction honorifique, hors championnat. */
  finalStone: { name: string } | null;
  totals: { hits: number; blocksDestroyed: number; totalBlocks: number; miners: number; brigades: number };
  /** Fragments réellement révélés (les verrouillés ne sont ni nommés ni décrits). */
  discoveries: { code: string; title: string; text: string; layer: number; revealedAt: number }[];
  /** Nombre de fragments prévus pour la saison. */
  discoveriesTotal: number;
  /** Distinctions de brigade attribuées : nombres seulement (elles sont privées). */
  brigadeDistinctions: { count: number; brigades: number };
  /** Cause de la saison : don de l'éditeur, jamais une récompense du champion. */
  donation: { associationName: string | null; associationUrl: string | null; note: string; amountLabel: string | null };
}

/** Moments de la cérémonie et durées (ms), communs au serveur et aux navigateurs. */
export const CEREMONY_STEPS = [
  { id: 'silence', ms: 6000 },
  { id: 'champion', ms: 7000 },
  { id: 'brigade', ms: 7000 },
  { id: 'stone', ms: 6000 },
  { id: 'secrets', ms: 8000 },
  { id: 'cause', ms: 7000 },
] as const;

export type CeremonyStep = (typeof CEREMONY_STEPS)[number]['id'];

export const CEREMONY_MS = CEREMONY_STEPS.reduce((s, x) => s + x.ms, 0);

/** Moment en cours et temps écoulé dans ce moment, à partir du temps écoulé depuis la clôture. */
export function ceremonyPosition(elapsedMs: number): { index: number; inStepMs: number } | null {
  if (elapsedMs < 0) return { index: 0, inStepMs: 0 };
  let t = elapsedMs;
  for (let i = 0; i < CEREMONY_STEPS.length; i++) {
    if (t < CEREMONY_STEPS[i].ms) return { index: i, inStepMs: t };
    t -= CEREMONY_STEPS[i].ms;
  }
  return null;
}

/** Texte affiché quand le montant du don n'est pas encore confirmé. */
export const DONATION_AMOUNT_PENDING = 'Montant du don à confirmer';
