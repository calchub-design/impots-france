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
  | { t: 'brigadeCreate'; name: string }
  | { t: 'brigadeJoin'; code: string }
  | { t: 'brigadeLeave' }
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
    }
  | { t: 'seasonEnded'; season: SeasonInfo; nextSeasonAt: number | null }
  | { t: 'seasonStarted' }
  | { t: 'profile'; player: PublicPlayer }
  | { t: 'brigade'; brigade: BrigadeInfo | null }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong'; ts: number; serverTime: number };

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}
