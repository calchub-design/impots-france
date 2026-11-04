/**
 * Calcul du temps de jeu ACTIF (limite quotidienne, 4 h par défaut).
 *
 * Modèle : chaque coup accepté au temps t rend le joueur actif sur la
 * fenêtre [t, t + W] (W = `idleGapMs`, 5 s par défaut). Le temps actif est la
 * durée de la RÉUNION de ces fenêtres. Concrètement, un coup crédite
 * `min(t - dernierCoup, W)` (W pour le premier coup).
 *
 * Propriétés (testées dans tests/limits.test.ts) :
 *  - jeu continu : le temps crédité suit le temps réel ;
 *  - une pause de durée P ne compte que min(P, W) : l'inactivité n'est pas
 *    comptée au-delà de W ;
 *  - aucun coup n'est « gratuit » : espacer ses coups (ex. un toutes les 21 s)
 *    coûte W par coup. Avec W ≥ 1 s et au plus N coups par seconde, le nombre
 *    de coups par jour est borné par N × (limite en secondes) + N, quel que
 *    soit le rythme adopté (≈ 72 000 coups pour 4 h à 5 coups/s).
 *
 * Le crédit est imputé au jour UTC du coup ; il est plafonné à la durée
 * écoulée depuis minuit, de sorte qu'un nouveau jour démarre toujours à 0.
 */

const DAY_MS = 24 * 3600_000;

export function dayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function dayKey(ms: number): string {
  return new Date(dayStart(ms)).toISOString().slice(0, 10);
}

export function nextDayStart(ms: number): number {
  return dayStart(ms) + DAY_MS;
}

/** Temps actif (ms) à créditer pour un coup accepté au temps `now`. */
export function activeCredit(lastActionAt: number | null, now: number, windowMs: number): number {
  const sinceMidnight = now - dayStart(now);
  if (lastActionAt === null) return Math.min(windowMs, sinceMidnight);
  const gap = now - lastActionAt;
  if (gap <= 0) return 0;
  return Math.min(gap, windowMs, sinceMidnight);
}
