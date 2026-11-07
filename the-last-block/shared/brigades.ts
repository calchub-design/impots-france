/**
 * Identité et objectifs de brigade : types publics partagés.
 *
 * Les objectifs de brigade sont collectifs, saisonniers et sans effet sur le
 * jeu : aucune influence sur les dégâts, la cadence, le temps de jeu, les
 * scores ni le titre de brigade championne. Leurs récompenses sont des
 * distinctions, un titre honorifique et un cadre d'emblème (cosmétiques).
 */

/** Emblèmes possibles ; celui d'une brigade est dérivé de son nom (stable, identique pour tous). */
export const BRIGADE_EMBLEMS = ['◆', '⬡', '✦', '◈', '⟁', '⌬', '◎', '△'] as const;

export function brigadeEmblem(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  return BRIGADE_EMBLEMS[(h >>> 3) % BRIGADE_EMBLEMS.length];
}

export interface BrigadeObjectiveView {
  id: string;
  title: string;
  description: string;
  /** Valeur actuelle (coups, membres qualifiés ou couches explorées). */
  value: number;
  /** Paliers croissants. */
  tiers: number[];
  /** Nombre de paliers atteints (0 à tiers.length). */
  reached: number;
  /** « Tous ensemble » : contribution minimale pour qu'un membre compte. */
  minHits?: number;
}

export interface BrigadeContributor {
  id: string;
  name: string;
  /** Coups donnés POUR cette brigade cette saison (pendant qu'il en était membre). */
  hits: number;
  /** Toujours membre ? (les contributions d'un membre parti restent acquises à la brigade). */
  member: boolean;
}

export interface BrigadeDistinction {
  seasonId: number;
  seasonName: string;
  objectiveId: string;
  /** Ex. « Effort collectif II ». */
  label: string;
  tier: number;
  unlockedAt: number;
}

export interface BrigadeObjectivesInfo {
  emblem: string;
  /** Cadre de l'emblème (0 à 3), selon les paliers atteints cette saison. */
  frame: number;
  /** Titre honorifique de la saison (null tant qu'aucun palier n'est atteint). */
  title: string | null;
  /** Contribution collective de la saison. */
  totals: { hits: number; blocks: number };
  contributors: BrigadeContributor[];
  /** Objectifs de la saison en cours (vide en intersaison). */
  objectives: BrigadeObjectiveView[];
  /** Distinctions débloquées, toutes saisons confondues (les plus récentes d'abord). */
  distinctions: BrigadeDistinction[];
}
