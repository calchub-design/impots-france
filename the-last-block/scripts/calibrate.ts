/**
 * Propose des paramètres de saison pour une durée visée.
 *
 *   npm run calibrate -- --days 30 --players 200 --minutes 30
 *   npm run calibrate -- --days 30 --players 2000 --minutes 45 --hps 3 --size 32 --target 0.9
 *
 * Bêta courte : matrice de scénarios (15 et 20 invités × activité faible/moyenne/forte)
 *
 *   npm run calibrate -- --beta                       # préréglages recommandés
 *   npm run calibrate -- --beta --size 12 --base 30 --per 6 --hours 48   # paramètres à évaluer
 */
import { BETA_SCENARIOS, calibrate, calibrateShortSeason, evaluateSeason, theoreticalMaxHits, totalHits, type SeasonParams } from '../shared/calibration.js';

function arg(name: string, def?: number): number | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

const RISK: Record<string, string> = { trop_tot: 'TROP TÔT', dans_la_fenetre: 'ok', juste: 'JUSTE', non_termine: 'NON TERMINÉ' };

function matrix(p: SeasonParams, title: string) {
  const total = totalHits(p.cubeSize, p.baseHp, p.hpPerLayer);
  console.log(`\n${title}`);
  console.log(`  CUBE_SIZE=${p.cubeSize} BLOCK_BASE_HP=${p.baseHp} BLOCK_HP_PER_LAYER=${p.hpPerLayer} SEASON_DURATION_HOURS=${p.durationHours}`);
  console.log(`  ${p.cubeSize ** 3} blocs, ${p.baseHp} coups en surface → ${p.baseHp + (p.cubeSize - 1) * p.hpPerLayer} au fond, ${total.toLocaleString('fr-FR')} coups au total`);
  console.log('  invités | scénario | coups/h | fin du cube   | avancement à 48 h | risque');
  for (const invited of [15, 20]) {
    for (const s of BETA_SCENARIOS) {
      const o = evaluateSeason(p, invited, s);
      const fin = o.finishHour === null ? '—' : `${o.finishHour} h`;
      console.log(`  ${String(invited).padStart(7)} | ${s.id.padEnd(8)} | ${String(o.hitsPerHour).padStart(7)} | ${fin.padEnd(13)} | ${String(o.progressAtEndPct).padStart(5)} %           | ${RISK[o.risk]}`);
    }
  }
  const max = theoreticalMaxHits(20, p.durationHours);
  console.log(`  Borne haute (20 invités, 4 h/jour UTC, 5 coups/s) : ${max.toLocaleString('fr-FR')} coups → cube fini en ${((total / max) * p.durationHours).toFixed(1)} h au plus tôt`);
}

if (process.argv.includes('--beta')) {
  const hours = arg('hours', 48)!;
  if (arg('base') !== undefined) {
    matrix({ cubeSize: arg('size', 12)!, baseHp: arg('base')!, hpPerLayer: arg('per', 0)!, durationHours: hours }, 'Paramètres évalués');
  } else {
    const size = arg('size', 12)!;
    for (const [id, invited, title] of [
      ['faible', 15, 'Préréglage PRUDENT (calé sur 15 invités, activité faible)'],
      ['moyenne', 15, 'Préréglage CENTRAL recommandé (calé sur 15 invités, activité moyenne)'],
      ['forte', 20, 'Préréglage SOUTENU (calé sur 20 invités, activité forte)'],
    ] as const) {
      const scenario = BETA_SCENARIOS.find((s) => s.id === id)!;
      matrix(calibrateShortSeason({ invited, scenario, cubeSize: size, durationHours: hours }), title);
    }
  }
  console.log('\nLes scores et classements ne sont jamais ajustés : seuls les paramètres du cube, choisis AVANT le');
  console.log('lancement, déterminent la durée. Pendant la saison, suivre GET /api/season/projection.');
} else {
  const r = calibrate({
    days: arg('days', 30)!,
    dailyActivePlayers: arg('players', 200)!,
    activeMinutesPerPlayer: arg('minutes', 30)!,
    hitsPerSecond: arg('hps'),
    cubeSize: arg('size'),
    depthRatio: arg('ratio'),
    targetFraction: arg('target'),
  });

  console.log(`Coups par jour estimés      : ${r.hitsPerDay.toLocaleString('fr-FR')}`);
  console.log(`Cube                         : ${r.cubeSize}³ = ${(r.cubeSize ** 3).toLocaleString('fr-FR')} blocs`);
  console.log(`Résistance                   : ${r.surfaceHitsPerBlock} coups en surface → ${r.deepestHitsPerBlock} au fond`);
  console.log(`Total de coups pour finir    : ${r.totalHits.toLocaleString('fr-FR')}`);
  console.log(`Fin attendue à ce rythme     : ${r.expectedDays.toFixed(1)} jours`);
  for (const w of r.warnings) console.log(`⚠ ${w}`);
  console.log('\nVariables à reporter dans .env :');
  console.log(`CUBE_SIZE=${r.cubeSize}`);
  console.log(`BLOCK_BASE_HP=${r.baseHp}`);
  console.log(`BLOCK_HP_PER_LAYER=${r.hpPerLayer}`);
  console.log(`SEASON_DURATION_HOURS=${r.seasonDurationHours}`);
  console.log('\nPendant la saison, GET /api/season/projection donne le rythme réel et la date de fin estimée.');
}
