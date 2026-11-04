/**
 * Calibrage d'une saison : combien de coups faut-il pour finir le cube, et
 * quels paramètres de résistance choisir pour qu'une saison dure ~N jours ?
 *
 * Résistance d'un bloc de la couche l (0 = sommet) : base + l × parCouche.
 * Total de coups = taille² × Σ_l (base + l × parCouche)
 *               = taille² × (taille × base + parCouche × taille × (taille − 1) / 2).
 */

export function totalHits(size: number, baseHp: number, hpPerLayer: number): number {
  return size * size * (size * baseHp + (hpPerLayer * size * (size - 1)) / 2);
}

export interface CalibrationInput {
  /** Durée visée de la saison (jours). */
  days: number;
  /** Joueurs actifs par jour (estimation). */
  dailyActivePlayers: number;
  /** Minutes de minage ACTIF par joueur et par jour (≤ limite quotidienne). */
  activeMinutesPerPlayer: number;
  /** Coups par seconde effectifs pendant le jeu actif (max 5 ; ~3 pour un humain). */
  hitsPerSecond?: number;
  /** Taille du cube (arête). */
  cubeSize?: number;
  /** Rapport de dureté entre la couche la plus profonde et la surface. */
  depthRatio?: number;
  /**
   * Fraction de la saison à laquelle le cube devrait être terminé au rythme
   * estimé (0,9 = fin attendue vers le 27e jour sur 30). Une valeur < 1 laisse
   * une marge pour que la Pierre finale soit effectivement attribuée.
   */
  targetFraction?: number;
}

export interface CalibrationResult {
  cubeSize: number;
  baseHp: number;
  hpPerLayer: number;
  totalHits: number;
  hitsPerDay: number;
  expectedDays: number;
  seasonDurationHours: number;
  surfaceHitsPerBlock: number;
  deepestHitsPerBlock: number;
  warnings: string[];
}

export function calibrate(input: CalibrationInput): CalibrationResult {
  const hps = input.hitsPerSecond ?? 3;
  const ratio = input.depthRatio ?? 3;
  const fraction = input.targetFraction ?? 0.9;
  const warnings: string[] = [];
  if (!(input.days > 0) || !(input.dailyActivePlayers > 0) || !(input.activeMinutesPerPlayer > 0)) {
    throw new Error('days, dailyActivePlayers et activeMinutesPerPlayer doivent être > 0');
  }
  if (input.activeMinutesPerPlayer > 240) warnings.push('Plus de 240 min/jour : impossible avec la limite de 4 h.');
  if (hps > 5) warnings.push('Plus de 5 coups/s : impossible avec la limite serveur.');
  if (ratio < 1) throw new Error('depthRatio doit être ≥ 1');

  const hitsPerDay = input.dailyActivePlayers * Math.min(input.activeMinutesPerPlayer, 240) * 60 * Math.min(hps, 5);
  const target = hitsPerDay * input.days * fraction;

  let size = input.cubeSize ?? 32;
  // base = 2T / (taille³ × (ratio + 1)) ; on réduit la taille si la base tombe sous 1.
  let base = (2 * target) / (size ** 3 * (ratio + 1));
  while (base < 1 && size > 2 && input.cubeSize === undefined) {
    size--;
    base = (2 * target) / (size ** 3 * (ratio + 1));
  }
  const hpPerLayer = size > 1 ? Math.max(0, Math.round(((ratio - 1) * Math.max(1, base)) / (size - 1))) : 0;
  // Après arrondi de la progression, on réajuste la base pour viser le total.
  const baseHp = Math.max(1, Math.round((target / (size * size) - (hpPerLayer * size * (size - 1)) / 2) / size));
  const total = totalHits(size, baseHp, hpPerLayer);
  const expectedDays = total / hitsPerDay;
  if (base < 1) warnings.push('Cube trop grand pour l\'activité prévue : il sera terminé bien avant l\'échéance.');
  if (Math.abs(expectedDays - input.days * fraction) / (input.days * fraction) > 0.15) {
    warnings.push(`Arrondis importants : durée attendue ${expectedDays.toFixed(1)} j.`);
  }
  if (size > 24) warnings.push('Au-delà de 24 blocs d\'arête, les blocs sont petits sur mobile (le bouton Miner cible automatiquement).');
  return {
    cubeSize: size,
    baseHp,
    hpPerLayer,
    totalHits: total,
    hitsPerDay,
    expectedDays,
    seasonDurationHours: Math.round(input.days * 24),
    surfaceHitsPerBlock: baseHp,
    deepestHitsPerBlock: baseHp + (size - 1) * hpPerLayer,
    warnings,
  };
}
