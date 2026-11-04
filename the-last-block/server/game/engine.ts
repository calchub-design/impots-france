import { randomUUID } from 'node:crypto';
import {
  ACTION_ID_RE,
  type BrigadeBoardEntry,
  type BrigadeInfo,
  type CubeSnapshot,
  type LeaderboardEntry,
  type MineRejectReason,
  type MyStats,
  type PlaytimeInfo,
  type PublicPlayer,
  type PresenceEntry,
  type SeasonInfo,
  type SeasonProjection,
  PRESENCE_WINDOW_MS,
} from '../../shared/protocol.js';
import { DEFAULT_SKIN, isValidSkin } from '../../shared/skins.js';
import type { GameRules } from '../config.js';
import type { GameStore, SeasonResultRow, SeasonRow } from '../db/store.js';
import { generateGuestToken, hashToken, isWellFormedToken } from '../auth/guest.js';
import { activeCredit, dayKey, nextDayStart } from './playtime.js';
import { SlidingWindowLimiter } from './rateLimiter.js';
import {
  GameError,
  cleanBrigadeName,
  cleanPlayerName,
  generateInviteCode,
  guestName,
  nameKey,
  normalizeInviteCode,
} from './validation.js';

export interface MineRequest {
  actionId: unknown;
  layer: unknown;
  block: unknown;
}

export type MineResult =
  | {
      ok: true;
      duplicate: boolean;
      layer: number;
      block: number;
      hpAfter: number;
      destroyed: boolean;
    }
  | { ok: false; reason: MineRejectReason; retryAfterMs?: number };

export type EngineEvent =
  | { type: 'block'; seasonId: number; layer: number; block: number; hp: number; playerId: string }
  | { type: 'layer'; seasonId: number; layer: number }
  | { type: 'seasonEnded'; season: SeasonInfo; nextSeasonAt: number | null }
  | { type: 'seasonStarted'; seasonId: number }
  | { type: 'brigadeChanged'; brigadeId: string; playerIds: string[] }
  | { type: 'profileChanged'; playerId: string };

interface PlayerCache {
  id: string;
  name: string;
  skin: string;
  brigadeId: string | null;
  lastActionAt: number | null;
  playDay: string;
  playMs: number;
  presenceHidden: boolean;
}

interface Contribution {
  hits: number;
  blocks: number;
  lastHitAt: number;
}

interface ActiveState {
  season: SeasonRow;
  totalHp: number;
  remainingHp: number;
  size: number;
  perLayer: number;
  hp: Int32Array;
  layerMaxHp: number[];
  layerRemaining: number[];
  currentLayer: number;
  destroyed: number;
  players: Map<string, Contribution>;
  brigades: Map<string, Contribution>;
}

export interface EngineOptions {
  now?: () => number;
}

const ARCHIVE_TOP = 100;
const BRIGADE_JOIN_FAILURES = 10;
const BRIGADE_JOIN_WINDOW_MS = 10 * 60_000;

class AlreadyDestroyed extends Error {}

/**
 * Moteur de jeu autoritaire. Toutes les mutations sont synchrones et passent
 * par une transaction SQLite : dans un processus Node.js unique, deux coups
 * ne peuvent jamais s'entrelacer. La mise à jour conditionnelle `hp > 0` en
 * base reste la garantie finale contre la double destruction.
 */
export class GameEngine {
  readonly now: () => number;
  private readonly limiter: SlidingWindowLimiter;
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private readonly playerCache = new Map<string, PlayerCache>();
  private state: ActiveState | null = null;
  private nextSeasonAt: number | null = null;
  private brigadeCache: Map<string, { name: string; members: number }> | null = null;
  private sortedPlayers: [string, Contribution][] | null = null;
  private rankDirty = true;
  private rankIndex = new Map<string, number>();
  private sortedAt = 0;
  /** Échecs d'adhésion par joueur : freine la recherche exhaustive de codes. */
  private readonly joinFailures = new SlidingWindowLimiter(BRIGADE_JOIN_FAILURES, BRIGADE_JOIN_WINDOW_MS);
  /** Coups par minute de la saison (fenêtre glissante d'une heure) pour l'estimation de fin. */
  private hitBuckets = new Map<number, number>();
  /** Dernier coup accepté de chaque joueur (présence observée, mémoire seulement). */
  private lastHits = new Map<string, { block: number; layer: number; at: number }>();

  constructor(
    readonly store: GameStore,
    readonly rules: GameRules,
    opts: EngineOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.limiter = new SlidingWindowLimiter(rules.maxActionsPerSecond, rules.rateWindowMs);
    const active = store.getActiveSeason();
    if (active) {
      this.loadSeason(active);
      this.recoverCompletedSeason();
    }
    if (!this.state) {
      // Respecte le délai inter-saison même après un redémarrage.
      const last = store.getLastEndedSeason();
      if (last?.ended_at != null && rules.autoStartSeason) this.nextSeasonAt = last.ended_at + rules.seasonCooldownMs;
    }
  }

  /**
   * Récupération après arrêt brutal : si le dernier bloc a été détruit (coup
   * validé en base) mais que la clôture n'a pas eu lieu, on clôture la saison
   * avec la Pierre finale retrouvée dans le journal des coups.
   */
  private recoverCompletedSeason() {
    const st = this.state;
    if (!st || st.currentLayer < st.size) return;
    const last = this.store.lastDestroyingHit(st.season.id);
    this.endSeason('completed', last?.player_id ?? null, last?.at);
  }

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: EngineEvent) {
    for (const l of this.listeners) l(e);
  }

  // =========================================================================
  // Joueurs
  // =========================================================================

  /**
   * Reprise d'un compte invité. L'identité est déterminée UNIQUEMENT par le
   * jeton secret (comparé via son empreinte SHA-256) ; aucun identifiant
   * fourni par le client n'est jamais utilisé. Renvoie null si le jeton est
   * absent, mal formé, inconnu ou révoqué.
   */
  resumeGuest(token: unknown): PublicPlayer | null {
    if (!isWellFormedToken(token)) return null;
    const row = this.store.getPlayerByTokenHash(hashToken(token));
    return row ? this.publicPlayer(row.id) : null;
  }

  /** Crée un compte invité et renvoie son jeton (remis une seule fois). */
  createGuest(requestedName?: unknown): { player: PublicPlayer; token: string } {
    let name: string | null = null;
    if (requestedName !== undefined) {
      try {
        const n = cleanPlayerName(requestedName);
        if (!this.store.getPlayerByNameKey(nameKey(n))) name = n;
      } catch {
        name = null;
      }
    }
    for (let attempt = 0; name === null; attempt++) {
      const n = guestName(attempt);
      if (!this.store.getPlayerByNameKey(nameKey(n))) name = n;
      if (attempt > 50) throw new GameError('name_exhausted', 'Impossible de générer un pseudo.');
    }
    const token = generateGuestToken();
    const id = randomUUID();
    this.store.createPlayer({ id, name, nameKey: nameKey(name), tokenHash: hashToken(token), skin: DEFAULT_SKIN, authProvider: 'guest', createdAt: this.now() });
    return { player: this.publicPlayer(id), token };
  }

  /** Compatibilité (tests, robots) : reprise si possible, sinon création. */
  connectGuest(token: unknown, requestedName?: unknown): { player: PublicPlayer; token?: string } {
    const resumed = this.resumeGuest(token);
    return resumed ? { player: resumed } : this.createGuest(requestedName);
  }

  /** Rotation : nouveau jeton, l'ancien devient immédiatement invalide. */
  rotateToken(playerId: string): string {
    this.player(playerId);
    const token = generateGuestToken();
    this.store.setTokenHash(playerId, hashToken(token));
    return token;
  }

  /** Révocation : plus aucun jeton ne donne accès à ce compte invité. */
  revokeToken(playerId: string): void {
    this.player(playerId);
    this.store.setTokenHash(playerId, null);
  }

  private player(id: string): PlayerCache {
    let p = this.playerCache.get(id);
    if (!p) {
      const row = this.store.getPlayer(id);
      if (!row) throw new GameError('unknown_player', 'Joueur inconnu.');
      const day = dayKey(this.now());
      p = {
        id,
        name: row.name,
        skin: row.skin,
        brigadeId: this.store.getMembership(id) ?? null,
        lastActionAt: row.last_action_at,
        playDay: day,
        playMs: this.store.getPlaytime(id, day),
        presenceHidden: row.presence_hidden === 1,
      };
      this.playerCache.set(id, p);
    }
    return p;
  }

  publicPlayer(id: string): PublicPlayer {
    const p = this.player(id);
    return { id: p.id, name: p.name, skin: p.skin };
  }

  setName(playerId: string, raw: unknown): PublicPlayer {
    const name = cleanPlayerName(raw);
    const key = nameKey(name);
    const p = this.player(playerId);
    const holder = this.store.getPlayerByNameKey(key);
    if (holder && holder.id !== playerId) throw new GameError('name_taken', 'Ce pseudo est déjà utilisé.');
    this.store.setPlayerName(playerId, name, key);
    p.name = name;
    this.emit({ type: 'profileChanged', playerId });
    if (p.brigadeId) this.emitBrigade(p.brigadeId);
    return this.publicPlayer(playerId);
  }

  /** Présence : joueurs ayant frappé un bloc de la couche courante récemment (et ne l'ayant pas masquée). */
  presence(windowMs = PRESENCE_WINDOW_MS, limit = 40): PresenceEntry[] {
    const st = this.state;
    if (!st) return [];
    const now = this.now();
    const brigades = this.brigades();
    const out: PresenceEntry[] = [];
    for (const [playerId, h] of this.lastHits) {
      if (now - h.at > windowMs) {
        this.lastHits.delete(playerId);
        continue;
      }
      if (h.layer !== st.currentLayer) continue;
      const p = this.player(playerId);
      if (p.presenceHidden) continue;
      out.push({
        playerId,
        name: p.name,
        skin: p.skin,
        brigadeName: p.brigadeId ? (brigades.get(p.brigadeId)?.name ?? null) : null,
        block: h.block,
        ageMs: now - h.at,
      });
    }
    return out.sort((a, b) => a.ageMs - b.ageMs).slice(0, limit);
  }

  presenceVisible(playerId: string): boolean {
    return !this.player(playerId).presenceHidden;
  }

  setPresenceVisible(playerId: string, visible: unknown): boolean {
    if (typeof visible !== 'boolean') throw new GameError('invalid_presence', 'Valeur invalide.');
    const p = this.player(playerId);
    this.store.setPresenceHidden(playerId, !visible);
    p.presenceHidden = !visible;
    this.emit({ type: 'profileChanged', playerId });
    return visible;
  }

  setSkin(playerId: string, skin: unknown): PublicPlayer {
    if (!isValidSkin(skin)) throw new GameError('invalid_skin', 'Skin inconnu.');
    const p = this.player(playerId);
    this.store.setPlayerSkin(playerId, skin);
    p.skin = skin;
    this.emit({ type: 'profileChanged', playerId });
    return this.publicPlayer(playerId);
  }

  // =========================================================================
  // Temps de jeu actif
  // =========================================================================

  private refreshDay(p: PlayerCache, now: number) {
    const day = dayKey(now);
    if (p.playDay !== day) {
      p.playDay = day;
      p.playMs = this.store.getPlaytime(p.id, day);
    }
  }

  playtime(playerId: string): PlaytimeInfo {
    const now = this.now();
    const p = this.player(playerId);
    this.refreshDay(p, now);
    return { usedMs: p.playMs, limitMs: this.rules.dailyActiveLimitMs, resetsAt: nextDayStart(now) };
  }

  // =========================================================================
  // Minage
  // =========================================================================

  mine(playerId: string, req: MineRequest): MineResult {
    const { actionId, layer, block } = req;
    if (typeof actionId !== 'string' || !ACTION_ID_RE.test(actionId) || !Number.isInteger(layer) || !Number.isInteger(block)) {
      return { ok: false, reason: 'invalid_action' };
    }
    const L = layer as number;
    const B = block as number;

    // 1. Idempotence : une action déjà appliquée renvoie son résultat d'origine.
    const previous = this.store.findHit(playerId, actionId);
    if (previous) return this.duplicateResult(previous);

    const st = this.state;
    if (!st) return { ok: false, reason: 'no_active_season' };

    const now = this.now();
    if (now >= st.season.ends_at) {
      this.endSeason('timeout', null, st.season.ends_at);
      return { ok: false, reason: 'no_active_season' };
    }

    // 2. Limite de débit (par compte, toutes connexions confondues).
    const wait = this.limiter.tryTake(playerId, now);
    if (wait > 0) return { ok: false, reason: 'rate_limited', retryAfterMs: wait };

    // 3. Limite quotidienne de temps actif.
    const p = this.player(playerId);
    this.refreshDay(p, now);
    if (p.playMs >= this.rules.dailyActiveLimitMs) {
      return { ok: false, reason: 'daily_limit', retryAfterMs: nextDayStart(now) - now };
    }

    // 4. Règles du cube.
    if (L < 0 || L >= st.size || B < 0 || B >= st.perLayer) return { ok: false, reason: 'out_of_bounds' };
    if (L < st.currentLayer) return { ok: false, reason: 'already_destroyed' };
    if (L > st.currentLayer) return { ok: false, reason: 'layer_locked' };
    const cell = L * st.perLayer + B;
    if (st.hp[cell] <= 0) return { ok: false, reason: 'already_destroyed' };

    // 5. Application atomique.
    const credit = activeCredit(p.lastActionAt, now, this.rules.idleGapMs);
    const newPlayMs = Math.min(this.rules.dailyActiveLimitMs, p.playMs + credit);
    const brigadeId = p.brigadeId;
    let hpAfter: number;
    try {
      hpAfter = this.store.transaction(() => {
        const hp = this.store.damageBlock(st.season.id, L, B, playerId, now);
        if (hp === undefined) throw new AlreadyDestroyed();
        const destroyed = hp === 0;
        this.store.insertHit({
          season_id: st.season.id,
          player_id: playerId,
          action_id: actionId,
          layer: L,
          idx: B,
          hp_after: hp,
          destroyed: destroyed ? 1 : 0,
          brigade_id: brigadeId,
          at: now,
        });
        this.store.addContribution(st.season.id, playerId, destroyed, now);
        if (brigadeId) this.store.addBrigadeContribution(st.season.id, brigadeId, destroyed, now);
        this.store.setPlaytime(playerId, p.playDay, newPlayMs);
        this.store.setLastActionAt(playerId, now);
        return hp;
      });
    } catch (err) {
      if (err instanceof AlreadyDestroyed) {
        st.hp[cell] = 0;
        return { ok: false, reason: 'already_destroyed' };
      }
      // Course entre processus sur la même action : l'unicité (player_id, action_id) tranche.
      const dup = this.store.findHit(playerId, actionId);
      if (dup) return this.duplicateResult(dup);
      throw err;
    }

    // 6. Mise à jour de l'état mémoire (après COMMIT uniquement).
    const destroyed = hpAfter === 0;
    st.hp[cell] = hpAfter;
    st.remainingHp--;
    const minute = Math.floor(now / 60_000);
    this.hitBuckets.set(minute, (this.hitBuckets.get(minute) ?? 0) + 1);
    this.lastHits.set(playerId, { block: B, layer: L, at: now });
    if (this.hitBuckets.size > 70) for (const k of this.hitBuckets.keys()) if (k < minute - 60) this.hitBuckets.delete(k);
    p.playMs = newPlayMs;
    p.lastActionAt = now;
    bump(st.players, playerId, destroyed, now);
    if (brigadeId) bump(st.brigades, brigadeId, destroyed, now);
    this.rankDirty = true;

    this.emit({ type: 'block', seasonId: st.season.id, layer: L, block: B, hp: hpAfter, playerId });

    if (destroyed) {
      st.destroyed++;
      st.layerRemaining[L]--;
      if (st.layerRemaining[L] === 0) {
        st.currentLayer = this.firstLayerWithBlocks(st);
        if (st.currentLayer >= st.size) {
          this.endSeason('completed', playerId);
        } else {
          this.emit({ type: 'layer', seasonId: st.season.id, layer: st.currentLayer });
        }
      }
    }

    return { ok: true, duplicate: false, layer: L, block: B, hpAfter, destroyed };
  }

  private duplicateResult(h: { layer: number; idx: number; hp_after: number; destroyed: number }): MineResult {
    return { ok: true, duplicate: true, layer: h.layer, block: h.idx, hpAfter: h.hp_after, destroyed: h.destroyed === 1 };
  }

  private firstLayerWithBlocks(st: ActiveState): number {
    let l = 0;
    while (l < st.size && st.layerRemaining[l] === 0) l++;
    return l;
  }

  // =========================================================================
  // Saisons
  // =========================================================================

  private loadSeason(season: SeasonRow) {
    const size = season.cube_size;
    const perLayer = size * size;
    const hp = new Int32Array(size * perLayer);
    const layerRemaining = new Array<number>(size).fill(0);
    let destroyed = 0;
    for (const b of this.store.loadBlockHp(season.id)) {
      hp[b.layer * perLayer + b.idx] = b.hp;
      if (b.hp > 0) layerRemaining[b.layer]++;
      else destroyed++;
    }
    const layerMaxHp = Array.from({ length: size }, (_, l) => season.base_hp + l * season.hp_per_layer);
    const players = new Map<string, Contribution>();
    for (const c of this.store.loadContributions(season.id)) {
      players.set(c.player_id, { hits: c.hits, blocks: c.blocks, lastHitAt: c.last_hit_at });
    }
    const brigades = new Map<string, Contribution>();
    for (const c of this.store.loadBrigadeContributions(season.id)) {
      brigades.set(c.brigade_id, { hits: c.hits, blocks: c.blocks, lastHitAt: c.last_hit_at });
    }
    let remainingHp = 0;
    for (let i = 0; i < hp.length; i++) remainingHp += hp[i];
    const totalHp = layerMaxHp.reduce((s, h) => s + h * perLayer, 0);
    const st: ActiveState = { season, totalHp, remainingHp, size, perLayer, hp, layerMaxHp, layerRemaining, currentLayer: 0, destroyed, players, brigades };
    st.currentLayer = this.firstLayerWithBlocks(st);
    this.state = st;
    this.sortedPlayers = null;
  }

  get activeSeason(): SeasonRow | null {
    return this.state?.season ?? null;
  }

  get upcomingSeasonAt(): number | null {
    return this.state ? null : this.nextSeasonAt;
  }

  startSeason(opts: { name?: string; cubeSize?: number; durationMs?: number; baseHp?: number; hpPerLayer?: number } = {}): SeasonRow {
    if (this.state) throw new GameError('season_active', 'Une saison est déjà en cours.');
    const now = this.now();
    const count = this.store.listSeasons(1)[0]?.id ?? 0;
    const cubeSize = opts.cubeSize ?? this.rules.cubeSize;
    if (!Number.isInteger(cubeSize) || cubeSize < 1 || cubeSize > 64) throw new GameError('invalid_size', 'Taille de cube invalide (1-64).');
    const durationMs = opts.durationMs ?? this.rules.seasonDurationMs;
    if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 400 * 24 * 3600_000) throw new GameError('invalid_duration', 'Durée invalide.');
    const baseHp = opts.baseHp ?? this.rules.baseHp;
    const hpPerLayer = opts.hpPerLayer ?? this.rules.hpPerLayer;
    if (!Number.isInteger(baseHp) || baseHp < 1 || baseHp > 1_000_000) throw new GameError('invalid_hp', 'Résistance de base invalide.');
    if (!Number.isInteger(hpPerLayer) || hpPerLayer < 0 || hpPerLayer > 1_000_000) throw new GameError('invalid_hp', 'Progression de résistance invalide.');
    const season = this.store.createSeason({
      name: opts.name?.trim() || `Saison ${count + 1}`,
      cubeSize,
      baseHp,
      hpPerLayer,
      startsAt: now,
      endsAt: now + durationMs,
    });
    this.nextSeasonAt = null;
    this.loadSeason(season);
    this.emit({ type: 'seasonStarted', seasonId: season.id });
    return season;
  }

  /**
   * Clôture la saison active : calcule le champion (contribution la plus
   * élevée, départagé par l'antériorité du score), la brigade championne
   * (brigades éligibles uniquement) et archive les classements.
   */
  endSeason(reason: 'completed' | 'timeout' | 'admin', finalStonePlayerId: string | null = null, endedAt?: number): SeasonInfo {
    const st = this.state;
    if (!st) throw new GameError('no_active_season', 'Aucune saison en cours.');
    const now = endedAt ?? this.now();
    const ranking = this.sortPlayers(st);
    const brigadeRanking = this.brigadeBoard(Number.MAX_SAFE_INTEGER);
    const champion = ranking[0]?.[0] ?? null;
    const championBrigade = brigadeRanking.find((b) => b.eligible && b.hits > 0)?.brigadeId ?? null;

    const results: SeasonResultRow[] = [];
    ranking.slice(0, ARCHIVE_TOP).forEach(([id, c], i) => {
      results.push({ season_id: st.season.id, kind: 'player', rank: i + 1, entity_id: id, name: this.player(id).name, score: c.hits });
    });
    brigadeRanking
      .filter((b) => b.eligible)
      .slice(0, ARCHIVE_TOP)
      .forEach((b, i) => {
        results.push({ season_id: st.season.id, kind: 'brigade', rank: i + 1, entity_id: b.brigadeId, name: b.name, score: b.hits });
      });

    this.store.transaction(() => {
      this.store.endSeason(st.season.id, {
        endedAt: now,
        reason,
        championPlayerId: champion,
        championBrigadeId: championBrigade,
        finalStonePlayerId: finalStonePlayerId,
      });
      this.store.insertSeasonResults(results);
    });

    this.state = null;
    this.sortedPlayers = null;
    this.nextSeasonAt = this.rules.autoStartSeason ? now + this.rules.seasonCooldownMs : null;
    this.hitBuckets.clear();
    this.lastHits.clear();
    const info = this.seasonInfo(this.store.getSeason(st.season.id)!);
    this.emit({ type: 'seasonEnded', season: info, nextSeasonAt: this.nextSeasonAt });
    return info;
  }

  /** À appeler régulièrement : fin de saison par échéance, démarrage automatique. */
  tick(): void {
    const now = this.now();
    if (this.state && now >= this.state.season.ends_at) {
      this.endSeason('timeout', null, this.state.season.ends_at);
    }
    if (!this.state && this.rules.autoStartSeason) {
      if (this.nextSeasonAt === null) this.nextSeasonAt = now;
      if (now >= this.nextSeasonAt) this.startSeason();
    }
    this.limiter.prune(now);
    this.joinFailures.prune(now);
  }

  seasonInfo(s: SeasonRow): SeasonInfo {
    const name = (id: string | null) => (id ? (this.store.getPlayer(id)?.name ?? null) : null);
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      cubeSize: s.cube_size,
      startsAt: s.starts_at,
      endsAt: s.ends_at,
      endedAt: s.ended_at,
      endReason: s.end_reason,
      championName: name(s.champion_player_id),
      championBrigadeName: s.champion_brigade_id
        ? (this.store.getSeasonResults(s.id).find((r) => r.kind === 'brigade' && r.entity_id === s.champion_brigade_id)?.name ??
          this.store.getBrigade(s.champion_brigade_id)?.name ??
          null)
        : null,
      finalStoneName: name(s.final_stone_player_id),
      completedEarlyMs: s.end_reason === 'completed' && s.ended_at !== null ? Math.max(0, s.ends_at - s.ended_at) : null,
    };
  }

  /** Avancement et estimation de fin de la saison active (calibrage, affichage). */
  projection(): SeasonProjection | null {
    const st = this.state;
    if (!st) return null;
    const now = this.now();
    const done = st.totalHp - st.remainingHp;
    const elapsed = Math.max(60_000, now - st.season.starts_at);
    const avgHitsPerHour = (done / elapsed) * 3600_000;
    const minute = Math.floor(now / 60_000);
    let recent = 0;
    for (const [k, v] of this.hitBuckets) if (k > minute - 60) recent += v;
    const recentMinutes = Math.min(60, Math.max(1, Math.ceil(elapsed / 60_000)));
    const recentHitsPerHour = (recent / recentMinutes) * 60;
    // Moyenne depuis le début de saison : robuste aux cycles jour/nuit et
    // recalculée depuis la base après un redémarrage. Le rythme de la
    // dernière heure n'est fourni qu'à titre indicatif.
    const rate = avgHitsPerHour;
    const projectedCompletionAt = rate > 0 ? Math.round(now + (st.remainingHp / rate) * 3600_000) : null;
    return {
      totalHits: st.totalHp,
      hitsDone: done,
      remainingHits: st.remainingHp,
      avgHitsPerHour: Math.round(avgHitsPerHour),
      recentHitsPerHour: Math.round(recentHitsPerHour),
      projectedCompletionAt,
      endsAt: st.season.ends_at,
      completesBeforeEnd: projectedCompletionAt !== null && projectedCompletionAt < st.season.ends_at,
    };
  }

  listSeasons(limit = 20): SeasonInfo[] {
    return this.store.listSeasons(limit).map((s) => this.seasonInfo(s));
  }

  seasonResults(seasonId: number) {
    const s = this.store.getSeason(seasonId);
    if (!s) return null;
    const rows = this.store.getSeasonResults(seasonId);
    return {
      season: this.seasonInfo(s),
      players: rows.filter((r) => r.kind === 'player').map((r) => ({ rank: r.rank, name: r.name, hits: r.score })),
      brigades: rows.filter((r) => r.kind === 'brigade').map((r) => ({ rank: r.rank, name: r.name, hits: r.score })),
    };
  }

  // =========================================================================
  // Vues (snapshot, classements)
  // =========================================================================

  cubeSnapshot(): CubeSnapshot | null {
    const st = this.state;
    if (!st) return null;
    const cur = st.currentLayer;
    const currentHp =
      cur < st.size ? Array.from(st.hp.subarray(cur * st.perLayer, (cur + 1) * st.perLayer)) : [];
    return {
      size: st.size,
      currentLayer: cur,
      layerRemaining: [...st.layerRemaining],
      layerMaxHp: [...st.layerMaxHp],
      currentHp,
      totalBlocks: st.size * st.perLayer,
      destroyedBlocks: st.destroyed,
    };
  }

  get destroyedBlocks(): number {
    return this.state?.destroyed ?? 0;
  }

  private sortPlayers(st: ActiveState): [string, Contribution][] {
    if (!this.sortedPlayers || this.rankDirty) {
      this.rankDirty = false;
      this.sortedPlayers = [...st.players.entries()].sort(
        (a, b) => b[1].hits - a[1].hits || a[1].lastHitAt - b[1].lastHitAt || (a[0] < b[0] ? -1 : 1),
      );
      this.rankIndex = new Map(this.sortedPlayers.map(([id], i) => [id, i + 1]));
      this.sortedAt = this.now();
    }
    return this.sortedPlayers;
  }

  leaderboard(limit = this.rules.leaderboardSize): LeaderboardEntry[] {
    const st = this.state;
    if (!st) return [];
    const brigades = this.brigades();
    return this.sortPlayers(st)
      .slice(0, limit)
      .map(([id, c], i) => {
        const p = this.player(id);
        return {
          rank: i + 1,
          playerId: id,
          name: p.name,
          skin: p.skin,
          hits: c.hits,
          blocks: c.blocks,
          brigadeName: p.brigadeId ? (brigades.get(p.brigadeId)?.name ?? null) : null,
        };
      });
  }

  /**
   * Statistiques personnelles. Le rang est calculé sur un tri mis en cache
   * (rafraîchi au plus toutes les `maxAgeMs`) pour éviter un tri par coup.
   */
  myStats(playerId: string, maxAgeMs = 1000): MyStats {
    const st = this.state;
    if (!st) return { hits: 0, blocks: 0, rank: null };
    const c = st.players.get(playerId);
    if (!this.sortedPlayers || (this.rankDirty && this.now() - this.sortedAt >= maxAgeMs)) {
      this.sortPlayers(st);
    }
    return { hits: c?.hits ?? 0, blocks: c?.blocks ?? 0, rank: c ? (this.rankIndex.get(playerId) ?? null) : null };
  }

  private brigades(): Map<string, { name: string; members: number }> {
    if (!this.brigadeCache) {
      this.brigadeCache = new Map(this.store.listBrigades().map((b) => [b.id, { name: b.name, members: b.members }]));
    }
    return this.brigadeCache;
  }

  brigadeBoard(limit = this.rules.leaderboardSize): BrigadeBoardEntry[] {
    const all = this.brigades();
    const contrib = this.state?.brigades ?? new Map<string, Contribution>();
    return [...all.entries()]
      .map(([id, b]) => ({ id, b, c: contrib.get(id) }))
      .sort(
        (x, y) =>
          (y.c?.hits ?? 0) - (x.c?.hits ?? 0) ||
          (x.c?.lastHitAt ?? Infinity) - (y.c?.lastHitAt ?? Infinity) ||
          (x.id < y.id ? -1 : 1),
      )
      .slice(0, limit)
      .map(({ id, b, c }, i) => ({
        rank: i + 1,
        brigadeId: id,
        name: b.name,
        members: b.members,
        eligible: b.members >= this.rules.brigadeMinSize,
        hits: c?.hits ?? 0,
      }));
  }

  // =========================================================================
  // Brigades
  // =========================================================================

  brigadeInfo(playerId: string): BrigadeInfo | null {
    const brigadeId = this.player(playerId).brigadeId;
    if (!brigadeId) return null;
    const b = this.store.getBrigade(brigadeId);
    if (!b) return null;
    const players = this.state?.players;
    return {
      id: b.id,
      name: b.name,
      inviteCode: b.invite_code,
      ownerId: b.owner_id,
      members: this.store.listMembers(b.id).map((m) => ({ id: m.id, name: m.name, hits: players?.get(m.id)?.hits ?? 0 })),
      minSize: this.rules.brigadeMinSize,
      maxSize: this.rules.brigadeMaxSize,
    };
  }

  createBrigade(playerId: string, rawName: unknown): BrigadeInfo {
    const name = cleanBrigadeName(rawName);
    const p = this.player(playerId);
    if (p.brigadeId) throw new GameError('already_in_brigade', 'Vous faites déjà partie d\'une brigade.');
    if (this.store.getBrigadeByName(name)) throw new GameError('brigade_name_taken', 'Ce nom de brigade est déjà pris.');
    const id = randomUUID();
    const now = this.now();
    this.store.transaction(() => {
      let code = generateInviteCode();
      while (this.store.getBrigadeByCode(code)) code = generateInviteCode();
      this.store.createBrigade({ id, name, invite_code: code, owner_id: playerId, created_at: now });
      this.store.addMember(id, playerId, now);
    });
    p.brigadeId = id;
    this.brigadeCache = null;
    this.emitBrigade(id);
    return this.brigadeInfo(playerId)!;
  }

  joinBrigade(playerId: string, rawCode: unknown): BrigadeInfo {
    const p = this.player(playerId);
    if (p.brigadeId) throw new GameError('already_in_brigade', 'Quittez d\'abord votre brigade actuelle.');
    const now = this.now();
    if (this.joinFailures.isBlocked(playerId, now)) {
      throw new GameError('too_many_attempts', 'Trop de codes invalides. Réessayez dans quelques minutes.');
    }
    let code: string;
    try {
      code = normalizeInviteCode(rawCode);
    } catch (err) {
      this.joinFailures.tryTake(playerId, now);
      throw err;
    }
    const b = this.store.getBrigadeByCode(code);
    if (!b) {
      this.joinFailures.tryTake(playerId, now);
      throw new GameError('invalid_code', 'Code d\'invitation inconnu.');
    }
    this.store.transaction(() => {
      if (this.store.listMembers(b.id).length >= this.rules.brigadeMaxSize) {
        throw new GameError('brigade_full', `Brigade complète (${this.rules.brigadeMaxSize} membres maximum).`);
      }
      this.store.addMember(b.id, playerId, this.now());
    });
    p.brigadeId = b.id;
    this.brigadeCache = null;
    this.emitBrigade(b.id);
    return this.brigadeInfo(playerId)!;
  }

  leaveBrigade(playerId: string): void {
    const p = this.player(playerId);
    const brigadeId = p.brigadeId;
    if (!brigadeId) throw new GameError('not_in_brigade', 'Vous ne faites partie d\'aucune brigade.');
    this.store.transaction(() => {
      this.store.removeMember(playerId);
      const remaining = this.store.listMembers(brigadeId);
      if (remaining.length === 0) {
        this.store.deleteBrigade(brigadeId);
      } else if (this.store.getBrigade(brigadeId)?.owner_id === playerId) {
        this.store.setBrigadeOwner(brigadeId, remaining[0].id);
      }
    });
    p.brigadeId = null;
    this.brigadeCache = null;
    this.emit({ type: 'brigadeChanged', brigadeId, playerIds: [playerId, ...this.store.listMembers(brigadeId).map((m) => m.id)] });
  }

  private emitBrigade(brigadeId: string) {
    this.emit({ type: 'brigadeChanged', brigadeId, playerIds: this.store.listMembers(brigadeId).map((m) => m.id) });
  }
}

function bump(map: Map<string, Contribution>, key: string, destroyed: boolean, at: number) {
  const c = map.get(key);
  if (c) {
    c.hits++;
    if (destroyed) c.blocks++;
    c.lastHitAt = at;
  } else {
    map.set(key, { hits: 1, blocks: destroyed ? 1 : 0, lastHitAt: at });
  }
}
