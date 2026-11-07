/**
 * Interface de persistance. Le moteur ne dépend que de cette interface :
 * l'implémentation SQLite (`sqlite.ts`) peut être remplacée par une
 * implémentation PostgreSQL (voir docs/ARCHITECTURE.md).
 *
 * Point clé pour la concurrence : `damageBlock` est une mise à jour
 * conditionnelle (`... WHERE hp > 0 RETURNING hp`). C'est la base de données
 * qui garantit qu'un bloc détruit ne peut plus être frappé, pas la mémoire.
 */

export interface PlayerRow {
  id: string;
  name: string;
  token_hash: string | null;
  skin: string;
  auth_provider: string;
  created_at: number;
  last_action_at: number | null;
  presence_hidden: number;
}

export interface SeasonRow {
  id: number;
  name: string;
  status: 'active' | 'ended';
  cube_size: number;
  base_hp: number;
  hp_per_layer: number;
  starts_at: number;
  ends_at: number;
  ended_at: number | null;
  end_reason: 'completed' | 'timeout' | 'admin' | null;
  champion_player_id: string | null;
  champion_brigade_id: string | null;
  final_stone_player_id: string | null;
  /** Profil de découvertes ; NULL pour une saison créée avant les découvertes. */
  discovery_profile?: string | null;
  /** Profil incompatible avec ce cube : raison (aucune découverte cette saison). */
  discovery_error?: string | null;
}

export interface DiscoveryRow {
  season_id: number;
  fragment_id: string;
  ord: number;
  code: string;
  title: string;
  body: string;
  /** Couche déclencheuse (0 = sommet). */
  layer: number;
  revealed_at: number | null;
  /** Journal technique : auteur du dernier bloc de la couche (aucun avantage). */
  closing_player_id: string | null;
}

export interface HitRow {
  id: number;
  season_id: number;
  player_id: string;
  action_id: string;
  layer: number;
  idx: number;
  hp_after: number;
  destroyed: number;
  brigade_id: string | null;
  at: number;
}

export interface ContributionRow {
  player_id: string;
  hits: number;
  blocks: number;
  last_hit_at: number;
}

export interface BrigadeRow {
  id: string;
  name: string;
  invite_code: string;
  owner_id: string;
  created_at: number;
}

export interface BrigadeContributionRow {
  brigade_id: string;
  hits: number;
  blocks: number;
  last_hit_at: number;
}

export interface SeasonResultRow {
  season_id: number;
  kind: 'player' | 'brigade';
  rank: number;
  entity_id: string;
  name: string;
  score: number;
}

export interface GameStore {
  transaction<T>(fn: () => T): T;
  close(): void;

  // Joueurs
  createPlayer(p: { id: string; name: string; nameKey: string; tokenHash: string | null; skin: string; authProvider: string; createdAt: number }): void;
  getPlayer(id: string): PlayerRow | undefined;
  countPlayers(): number;
  getPlayerByTokenHash(hash: string): PlayerRow | undefined;
  /** Joueur portant ce pseudo normalisé (unicité anti-usurpation). */
  getPlayerByNameKey(key: string): PlayerRow | undefined;
  setPlayerName(id: string, name: string, nameKey: string): void;
  /** Remplace (rotation) ou supprime (null = révocation) l'empreinte du jeton. */
  setTokenHash(id: string, hash: string | null): void;
  setPlayerSkin(id: string, skin: string): void;
  setPresenceHidden(id: string, hidden: boolean): void;
  setLastActionAt(id: string, at: number): void;

  // Saisons
  getActiveSeason(): SeasonRow | undefined;
  getSeason(id: number): SeasonRow | undefined;
  listSeasons(limit: number): SeasonRow[];
  getLastEndedSeason(): SeasonRow | undefined;
  createSeason(s: { name: string; cubeSize: number; baseHp: number; hpPerLayer: number; startsAt: number; endsAt: number }): SeasonRow;
  endSeason(id: number, f: { endedAt: number; reason: 'completed' | 'timeout' | 'admin'; championPlayerId: string | null; championBrigadeId: string | null; finalStonePlayerId: string | null }): void;

  // Blocs
  loadBlockHp(seasonId: number): { layer: number; idx: number; hp: number }[];
  /** Retire 1 PV si le bloc est intact ; renvoie les PV restants ou undefined si déjà détruit/inexistant. */
  damageBlock(seasonId: number, layer: number, idx: number, playerId: string, at: number): number | undefined;

  // Journal des coups
  findHit(playerId: string, actionId: string): HitRow | undefined;
  insertHit(h: Omit<HitRow, 'id'>): void;
  countHits(seasonId: number): number;
  /** Dernier coup destructeur d'une saison (récupération de la Pierre finale après crash). */
  lastDestroyingHit(seasonId: number): HitRow | undefined;

  // Contributions
  addContribution(seasonId: number, playerId: string, destroyed: boolean, at: number): void;
  addBrigadeContribution(seasonId: number, brigadeId: string, destroyed: boolean, at: number): void;
  loadContributions(seasonId: number): ContributionRow[];
  loadBrigadeContributions(seasonId: number): BrigadeContributionRow[];

  // Temps de jeu actif
  getPlaytime(playerId: string, day: string): number;
  setPlaytime(playerId: string, day: string, activeMs: number): void;

  // Brigades
  createBrigade(b: BrigadeRow): void;
  deleteBrigade(id: string): void;
  getBrigade(id: string): BrigadeRow | undefined;
  getBrigadeByCode(code: string): BrigadeRow | undefined;
  getBrigadeByName(name: string): BrigadeRow | undefined;
  setBrigadeOwner(id: string, ownerId: string): void;
  getMembership(playerId: string): string | undefined;
  addMember(brigadeId: string, playerId: string, at: number): void;
  removeMember(playerId: string): void;
  listMembers(brigadeId: string): { id: string; name: string; joined_at: number }[];
  listBrigades(): (BrigadeRow & { members: number })[];

  // Archives
  // Missions quotidiennes
  getDailyMissions(seasonId: number, playerId: string, day: string): { hits: number; blocks: string; layers: string; layers_done: number } | undefined;
  saveDailyMissions(seasonId: number, playerId: string, day: string, hits: number, blocks: string, layers: string, layersDone: number): void;
  listMissionCompletions(seasonId: number, playerId: string, day: string): { mission_id: string; completed_at: number }[];
  /** Vrai si la mission vient d'être enregistrée (faux si elle l'était déjà ce jour-là). */
  insertMissionCompletion(seasonId: number, playerId: string, day: string, missionId: string, at: number): boolean;
  countMissionCompletions(seasonId: number, playerId: string): number;
  listSeasonMissionCompletions(seasonId: number, playerId: string, limit: number): { day: string; mission_id: string }[];
  addDailyLayerHit(seasonId: number, day: string, layer: number, playerId: string): void;
  dailyLayerPlayers(seasonId: number, day: string, layer: number): string[];
  addUnlock(playerId: string, unlockId: string, at: number): boolean;
  listUnlocks(playerId: string): string[];

  // Découvertes collectives
  setSeasonDiscoveries(seasonId: number, profile: string, error: string | null, rows: Omit<DiscoveryRow, 'season_id' | 'revealed_at' | 'closing_player_id'>[]): void;
  listDiscoveries(seasonId: number): DiscoveryRow[];
  /** Révèle le fragment de la couche si elle est entièrement détruite et qu'il ne l'est pas déjà. */
  revealDiscovery(seasonId: number, layer: number, at: number, playerId: string): DiscoveryRow | undefined;
  /** Réconciliation idempotente : révèle les fragments des couches déjà entièrement détruites. */
  reconcileDiscoveries(seasonId: number): DiscoveryRow[];

  insertSeasonResults(rows: SeasonResultRow[]): void;
  getSeasonResults(seasonId: number): SeasonResultRow[];
}
