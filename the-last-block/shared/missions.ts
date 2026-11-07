/**
 * Missions quotidiennes individuelles : types publics partagés.
 *
 * Les missions sont facultatives et sans effet sur le jeu : elles ne modifient
 * ni les dégâts, ni la cadence, ni le temps de jeu, ni le score du championnat.
 * Leurs récompenses sont honorifiques (rang de saison, visible du seul joueur)
 * et cosmétiques (teinte gratuite).
 */

export interface MissionView {
  id: string;
  title: string;
  description: string;
  target: number;
  /** Progression du jour, plafonnée à `target`. */
  progress: number;
  done: boolean;
  completedAt?: number;
}

export interface MissionHistoryDay {
  /** Jour UTC (AAAA-MM-JJ). */
  day: string;
  /** Missions accomplies ce jour-là (identifiants). */
  missions: string[];
}

export interface MissionsState {
  /** Saison à laquelle se rattachent les missions (null : intersaison, aucune mission). */
  seasonId: number | null;
  /** Jour UTC en cours. */
  day: string;
  /** Prochaine réinitialisation (00 h UTC), en ms. */
  resetsAt: number;
  missions: MissionView[];
  /** Missions accomplies depuis le début de la saison. */
  seasonCompleted: number;
  rank: { title: string; at: number } | null;
  nextRank: { title: string; at: number } | null;
  /** Récompense cosmétique pour une journée complète. */
  reward: { unlock: string; label: string; unlocked: boolean } | null;
  /** Éléments cosmétiques débloqués par ce joueur (ex. « skin:signal »). */
  unlocks: string[];
  /** Historique de la saison (jours les plus récents d'abord), envoyé à la connexion et à chaque mission accomplie. */
  history?: MissionHistoryDay[];
}
