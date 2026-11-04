/**
 * Propose des paramètres de saison pour une durée visée.
 *
 *   npm run calibrate -- --days 30 --players 200 --minutes 30
 *   npm run calibrate -- --days 30 --players 2000 --minutes 45 --hps 3 --size 32 --target 0.9
 */
import { calibrate } from '../shared/calibration.js';

function arg(name: string, def?: number): number | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

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
