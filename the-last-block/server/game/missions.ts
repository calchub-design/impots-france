import type { MissionHistoryDay, MissionsState, MissionView } from '../../shared/missions.js';
import type { GameStore } from '../db/store.js';
import rawContent from '../content/missions.json' with { type: 'json' };
import { dayKey, nextDayStart } from './playtime.js';

/**
 * Missions quotidiennes individuelles.
 *
 * - Progression calculée UNIQUEMENT à partir des coups acceptés par le moteur,
 *   dans la même transaction SQLite que le coup : un coup renvoyé (même
 *   actionId) n'est jamais recompté, et un arrêt brutal ne peut séparer un
 *   coup de sa progression.
 * - Jour UTC (00 h), comme la limite de temps de jeu quotidienne.
 * - Aucune lecture de l'historique complet : une ligne d'avancement par joueur,
 *   par saison et par jour, gardée en mémoire après la première lecture. Les
 *   écritures s'arrêtent dès que les objectifs du jour sont atteints.
 * - N'écrit QUE dans ses propres tables : PV, cadence, temps de jeu, scores et
 *   classements ne sont jamais touchés.
 */

export type MissionKind = 'hits' | 'distinct-blocks' | 'layer-contribution';

export interface MissionDef {
  id: string;
  kind: MissionKind;
  target: number;
  title: string;
  description: string;
}

export interface MissionContent {
  missions: MissionDef[];
  ranks: { at: number; title: string }[];
  dailyReward: { unlock: string; label: string } | null;
}

const KINDS: MissionKind[] = ['hits', 'distinct-blocks', 'layer-contribution'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function validateMissionContent(raw: unknown): MissionContent {
  const r = raw as { missions?: unknown; ranks?: unknown; dailyReward?: unknown };
  if (!r || !Array.isArray(r.missions) || r.missions.length === 0) throw new Error('missions : liste « missions » requise');
  const ids = new Set<string>();
  const missions = (r.missions as Record<string, unknown>[]).map((m) => {
    const id = m?.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`missions : identifiant invalide « ${String(id)} »`);
    if (ids.has(id)) throw new Error(`missions : identifiant « ${id} » en double`);
    ids.add(id);
    if (!KINDS.includes(m.kind as MissionKind)) throw new Error(`missions : type inconnu pour « ${id} » (${KINDS.join(', ')})`);
    if (!Number.isInteger(m.target) || (m.target as number) < 1 || (m.target as number) > 10_000) throw new Error(`missions : seuil invalide pour « ${id} » (entier de 1 à 10 000)`);
    for (const k of ['title', 'description'] as const) {
      if (typeof m[k] !== 'string' || !(m[k] as string).trim() || (m[k] as string).length > 200) throw new Error(`missions : ${k} invalide pour « ${id} »`);
    }
    return { id, kind: m.kind as MissionKind, target: m.target as number, title: m.title as string, description: m.description as string };
  });
  const ranks = Array.isArray(r.ranks)
    ? (r.ranks as { at?: unknown; title?: unknown }[]).map((x) => {
        if (!Number.isInteger(x?.at) || (x.at as number) < 1 || typeof x.title !== 'string' || !x.title.trim()) throw new Error('missions : rang invalide');
        return { at: x.at as number, title: x.title };
      })
    : [];
  for (let i = 1; i < ranks.length; i++) if (ranks[i].at <= ranks[i - 1].at) throw new Error('missions : rangs non croissants');
  let dailyReward: MissionContent['dailyReward'] = null;
  if (r.dailyReward != null) {
    const d = r.dailyReward as { unlock?: unknown; label?: unknown };
    if (typeof d.unlock !== 'string' || !d.unlock || typeof d.label !== 'string' || !d.label) throw new Error('missions : récompense quotidienne invalide');
    dailyReward = { unlock: d.unlock, label: d.label };
  }
  return { missions, ranks, dailyReward };
}

export const MISSION_CONTENT: MissionContent = validateMissionContent(rawContent);

// ---------------------------------------------------------------------------
// Avancement d'une journée (fonctions pures)
// ---------------------------------------------------------------------------

export interface DailyProgress {
  /** Coups validés (plafonné au plus grand seuil utile). */
  hits: number;
  /** Blocs distincts frappés, « couche:index » (plafonné). */
  blocks: string[];
  /** Couches frappées aujourd'hui (pour la contribution collective). */
  layers: number[];
  /** Couches terminées aujourd'hui auxquelles le joueur a contribué aujourd'hui (plafonné). */
  layersDone: number;
}

export function emptyProgress(): DailyProgress {
  return { hits: 0, blocks: [], layers: [], layersDone: 0 };
}

/** Plafonds : au-delà, plus rien n'est écrit pour la journée. */
export function progressCaps(c: MissionContent) {
  const max = (k: MissionKind) => Math.max(0, ...c.missions.filter((m) => m.kind === k).map((m) => m.target));
  return { hits: max('hits'), blocks: max('distinct-blocks'), layers: max('layer-contribution') };
}

export function applyHit(p: DailyProgress, layer: number, idx: number, caps: ReturnType<typeof progressCaps>): { next: DailyProgress; changed: boolean; newLayer: boolean } {
  const next: DailyProgress = { hits: p.hits, blocks: p.blocks, layers: p.layers, layersDone: p.layersDone };
  let changed = false;
  if (next.hits < caps.hits) {
    next.hits++;
    changed = true;
  }
  const key = `${layer}:${idx}`;
  if (next.blocks.length < caps.blocks && !next.blocks.includes(key)) {
    next.blocks = [...next.blocks, key];
    changed = true;
  }
  let newLayer = false;
  if (caps.layers > 0 && !next.layers.includes(layer)) {
    next.layers = [...next.layers, layer];
    changed = true;
    newLayer = true;
  }
  return { next, changed, newLayer };
}

export function applyLayerCompleted(p: DailyProgress, caps: ReturnType<typeof progressCaps>): { next: DailyProgress; changed: boolean } {
  if (p.layersDone >= caps.layers) return { next: p, changed: false };
  return { next: { ...p, layersDone: p.layersDone + 1 }, changed: true };
}

export function missionProgress(m: MissionDef, p: DailyProgress): number {
  const v = m.kind === 'hits' ? p.hits : m.kind === 'distinct-blocks' ? p.blocks.length : p.layersDone;
  return Math.min(v, m.target);
}

export function rankFor(c: MissionContent, count: number) {
  let rank: { at: number; title: string } | null = null;
  let next: { at: number; title: string } | null = null;
  for (const r of c.ranks) {
    if (count >= r.at) rank = r;
    else if (!next) next = r;
  }
  return { rank, next };
}

// ---------------------------------------------------------------------------
// Suivi par joueur (mémoire + base), appelé par le moteur
// ---------------------------------------------------------------------------

interface Entry {
  seasonId: number;
  day: string;
  p: DailyProgress;
  /** missionId → instant d'accomplissement (jour en cours). */
  done: Map<string, number>;
}

export interface MissionUpdate {
  playerId: string;
  /** Missions accomplies par ce coup / cette fin de couche. */
  completed: string[];
  /** Éléments cosmétiques débloqués. */
  unlocked: string[];
}

export class MissionTracker {
  private readonly caps: ReturnType<typeof progressCaps>;
  private readonly entries = new Map<string, Entry>();
  private readonly seasonCounts = new Map<string, { seasonId: number; count: number }>();
  private readonly unlocks = new Map<string, Set<string>>();
  /** Changements de la transaction en cours, appliqués en mémoire seulement après COMMIT. */
  private scratch = new Map<string, { entry: Entry; completed: string[]; unlocked: string[] }>();

  constructor(
    private readonly store: GameStore,
    readonly content: MissionContent = MISSION_CONTENT,
  ) {
    this.caps = progressCaps(content);
  }

  private load(playerId: string, seasonId: number, day: string): Entry {
    const pending = this.scratch.get(playerId);
    if (pending && pending.entry.seasonId === seasonId && pending.entry.day === day) return pending.entry;
    const cached = this.entries.get(playerId);
    if (cached && cached.seasonId === seasonId && cached.day === day) return cached;
    const row = this.store.getDailyMissions(seasonId, playerId, day);
    const p = row ? { hits: row.hits, blocks: JSON.parse(row.blocks) as string[], layers: JSON.parse(row.layers) as number[], layersDone: row.layers_done } : emptyProgress();
    const done = new Map(this.store.listMissionCompletions(seasonId, playerId, day).map((c) => [c.mission_id, c.completed_at] as const));
    const e: Entry = { seasonId, day, p, done };
    this.entries.set(playerId, e);
    return e;
  }

  /** À appeler au début de la transaction d'un coup. */
  begin() {
    this.scratch.clear();
  }

  /** Annule les changements en mémoire d'une transaction échouée. */
  abort() {
    this.scratch.clear();
  }

  private update(playerId: string, before: Entry, next: DailyProgress, now: number) {
    const entry: Entry = { seasonId: before.seasonId, day: before.day, p: next, done: new Map(before.done) };
    this.store.saveDailyMissions(entry.seasonId, playerId, entry.day, next.hits, JSON.stringify(next.blocks), JSON.stringify(next.layers), next.layersDone);
    const prev = this.scratch.get(playerId);
    const completed = prev?.completed ?? [];
    const unlocked = prev?.unlocked ?? [];
    for (const m of this.content.missions) {
      if (entry.done.has(m.id) || missionProgress(m, next) < m.target) continue;
      // INSERT OR IGNORE : une mission n'est enregistrée qu'une fois par jour.
      if (this.store.insertMissionCompletion(entry.seasonId, playerId, entry.day, m.id, now)) completed.push(m.id);
      entry.done.set(m.id, now);
    }
    const reward = this.content.dailyReward;
    if (reward && completed.length && this.content.missions.every((m) => entry.done.has(m.id))) {
      if (this.store.addUnlock(playerId, reward.unlock, now)) unlocked.push(reward.unlock);
    }
    this.scratch.set(playerId, { entry, completed, unlocked });
  }

  /** Coup accepté (dans la transaction du coup). */
  onHit(seasonId: number, playerId: string, layer: number, idx: number, now: number) {
    const day = dayKey(now);
    const e = this.load(playerId, seasonId, day);
    const { next, changed, newLayer } = applyHit(e.p, layer, idx, this.caps);
    if (newLayer) this.store.addDailyLayerHit(seasonId, day, layer, playerId);
    if (changed) this.update(playerId, e, next, now);
  }

  /** Couche entièrement détruite (dans la transaction du dernier coup). */
  onLayerCompleted(seasonId: number, layer: number, now: number) {
    if (this.caps.layers === 0) return;
    const day = dayKey(now);
    for (const playerId of this.store.dailyLayerPlayers(seasonId, day, layer)) {
      const e = this.load(playerId, seasonId, day);
      const { next, changed } = applyLayerCompleted(e.p, this.caps);
      if (changed) this.update(playerId, e, next, now);
    }
  }

  /** Après COMMIT : applique en mémoire et renvoie les joueurs à prévenir. */
  commit(): MissionUpdate[] {
    const out: MissionUpdate[] = [];
    for (const [playerId, s] of this.scratch) {
      this.entries.set(playerId, s.entry);
      if (s.completed.length) {
        const c = this.seasonCounts.get(playerId);
        if (c && c.seasonId === s.entry.seasonId) c.count += s.completed.length;
      }
      if (s.unlocked.length) {
        const set = this.unlocksOf(playerId);
        for (const u of s.unlocked) set.add(u);
      }
      out.push({ playerId, completed: s.completed, unlocked: s.unlocked });
    }
    this.scratch.clear();
    return out;
  }

  private unlocksOf(playerId: string): Set<string> {
    let set = this.unlocks.get(playerId);
    if (!set) {
      set = new Set(this.store.listUnlocks(playerId));
      this.unlocks.set(playerId, set);
    }
    return set;
  }

  hasUnlock(playerId: string, unlock: string): boolean {
    return this.unlocksOf(playerId).has(unlock);
  }

  private seasonCount(playerId: string, seasonId: number): number {
    const c = this.seasonCounts.get(playerId);
    if (c && c.seasonId === seasonId) return c.count;
    const count = this.store.countMissionCompletions(seasonId, playerId);
    this.seasonCounts.set(playerId, { seasonId, count });
    return count;
  }

  /** État affiché au joueur (jour UTC courant). `history` : historique de la saison. */
  state(playerId: string, seasonId: number | null, now: number, history = false): MissionsState {
    const day = dayKey(now);
    const unlocks = [...this.unlocksOf(playerId)];
    const reward = this.content.dailyReward ? { ...this.content.dailyReward, unlocked: unlocks.includes(this.content.dailyReward.unlock) } : null;
    if (seasonId === null) {
      return { seasonId: null, day, resetsAt: nextDayStart(now), missions: [], seasonCompleted: 0, rank: null, nextRank: null, reward, unlocks, ...(history ? { history: [] } : {}) };
    }
    const e = this.load(playerId, seasonId, day);
    const missions: MissionView[] = this.content.missions.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description.replace('{target}', String(m.target)),
      target: m.target,
      progress: missionProgress(m, e.p),
      done: e.done.has(m.id),
      ...(e.done.has(m.id) ? { completedAt: e.done.get(m.id) } : {}),
    }));
    const count = this.seasonCount(playerId, seasonId);
    const { rank, next } = rankFor(this.content, count);
    const out: MissionsState = { seasonId, day, resetsAt: nextDayStart(now), missions, seasonCompleted: count, rank, nextRank: next, reward, unlocks };
    if (history) out.history = this.history(playerId, seasonId);
    return out;
  }

  private history(playerId: string, seasonId: number): MissionHistoryDay[] {
    const byDay = new Map<string, string[]>();
    for (const c of this.store.listSeasonMissionCompletions(seasonId, playerId, 30 * this.content.missions.length)) {
      const l = byDay.get(c.day) ?? [];
      l.push(c.mission_id);
      byDay.set(c.day, l);
    }
    return [...byDay].map(([day, missions]) => ({ day, missions }));
  }
}
