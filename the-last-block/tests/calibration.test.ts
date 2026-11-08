import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.js';
import type { EngineEvent } from '../server/game/engine.js';
import { BETA_SCENARIOS, calibrate, calibrateShortSeason, evaluateSeason, hitsPerHour, theoreticalMaxHits, totalHits } from '../shared/calibration.js';
import { aid, makeEngine, newPlayer } from './helpers.js';

const DAY = 24 * 3600_000;

describe('calibrage des saisons', () => {
  it('la formule du total de coups correspond aux blocs réellement créés', () => {
    const { engine, store } = makeEngine({ autoStartSeason: false });
    for (const [size, base, per] of [[1, 1, 0], [3, 4, 2], [7, 10, 3], [12, 445, 29]] as const) {
      if (engine.activeSeason) engine.endSeason('admin');
      const s = engine.startSeason({ cubeSize: size, baseHp: base, hpPerLayer: per });
      const sum = store.loadBlockHp(s.id).reduce((acc, b) => acc + b.hp, 0);
      expect(sum).toBe(totalHits(size, base, per));
      expect(engine.projection()!.totalHits).toBe(sum);
    }
  });

  it('propose des paramètres donnant ~30 jours pour des hypothèses variées', () => {
    for (const players of [20, 200, 2000, 20000]) {
      for (const minutes of [15, 60, 240]) {
        const r = calibrate({ days: 30, dailyActivePlayers: players, activeMinutesPerPlayer: minutes, targetFraction: 1 });
        expect(r.seasonDurationHours).toBe(720);
        expect(r.expectedDays, `${players} joueurs × ${minutes} min`).toBeGreaterThan(30 * 0.9);
        expect(r.expectedDays).toBeLessThan(30 * 1.1);
        expect(r.deepestHitsPerBlock).toBeGreaterThanOrEqual(r.surfaceHitsPerBlock);
      }
    }
  });

  it('activité trop faible pour un grand cube : taille réduite automatiquement', () => {
    const r = calibrate({ days: 30, dailyActivePlayers: 1, activeMinutesPerPlayer: 1, hitsPerSecond: 1 });
    expect(r.cubeSize).toBeLessThan(32);
    expect(r.baseHp).toBeGreaterThanOrEqual(1);
  });

  it('une saison de 30 jours (720 h) est acceptée par la configuration et l\'API', () => {
    const cfg = loadConfig({ SEASON_DURATION_HOURS: '720', CUBE_SIZE: '32', BLOCK_BASE_HP: '445', BLOCK_HP_PER_LAYER: '29' });
    expect(cfg.rules.seasonDurationMs).toBe(30 * DAY);
    const { engine } = makeEngine({ ...cfg.rules, autoStartSeason: false });
    const s = engine.startSeason();
    expect(s.ends_at - s.starts_at).toBe(30 * DAY);
    expect(engine.projection()!.totalHits).toBe(totalHits(32, 445, 29));
  });

  it('simulation de 30 jours : fin du cube proche de la date prévue, limites quotidiennes appliquées chaque jour', () => {
    // Petit cube calibré pour 3 joueurs jouant 2 min/jour à 4 coups/s.
    const plan = calibrate({ days: 30, dailyActivePlayers: 3, activeMinutesPerPlayer: 2, hitsPerSecond: 4, cubeSize: 4, targetFraction: 0.9 });
    const { engine, clock, store } = makeEngine({
      autoStartSeason: false,
      cubeSize: plan.cubeSize,
      baseHp: plan.baseHp,
      hpPerLayer: plan.hpPerLayer,
      seasonDurationMs: 30 * DAY,
      dailyActiveLimitMs: 2 * 60_000, // la limite quotidienne du test = 2 min
    });
    clock.t = Date.UTC(2026, 2, 1, 0, 0, 0);
    const start = clock.t;
    const season = engine.startSeason();
    let ended: Extract<EngineEvent, { type: 'seasonEnded' }> | null = null;
    engine.on((e) => {
      if (e.type === 'seasonEnded') ended = e;
    });
    const players = [newPlayer(engine, 'Ana'), newPlayer(engine, 'Bao'), newPlayer(engine, 'Cyd')];
    let projectionDay10: number | null = null;
    let refusedForLimit = 0;

    for (let day = 0; day < 31 && !ended; day++) {
      players.forEach((p, k) => {
        // Chaque joueur joue à une heure différente et tente 3 minutes : la 3e est refusée.
        clock.t = start + day * DAY + (9 + 4 * k) * 3600_000;
        for (let i = 0; i < 3 * 60 * 4 && !ended; i++) {
          const cube = engine.cubeSnapshot();
          if (!cube) break;
          const target = cube.currentHp.findIndex((hp) => hp > 0);
          const r = engine.mine(p, { actionId: aid(), layer: cube.currentLayer, block: target });
          if (!r.ok && r.reason === 'daily_limit') refusedForLimit++;
          clock.advance(250);
        }
        expect(engine.playtime(p).usedMs).toBeLessThanOrEqual(2 * 60_000);
      });
      if (day === 10) {
        clock.t = start + 11 * DAY;
        projectionDay10 = engine.projection()!.projectedCompletionAt;
      }
    }

    expect(ended).not.toBeNull();
    const e = ended! as Extract<EngineEvent, { type: 'seasonEnded' }>;
    const daysTaken = (e.season.endedAt! - start) / DAY;
    expect(e.season.endReason).toBe('completed');
    expect(daysTaken).toBeGreaterThan(plan.expectedDays - 1.5);
    expect(daysTaken).toBeLessThan(plan.expectedDays + 1.5);
    // Achèvement anticipé : l'avance sur l'échéance est explicite.
    expect(e.season.completedEarlyMs).toBe(season.ends_at - e.season.endedAt!);
    expect(e.season.completedEarlyMs!).toBeGreaterThan(DAY);
    expect(e.season.finalStoneName).toMatch(/^(Ana|Bao|Cyd)$/);
    // L'estimation du 11e jour visait juste à ±2 jours.
    expect(Math.abs(projectionDay10! - e.season.endedAt!)).toBeLessThan(2 * DAY);
    // La limite quotidienne a joué chaque jour pour chaque joueur.
    expect(refusedForLimit).toBeGreaterThan(3 * 25 * 200);
    expect(store.getPlaytime(players[0], '2026-03-05')).toBe(2 * 60_000);
  });

  it('cube non terminé au bout de 30 jours : fin par échéance, sans Pierre finale', () => {
    const { engine, clock } = makeEngine({ autoStartSeason: true, cubeSize: 4, baseHp: 1000, seasonDurationMs: 30 * DAY, seasonCooldownMs: 3600_000 });
    engine.tick();
    const p = newPlayer(engine, 'Solo');
    for (let d = 0; d < 30; d++) {
      engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
      clock.advance(DAY - 1);
      engine.tick();
    }
    clock.advance(30);
    engine.tick();
    const s = engine.listSeasons()[0];
    expect(s).toMatchObject({ status: 'ended', endReason: 'timeout', finalStoneName: null, championName: 'Solo', completedEarlyMs: null });
    expect(engine.upcomingSeasonAt).toBe(s.endedAt! + 3600_000);
  });

  it('achèvement anticipé : la saison suivante démarre après le délai, avec une nouvelle échéance complète', () => {
    const { engine, clock } = makeEngine({ autoStartSeason: true, cubeSize: 1, baseHp: 1, seasonDurationMs: 30 * DAY, seasonCooldownMs: 6 * 3600_000 });
    engine.tick();
    clock.advance(3 * DAY);
    const p = newPlayer(engine);
    engine.mine(p, { actionId: aid(), layer: 0, block: 0 });
    const first = engine.listSeasons()[0];
    expect(first).toMatchObject({ endReason: 'completed', completedEarlyMs: 27 * DAY });
    clock.advance(6 * 3600_000);
    engine.tick();
    const second = engine.activeSeason!;
    expect(second.name).toBe('Saison 2');
    expect(second.ends_at - second.starts_at).toBe(30 * DAY);
  });
});

describe('calibrage de la bêta 48 h', () => {
  const scen = (id: string) => BETA_SCENARIOS.find((s) => s.id === id)!;

  it('chaque préréglage termine vers la 36e heure dans le scénario sur lequel il est calé', () => {
    for (const [id, invited] of [['faible', 15], ['moyenne', 15], ['moyenne', 20], ['forte', 20]] as const) {
      for (const cubeSize of [12, 16]) {
        const p = calibrateShortSeason({ invited, scenario: scen(id), cubeSize });
        const o = evaluateSeason(p, invited, scen(id));
        expect(o.risk, `${id}/${invited}/${cubeSize}`).toBe('dans_la_fenetre');
        expect(o.finishHour!).toBeGreaterThan(48 * 0.6);
        expect(o.finishHour!).toBeLessThan(48 * 0.9);
        expect(p.durationHours).toBe(48);
      }
    }
  });

  it('documente les deux risques : un préréglage central ne couvre pas les extrêmes', () => {
    const p = calibrateShortSeason({ invited: 15, scenario: scen('moyenne'), cubeSize: 12 });
    expect(evaluateSeason(p, 15, scen('faible')).risk).toBe('non_termine');
    expect(evaluateSeason(p, 15, scen('faible')).progressAtEndPct).toBeLessThan(50);
    expect(evaluateSeason(p, 20, scen('forte')).risk).toBe('trop_tot');
    expect(evaluateSeason(p, 20, scen('forte')).finishHour!).toBeLessThan(24);
  });

  it('seuils de risque et borne haute théorique', () => {
    const s = { id: 'x', label: 'x', activeShare: 1, minutesPerDay: 24, hitsPerSecond: 1 }; // 1 joueur, 24 min/jour → 1 440 coups/jour
    expect(hitsPerHour(1, s)).toBe(60); // 24 min × 60 s ÷ 24 h
    const params = (total: number) => ({ cubeSize: 1, baseHp: total, hpPerLayer: 0, durationHours: 48 });
    expect(evaluateSeason(params(60 * 20), 1, s).risk).toBe('trop_tot');
    expect(evaluateSeason(params(60 * 30), 1, s).risk).toBe('dans_la_fenetre');
    expect(evaluateSeason(params(60 * 46), 1, s).risk).toBe('juste');
    const late = evaluateSeason(params(60 * 96), 1, s);
    expect(late).toMatchObject({ risk: 'non_termine', finishHour: null, progressAtEndPct: 50 });
    // 48 h hors minuit UTC = 3 jours UTC = 12 h de jeu maximum ; à minuit = 8 h.
    expect(theoreticalMaxHits(20)).toBe(20 * 12 * 3600 * 5);
    expect(theoreticalMaxHits(20, 48, true)).toBe(20 * 8 * 3600 * 5);
  });
});
