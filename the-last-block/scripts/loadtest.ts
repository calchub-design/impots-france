/**
 * Test de charge simple : N robots (un compte chacun) minent à ~4,5 coups/s.
 *
 *   npm run loadtest -- --bots 100 --seconds 20
 *   npm run loadtest -- --url ws://localhost:8080/ws --bots 50
 *
 * Sans --url, un serveur est démarré dans ce processus avec une base
 * temporaire (le client et le serveur partagent alors le même CPU : les
 * chiffres sont pessimistes et ne valent que pour cette machine).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.js';
import { startGameServer, type GameServer } from '../server/net/gameServer.js';
import { TestClient } from '../tests/wsClient.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const bots = Number(arg('bots', '50'));
const seconds = Number(arg('seconds', '15'));
const intervalMs = Number(arg('interval', '220'));
let url = arg('url', '');

function pct(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  let server: GameServer | null = null;
  let dir: string | null = null;
  if (!url) {
    dir = mkdtempSync(join(tmpdir(), 'tlb-load-'));
    const config = loadConfig({ ...process.env, PORT: '0', HOST: '127.0.0.1', DB_PATH: join(dir, 'load.sqlite'), CUBE_SIZE: '32', BLOCK_BASE_HP: '40' });
    server = await startGameServer({ config });
    url = `ws://127.0.0.1:${server.port}/ws`;
  }
  console.log(`→ ${bots} robots, ${seconds} s, un coup toutes les ${intervalMs} ms par robot, cible ${url}`);

  const clients: TestClient[] = [];
  const t0 = Date.now();
  for (let i = 0; i < bots; i += 25) {
    const batch = Array.from({ length: Math.min(25, bots - i) }, () => new TestClient(url));
    await Promise.all(batch.map((c, k) => c.connect(undefined, `Robot ${i + k}`)));
    clients.push(...batch);
  }
  console.log(`  connexions établies en ${Date.now() - t0} ms`);

  const latencies: number[] = [];
  const reasons: Record<string, number> = {};
  let accepted = 0;
  let errors = 0;
  const end = Date.now() + seconds * 1000;

  await Promise.all(
    clients.map(async (c, i) => {
      await new Promise((r) => setTimeout(r, (i * 37) % intervalMs));
      while (Date.now() < end) {
        const cube = c.welcome.cube;
        const layerMsg = [...c.received].reverse().find((m) => m.t === 'layer' || m.t === 'welcome');
        const layer = layerMsg && 'cube' in layerMsg && layerMsg.cube ? layerMsg.cube.currentLayer : (cube?.currentLayer ?? 0);
        const size = cube?.size ?? 1;
        const block = Math.floor(Math.random() * size * size);
        const start = performance.now();
        try {
          const r = await c.mine(layer, block);
          latencies.push(performance.now() - start);
          if (r.ok) accepted++;
          else reasons[r.reason ?? '?'] = (reasons[r.reason ?? '?'] ?? 0) + 1;
        } catch {
          errors++;
        }
        // Évite d'accumuler l'historique en mémoire.
        if (c.received.length > 200) c.received.splice(0, c.received.length - 50);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }),
  );

  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  console.log('\nRésultats');
  console.log(`  requêtes de minage répondues : ${total} (${(total / seconds).toFixed(0)}/s)`);
  console.log(`  coups acceptés               : ${accepted} (${(accepted / seconds).toFixed(0)}/s)`);
  console.log(`  refus                        : ${JSON.stringify(reasons)}`);
  console.log(`  délais d'attente / erreurs   : ${errors}`);
  console.log(`  latence aller-retour (ms)    : p50 ${pct(latencies, 50).toFixed(1)} · p95 ${pct(latencies, 95).toFixed(1)} · p99 ${pct(latencies, 99).toFixed(1)} · max ${(latencies.at(-1) ?? 0).toFixed(1)}`);
  if (server) console.log(`  serveur                      : ${JSON.stringify(server.stats())}`);

  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  if (server) await server.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
