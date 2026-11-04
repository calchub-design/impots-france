/**
 * Limiteur à fenêtre glissante exacte : au plus `max` actions sur toute
 * fenêtre de `windowMs` millisecondes, par clé (ici : par compte joueur,
 * toutes connexions confondues).
 */
export class SlidingWindowLimiter {
  private readonly log = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  /** Consomme un jeton si possible. Renvoie 0 si accepté, sinon le délai d'attente (ms). */
  tryTake(key: string, now: number): number {
    let times = this.log.get(key);
    if (!times) {
      times = [];
      this.log.set(key, times);
    }
    const threshold = now - this.windowMs;
    while (times.length > 0 && times[0] <= threshold) times.shift();
    if (times.length >= this.max) {
      return Math.max(1, times[0] + this.windowMs - now);
    }
    times.push(now);
    return 0;
  }

  /** Vrai si la clé a atteint sa limite (sans consommer de jeton). */
  isBlocked(key: string, now: number): boolean {
    const times = this.log.get(key);
    if (!times) return false;
    const threshold = now - this.windowMs;
    while (times.length > 0 && times[0] <= threshold) times.shift();
    return times.length >= this.max;
  }

  /** Libère la mémoire des clés inactives. */
  prune(now: number): void {
    const threshold = now - this.windowMs;
    for (const [key, times] of this.log) {
      if (times.length === 0 || times[times.length - 1] <= threshold) this.log.delete(key);
    }
  }

  size(): number {
    return this.log.size;
  }
}
