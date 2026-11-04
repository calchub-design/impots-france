/**
 * Protocole WebSocket partagé entre le serveur et le client.
 * Tous les messages sont des objets JSON avec un champ discriminant `t`.
 * Le serveur est autoritaire : le client n'envoie que des intentions.
 */

export const PROTOCOL_VERSION = 1;

/** Identifiant d'action client : 8 à 64 caractères URL-safe. */
export const ACTION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type MineRejectReason =
  | 'invalid_action'
  | 'no_active_season'
  | 'out_of_bounds'
  | 'already_destroyed'
  | 'layer_locked'
  | 'rate_limited'
  | 'daily_limit';

export interface PublicPlayer {
  id: string;
  name: string;
  skin: string;
}

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  name: string;
  skin: string;
  hits: number;
  blocks: number;
  brigadeName: string | null;
}

export interface BrigadeBoardEntry {
  rank: number;
  brigadeId: string;
  name: string;
  members: number;
  eligible: boolean;
  hits: number;
}

export interface SeasonInfo {
  id: number;
  name: string;
  status: 'active' | 'ended';
  cubeSize: number;
  startsAt: number;
  endsAt: number;
  endedAt: number | null;
  endReason: 'completed' | 'timeout' | 'admin' | null;
  championName: string | null;
  championBrigadeName: string | null;
  finalStoneName: string | null;
  /** Avance (ms) sur l'échéance si le cube a été terminé avant la date de fin. */
  completedEarlyMs: number | null;
}

/**
 * Présence observée : dernier bloc frappé par un joueur au cours des
 * `PRESENCE_WINDOW_MS` dernières millisecondes. Dérivée des coups réels
 * (aucune position de caméra n'est transmise), gardée en mémoire seulement.
 */
export interface PresenceEntry {
  playerId: string;
  name: string;
  skin: string;
  brigadeName: string | null;
  /** Index du bloc dans la couche courante. */
  block: number;
  /** Âge de l'observation au moment de l'envoi (ms). */
  ageMs: number;
}

export const PRESENCE_WINDOW_MS = 20_000;

/** Avancement de la saison active et estimation de la fin du cube. */
export interface SeasonProjection {
  totalHits: number;
  hitsDone: number;
  remainingHits: number;
  avgHitsPerHour: number;
  /** Rythme sur la dernière heure, indicatif (en mémoire : repart de zéro au redémarrage). */
  recentHitsPerHour: number;
  projectedCompletionAt: number | null;
  endsAt: number;
  completesBeforeEnd: boolean;
}

export interface CubeSnapshot {
  size: number;
  /** Couche actuellement minable (0 = sommet). `size` si le cube est entièrement miné. */
  currentLayer: number;
  /** Blocs restants par couche. */
  layerRemaining: number[];
  /** PV maximum des blocs de chaque couche. */
  layerMaxHp: number[];
  /** PV de chaque bloc de la couche courante (index = y * size + x). */
  currentHp: number[];
  totalBlocks: number;
  destroyedBlocks: number;
}

export interface PlaytimeInfo {
  usedMs: number;
  limitMs: number;
  /** Début du prochain jour (ms epoch) où le compteur repart à zéro. */
  resetsAt: number;
}

export interface BrigadeInfo {
  id: string;
  name: string;
  inviteCode: string;
  ownerId: string;
  members: { id: string; name: string; hits: number }[];
  minSize: number;
  maxSize: number;
}

export interface MyStats {
  hits: number;
  blocks: number;
  rank: number | null;
}

// ---------------------------------------------------------------------------
// Client -> Serveur
// ---------------------------------------------------------------------------

export type ClientMessage =
  | {
      t: 'hello';
      v: number;
      /** Jeton invité précédemment remis par le serveur (reprise de session). */
      token?: string;
      name?: string;
      /** Connexion via un fournisseur externe (non configuré dans le prototype). */
      auth?: { provider: 'google' | 'apple'; idToken: string };
    }
  | { t: 'mine'; actionId: string; layer: number; block: number }
  | { t: 'setName'; name: string }
  | { t: 'setSkin'; skin: string }
  /** Masquer ou afficher ma position (présence) aux autres joueurs. */
  | { t: 'setPresence'; visible: boolean }
  | { t: 'brigadeCreate'; name: string }
  | { t: 'brigadeJoin'; code: string }
  | { t: 'brigadeLeave' }
  /** Nouveau jeton ; toutes les autres sessions du compte sont fermées. */
  | { t: 'rotateToken' }
  /** Révoque le jeton (compte invité abandonné) et ferme toutes les sessions. */
  | { t: 'logout' }
  | { t: 'ping'; ts: number };

// ---------------------------------------------------------------------------
// Serveur -> Client
// ---------------------------------------------------------------------------

export interface WelcomeMessage {
  t: 'welcome';
  v: number;
  /** Présent uniquement lors de la création d'un compte invité. */
  token?: string;
  player: PublicPlayer;
  season: SeasonInfo | null;
  nextSeasonAt: number | null;
  cube: CubeSnapshot | null;
  seq: number;
  leaderboard: LeaderboardEntry[];
  brigades: BrigadeBoardEntry[];
  me: MyStats;
  playtime: PlaytimeInfo;
  brigade: BrigadeInfo | null;
  online: number;
  serverTime: number;
  projection: SeasonProjection | null;
  presence: PresenceEntry[];
  /** Ma position est-elle partagée avec les autres joueurs ? */
  presenceVisible: boolean;
}

export interface MineResultMessage {
  t: 'mineResult';
  actionId: string;
  ok: boolean;
  reason?: MineRejectReason;
  /** Vrai si l'action avait déjà été traitée (renvoi après reconnexion). */
  duplicate?: boolean;
  layer?: number;
  block?: number;
  hpAfter?: number;
  destroyed?: boolean;
  retryAfterMs?: number;
  me?: MyStats;
  playtime?: PlaytimeInfo;
}

/** [couche, bloc, pvRestants] */
export type BlockDelta = [number, number, number];

export interface DeltaMessage {
  t: 'delta';
  seq: number;
  seasonId: number;
  updates: BlockDelta[];
}

export interface LayerMessage {
  t: 'layer';
  seq: number;
  seasonId: number;
  cube: CubeSnapshot;
}

export type ServerMessage =
  | WelcomeMessage
  | MineResultMessage
  | DeltaMessage
  | LayerMessage
  | {
      t: 'leaderboard';
      leaderboard: LeaderboardEntry[];
      brigades: BrigadeBoardEntry[];
      online: number;
      destroyedBlocks: number;
      projection: SeasonProjection | null;
      presence: PresenceEntry[];
    }
  | { t: 'token'; token: string }
  | { t: 'seasonEnded'; season: SeasonInfo; nextSeasonAt: number | null }
  | { t: 'seasonStarted' }
  | { t: 'profile'; player: PublicPlayer; presenceVisible?: boolean }
  | { t: 'brigade'; brigade: BrigadeInfo | null }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong'; ts: number; serverTime: number };

/** Codes de fermeture WebSocket applicatifs. */
export const CLOSE_CODES = {
  /** Trop de sessions simultanées : la plus ancienne est fermée. Pas de reconnexion automatique. */
  replaced: 4001,
  /** Jeton remplacé (rotation) : se reconnecter avec le jeton à jour. */
  rotated: 4002,
  /** Jeton invalide ou révoqué. */
  invalidToken: 4003,
  helloTimeout: 4000,
} as const;

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}
