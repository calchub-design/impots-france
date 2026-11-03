/**
 * Calcul du temps de jeu ACTIF (limite quotidienne, 4 h par défaut).
 *
 * Règle : seul le temps écoulé entre deux coups acceptés consécutifs est
 * compté, et seulement si cet écart est inférieur ou égal à `idleGapMs`.
 * Un écart plus long est considéré comme de l'inactivité et n'est pas compté.
 * Le compteur est remis à zéro à minuit UTC ; un écart qui chevauche minuit
 * n'est crédité que pour sa partie postérieure à minuit.
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

/** Temps actif (ms) à créditer pour un coup au temps `now`. */
export function activeCredit(lastActionAt: number | null, now: number, idleGapMs: number): number {
  if (lastActionAt === null) return 0;
  const gap = now - lastActionAt;
  if (gap <= 0 || gap > idleGapMs) return 0;
  const start = Math.max(lastActionAt, dayStart(now));
  return now - start;
}
