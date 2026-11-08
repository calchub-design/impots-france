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

// ---------------------------------------------------------------------------
// Bêta courte (48 h) : matrice de scénarios d'activité et risque de fin.
// ---------------------------------------------------------------------------

/** Hypothèse d'activité, exprimée par joueur INVITÉ (et non par joueur actif). */
export interface ActivityScenario {
  id: string;
  label: string;
  /** Part des invités qui jouent un jour donné (0-1). */
  activeShare: number;
  /** Minutes de minage actif par joueur présent et par jour (≤ 240). */
  minutesPerDay: number;
  /** Coups par seconde pendant le minage actif (≤ 5). */
  hitsPerSecond: number;
}

/** Hypothèses retenues pour 15 à 20 joueurs (voir docs/BETA-48H.md). */
export const BETA_SCENARIOS: readonly ActivityScenario[] = [
  { id: 'faible', label: 'Faible : la moitié joue 20 min/jour', activeShare: 0.5, minutesPerDay: 20, hitsPerSecond: 2 },
  { id: 'moyenne', label: 'Moyenne : 70 % jouent 45 min/jour', activeShare: 0.7, minutesPerDay: 45, hitsPerSecond: 3 },
  { id: 'forte', label: 'Forte : 90 % jouent 1 h 30/jour', activeShare: 0.9, minutesPerDay: 90, hitsPerSecond: 3.5 },
];

export interface SeasonParams {
  cubeSize: number;
  baseHp: number;
  hpPerLayer: number;
  durationHours: number;
}

export type CompletionRisk = 'trop_tot' | 'dans_la_fenetre' | 'juste' | 'non_termine';

export interface ScenarioOutcome {
  scenario: string;
  invitedPlayers: number;
  hitsPerHour: number;
  /** Heure (depuis le début) à laquelle le cube serait terminé ; null s'il ne l'est pas. */
  finishHour: number | null;
  /** Avancement du cube à l'échéance (plafonné à 100). */
  progressAtEndPct: number;
  risk: CompletionRisk;
}

/** Coups par heure, moyennés sur la journée, pour un nombre d'invités et une hypothèse. */
export function hitsPerHour(invited: number, s: ActivityScenario): number {
  return (invited * s.activeShare * Math.min(s.minutesPerDay, 240) * 60 * Math.min(s.hitsPerSecond, 5)) / 24;
}

/**
 * Seuils : fin avant la moitié de la saison = « trop tôt » (le second jour serait
 * sans cube) ; fin entre 50 et 90 % = dans la fenêtre ; 90-100 % = juste (un
 * léger ralentissement suffit à ne pas finir) ; au-delà = non terminé.
 */
export function evaluateSeason(p: SeasonParams, invited: number, s: ActivityScenario): ScenarioOutcome {
  const total = totalHits(p.cubeSize, p.baseHp, p.hpPerLayer);
  const hph = hitsPerHour(invited, s);
  const finish = hph > 0 ? total / hph : Infinity;
  const ratio = finish / p.durationHours;
  const risk: CompletionRisk = ratio < 0.5 ? 'trop_tot' : ratio <= 0.9 ? 'dans_la_fenetre' : ratio <= 1 ? 'juste' : 'non_termine';
  return {
    scenario: s.id,
    invitedPlayers: invited,
    hitsPerHour: Math.round(hph),
    finishHour: ratio <= 1 ? Math.round(finish * 10) / 10 : null,
    progressAtEndPct: Math.min(100, Math.round((hph * p.durationHours * 1000) / total) / 10),
    risk,
  };
}

/**
 * Paramètres de cube pour qu'un scénario donné termine vers `targetFraction` de la
 * durée (par défaut 75 % : fin vers la 36e heure sur 48, marge des deux côtés).
 * La dureté croît avec la profondeur (rapport 3 entre fond et surface).
 */
export function calibrateShortSeason(opts: { invited: number; scenario: ActivityScenario; cubeSize: number; durationHours?: number; targetFraction?: number }): SeasonParams {
  const durationHours = opts.durationHours ?? 48;
  const r = calibrate({
    days: durationHours / 24,
    dailyActivePlayers: opts.invited * opts.scenario.activeShare,
    activeMinutesPerPlayer: opts.scenario.minutesPerDay,
    hitsPerSecond: opts.scenario.hitsPerSecond,
    cubeSize: opts.cubeSize,
    targetFraction: opts.targetFraction ?? 0.75,
  });
  return { cubeSize: r.cubeSize, baseHp: r.baseHp, hpPerLayer: r.hpPerLayer, durationHours };
}

/**
 * Borne haute théorique : tous les invités minent 4 h par jour UTC à 5 coups/s.
 * Une saison de 48 h qui ne commence pas à minuit UTC chevauche 3 jours UTC,
 * soit jusqu'à 12 h de jeu par joueur.
 */
export function theoreticalMaxHits(invited: number, durationHours = 48, startsAtMidnightUtc = false): number {
  const utcDays = Math.ceil(durationHours / 24) + (startsAtMidnightUtc || durationHours % 24 !== 0 ? 0 : 1);
  const maxPlayHours = Math.min(durationHours, utcDays * 4);
  return invited * maxPlayHours * 3600 * 5;
}
