/**
 * Petits utilitaires de texte en français, sans dépendance au DOM (testés par Vitest).
 */

/** Pluriels irréguliers utilisés dans l'interface. */
const IRREGULAR: Record<string, string> = { bloc: 'blocs', joueur: 'joueurs' };

/** Forme du mot pour un nombre : singulier pour 0 et 1 (règle française), pluriel au-delà. */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return Math.abs(n) < 2 ? singular : (pluralForm ?? IRREGULAR[singular] ?? `${singular}s`);
}

/** « 1 coup », « 0 actif », « 1 234 coups » (séparateur de milliers français). */
export function countLabel(n: number, singular: string, pluralForm?: string): string {
  return `${n.toLocaleString('fr-FR')} ${plural(n, singular, pluralForm)}`;
}
