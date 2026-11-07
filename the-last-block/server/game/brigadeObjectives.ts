import type { BrigadeContributor, BrigadeDistinction, BrigadeObjectiveView, BrigadeObjectivesInfo } from '../../shared/brigades.js';
import { brigadeEmblem } from '../../shared/brigades.js';
import type { GameStore } from '../db/store.js';
import rawContent from '../content/brigade-objectives.json' with { type: 'json' };

/**
 * Objectifs collectifs de brigade (saisonniers, par paliers).
 *
 * - Une contribution appartient à la brigade dont le joueur était membre AU
 *   MOMENT du coup (colonne `brigade_id` du journal des coups). Arriver ou
 *   partir ne transfère, n'efface et ne recompte rien : la progression d'une
 *   brigade ne fait que croître pendant la saison.
 * - Progression écrite dans la transaction du coup (pas de double comptage,
 *   aucune perte au SIGKILL). Paliers enregistrés une seule fois
 *   (INSERT OR IGNORE).
 * - Impossible de « remettre à zéro » pour regagner une distinction : une
 *   brigade dissoute puis recréée est une nouvelle brigade, sans les
 *   distinctions de l'ancienne ; changer de brigade ne change rien aux
 *   contributions déjà faites.
 * - N'écrit que dans ses propres tables : PV, cadence, temps de jeu, scores et
 *   titre de brigade championne ne sont jamais touchés.
 */

export type ObjectiveKind = 'brigade-hits' | 'members-min-hits' | 'layers-explored';

export interface ObjectiveDef {
  id: string;
  kind: ObjectiveKind;
  title: string;
  description: string;
  tiers: number[];
  minHits?: number;
}

export interface BrigadeObjectivesContent {
  objectives: ObjectiveDef[];
  tierLabels: string[];
  titles: { at: number; title: string }[];
}

const KINDS: ObjectiveKind[] = ['brigade-hits', 'members-min-hits', 'layers-explored'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function validateBrigadeObjectives(raw: unknown): BrigadeObjectivesContent {
  const r = raw as { objectives?: unknown; tierLabels?: unknown; titles?: unknown };
  if (!r || !Array.isArray(r.objectives) || r.objectives.length === 0) throw new Error('objectifs de brigade : liste « objectives » requise');
  const ids = new Set<string>();
  const objectives = (r.objectives as Record<string, unknown>[]).map((o) => {
    const id = o?.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`objectifs de brigade : identifiant invalide « ${String(id)} »`);
    if (ids.has(id)) throw new Error(`objectifs de brigade : identifiant « ${id} » en double`);
    ids.add(id);
    if (!KINDS.includes(o.kind as ObjectiveKind)) throw new Error(`objectifs de brigade : type inconnu pour « ${id} »`);
    for (const k of ['title', 'description'] as const) {
      if (typeof o[k] !== 'string' || !(o[k] as string).trim() || (o[k] as string).length > 200) throw new Error(`objectifs de brigade : ${k} invalide pour « ${id} »`);
    }
    const tiers = o.tiers as unknown;
    if (!Array.isArray(tiers) || tiers.length === 0 || tiers.some((t) => !Number.isInteger(t) || t < 1 || t > 10_000_000)) {
      throw new Error(`objectifs de brigade : paliers invalides pour « ${id} »`);
    }
    for (let i = 1; i < tiers.length; i++) if (tiers[i] <= tiers[i - 1]) throw new Error(`objectifs de brigade : paliers non croissants pour « ${id} »`);
    let minHits: number | undefined;
    if (o.kind !== 'brigade-hits') {
      if (!Number.isInteger(o.minHits) || (o.minHits as number) < 1 || (o.minHits as number) > 1_000_000) throw new Error(`objectifs de brigade : « minHits » invalide pour « ${id} »`);
      minHits = o.minHits as number;
    }
    if (o.kind === 'members-min-hits' && (tiers as number[]).some((t) => t > 10)) {
      // Une brigade compte au plus 10 membres à la fois : un palier au-delà inciterait à faire tourner des comptes.
      throw new Error(`objectifs de brigade : « ${id} » ne peut pas exiger plus de 10 membres`);
    }
    return { id, kind: o.kind as ObjectiveKind, title: o.title as string, description: o.description as string, tiers: tiers as number[], ...(minHits ? { minHits } : {}) };
  });
  const tierLabels = Array.isArray(r.tierLabels) ? (r.tierLabels as unknown[]).map(String) : [];
  const maxTiers = Math.max(...objectives.map((o) => o.tiers.length));
  if (tierLabels.length < maxTiers) throw new Error('objectifs de brigade : « tierLabels » doit nommer chaque palier');
  const titles = Array.isArray(r.titles)
    ? (r.titles as { at?: unknown; title?: unknown }[]).map((t) => {
        if (!Number.isInteger(t?.at) || (t.at as number) < 1 || typeof t.title !== 'string' || !t.title.trim()) throw new Error('objectifs de brigade : titre invalide');
        return { at: t.at as number, title: t.title };
      })
    : [];
  for (let i = 1; i < titles.length; i++) if (titles[i].at <= titles[i - 1].at) throw new Error('objectifs de brigade : titres non croissants');
  return { objectives, tierLabels, titles };
}

export const BRIGADE_OBJECTIVES: BrigadeObjectivesContent = validateBrigadeObjectives(rawContent);

/** Nombre de paliers atteints pour une valeur. */
export function tiersReached(tiers: number[], value: number): number {
  let n = 0;
  while (n < tiers.length && value >= tiers[n]) n++;
  return n;
}

interface Entry {
  seasonId: number;
  memberHits: Map<string, { hits: number; at: number }>;
  /** objectiveId → valeur (membres qualifiés, couches explorées). */
  values: Map<string, number>;
  /** couche → coups de la brigade sur cette couche (plafonné). */
  layerHits: Map<number, number>;
  /** « objectif:palier » déjà débloqués cette saison. */
  unlocked: Set<string>;
}

export interface BrigadeUpdate {
  brigadeId: string;
  /** Distinctions débloquées par ce coup (libellés). */
  unlocked: string[];
}

export class BrigadeObjectiveTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly distinctionCache = new Map<string, BrigadeDistinction[]>();
  private scratch = new Map<string, { entry: Entry; unlocked: string[] }>();
  /** Plafond des coups suivis par couche (au-delà, plus d'écriture pour cette couche). */
  private readonly layerCap: number;

  constructor(
    private readonly store: GameStore,
    readonly content: BrigadeObjectivesContent = BRIGADE_OBJECTIVES,
  ) {
    this.layerCap = Math.max(0, ...content.objectives.filter((o) => o.kind === 'layers-explored').map((o) => o.minHits ?? 0));
  }

  private load(brigadeId: string, seasonId: number): Entry {
    const pending = this.scratch.get(brigadeId);
    if (pending && pending.entry.seasonId === seasonId) return pending.entry;
    const cached = this.entries.get(brigadeId);
    if (cached && cached.seasonId === seasonId) return cached;
    const e: Entry = {
      seasonId,
      memberHits: new Map(this.store.getBrigadeMemberHits(seasonId, brigadeId).map((r) => [r.player_id, { hits: r.hits, at: r.last_hit_at }])),
      values: new Map(this.store.getBrigadeObjectiveValues(seasonId, brigadeId).map((r) => [r.objective_id, r.value])),
      layerHits: new Map(this.store.getBrigadeLayerHits(seasonId, brigadeId).map((r) => [r.layer, r.hits])),
      unlocked: new Set(this.store.listBrigadeDistinctions(brigadeId).filter((d) => d.season_id === seasonId).map((d) => `${d.objective_id}:${d.tier}`)),
    };
    this.entries.set(brigadeId, e);
    return e;
  }

  private clone(e: Entry): Entry {
    return { seasonId: e.seasonId, memberHits: new Map(e.memberHits), values: new Map(e.values), layerHits: new Map(e.layerHits), unlocked: new Set(e.unlocked) };
  }

  private working(brigadeId: string, seasonId: number) {
    let s = this.scratch.get(brigadeId);
    if (!s || s.entry.seasonId !== seasonId) {
      s = { entry: this.clone(this.load(brigadeId, seasonId)), unlocked: [] };
      this.scratch.set(brigadeId, s);
    }
    return s;
  }

  begin() {
    this.scratch.clear();
  }

  abort() {
    this.scratch.clear();
  }

  private checkTiers(brigadeId: string, s: { entry: Entry; unlocked: string[] }, values: Map<string, number>, now: number) {
    for (const o of this.content.objectives) {
      const v = values.get(o.id);
      if (v === undefined) continue;
      const reached = tiersReached(o.tiers, v);
      for (let t = 1; t <= reached; t++) {
        const key = `${o.id}:${t}`;
        if (s.entry.unlocked.has(key)) continue;
        s.entry.unlocked.add(key);
        if (this.store.insertBrigadeDistinction(s.entry.seasonId, brigadeId, o.id, t, now)) s.unlocked.push(`${o.title} ${this.content.tierLabels[t - 1]}`);
      }
    }
  }

  /**
   * Coup accepté d'un membre (dans la transaction du coup).
   * `brigadeHitsAfter` : coups de la brigade cette saison, ce coup compris.
   */
  onHit(seasonId: number, brigadeId: string, playerId: string, layer: number, brigadeHitsAfter: number, now: number) {
    const s = this.working(brigadeId, seasonId);
    const e = s.entry;
    const prev = e.memberHits.get(playerId)?.hits ?? 0;
    e.memberHits.set(playerId, { hits: prev + 1, at: now });
    this.store.addBrigadeMemberHit(seasonId, brigadeId, playerId, now);
    const values = new Map<string, number>();
    for (const o of this.content.objectives) {
      if (o.kind === 'brigade-hits') values.set(o.id, brigadeHitsAfter);
      if (o.kind === 'members-min-hits' && prev + 1 === o.minHits) {
        const v = (e.values.get(o.id) ?? 0) + 1;
        e.values.set(o.id, v);
        this.store.setBrigadeObjectiveValue(seasonId, brigadeId, o.id, v);
        values.set(o.id, v);
      }
    }
    const lh = e.layerHits.get(layer) ?? 0;
    if (lh < this.layerCap) {
      e.layerHits.set(layer, lh + 1);
      this.store.setBrigadeLayerHits(seasonId, brigadeId, layer, lh + 1);
    }
    this.checkTiers(brigadeId, s, values, now);
  }

  /** Couche entièrement détruite (dans la transaction du dernier coup). */
  onLayerCompleted(seasonId: number, layer: number, now: number) {
    const explore = this.content.objectives.filter((o) => o.kind === 'layers-explored');
    if (!explore.length) return;
    const minAll = Math.min(...explore.map((o) => o.minHits!));
    // Les coups de la transaction en cours (pas encore en mémoire) sont lus en base : même transaction.
    for (const { brigade_id: brigadeId, hits } of this.store.brigadesWithLayerHits(seasonId, layer, minAll)) {
      const s = this.working(brigadeId, seasonId);
      const values = new Map<string, number>();
      for (const o of explore) {
        if (hits < o.minHits!) continue;
        const v = (s.entry.values.get(o.id) ?? 0) + 1;
        s.entry.values.set(o.id, v);
        this.store.setBrigadeObjectiveValue(seasonId, brigadeId, o.id, v);
        values.set(o.id, v);
      }
      this.checkTiers(brigadeId, s, values, now);
    }
  }

  commit(): BrigadeUpdate[] {
    const out: BrigadeUpdate[] = [];
    for (const [brigadeId, s] of this.scratch) {
      this.entries.set(brigadeId, s.entry);
      if (s.unlocked.length) this.distinctionCache.delete(brigadeId);
      out.push({ brigadeId, unlocked: s.unlocked });
    }
    this.scratch.clear();
    return out;
  }

  private distinctions(brigadeId: string): BrigadeDistinction[] {
    let d = this.distinctionCache.get(brigadeId);
    if (!d) {
      const titles = new Map(this.content.objectives.map((o) => [o.id, o.title]));
      d = this.store.listBrigadeDistinctions(brigadeId).map((r) => ({
        seasonId: r.season_id,
        seasonName: r.season_name,
        objectiveId: r.objective_id,
        tier: r.tier,
        label: `${titles.get(r.objective_id) ?? r.objective_id} ${this.content.tierLabels[r.tier - 1] ?? r.tier}`,
        unlockedAt: r.unlocked_at,
      }));
      this.distinctionCache.set(brigadeId, d);
    }
    return d;
  }

  /** Identité, contributions et objectifs d'une brigade pour la saison active (ou null). */
  info(
    brigadeId: string,
    brigadeName: string,
    seasonId: number | null,
    totals: { hits: number; blocks: number },
    members: { id: string; name: string }[],
    nameOf: (playerId: string) => string,
  ): BrigadeObjectivesInfo {
    const distinctions = this.distinctions(brigadeId);
    if (seasonId === null) {
      return { emblem: brigadeEmblem(brigadeName), frame: 0, title: null, totals, contributors: [], objectives: [], distinctions };
    }
    const e = this.load(brigadeId, seasonId);
    const current = new Set(members.map((m) => m.id));
    const contributors: BrigadeContributor[] = [...e.memberHits]
      .map(([id, c]) => ({ id, name: nameOf(id), hits: c.hits, member: current.has(id) }))
      .concat(members.filter((m) => !e.memberHits.has(m.id)).map((m) => ({ id: m.id, name: m.name, hits: 0, member: true })))
      .sort((a, b) => b.hits - a.hits || (a.name < b.name ? -1 : 1));
    const objectives: BrigadeObjectiveView[] = this.content.objectives.map((o) => {
      const value = o.kind === 'brigade-hits' ? totals.hits : (e.values.get(o.id) ?? 0);
      return {
        id: o.id,
        title: o.title,
        description: o.description.replace('{minHits}', String(o.minHits ?? '')),
        value,
        tiers: o.tiers,
        reached: tiersReached(o.tiers, value),
        ...(o.kind === 'members-min-hits' ? { minHits: o.minHits } : {}),
      };
    });
    const unlockedCount = e.unlocked.size;
    let title: string | null = null;
    let frame = 0;
    this.content.titles.forEach((t, i) => {
      if (unlockedCount >= t.at) {
        title = t.title;
        frame = i + 1;
      }
    });
    return { emblem: brigadeEmblem(brigadeName), frame, title, totals, contributors, objectives, distinctions };
  }
}
