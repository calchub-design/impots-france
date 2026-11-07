import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../server/config.js';
import { SqliteStore } from '../server/db/sqlite.js';
import { GameEngine } from '../server/game/engine.js';
import type { MineResultMessage } from '../shared/protocol.js';
import { tempDbPath, NO_DISCOVERIES } from './helpers.js';
import { TestClient } from './wsClient.js';

/**
 * Arrêts BRUTAUX réels : le serveur tourne dans un processus séparé
 * (`node --import tsx server/index.ts`) et reçoit SIGKILL pendant que des
 * clients minent. Aucun code d'arrêt propre ne s'exécute.
 */

const procs: ChildProcess[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL');
  for (const c of cleanups.splice(0)) c();
});

async function startProcess(dbPath: string, env: Record<string, string> = {}): Promise<{ proc: ChildProcess; port: number }> {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      STATIC_DIR: '/nonexistent',
      CUBE_SIZE: '3',
      // Cube de 3 couches : saison sans découverte, configurée explicitement.
      DISCOVERY_PROFILE: 'none',
      BLOCK_BASE_HP: '4',
      BLOCK_HP_PER_LAYER: '2',
      MAX_CONNECTIONS_PER_IP: '1000',
      NEW_ACCOUNTS_PER_IP_PER_HOUR: '1000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(proc);
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('démarrage trop long : ' + out)), 15_000);
    proc.stdout!.on('data', (d) => {
      out += d.toString();
      const m = /serveur prêt sur http:\/\/[^:]+:(\d+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    proc.stderr!.on('data', (d) => (out += d.toString()));
    proc.once('exit', (code) => reject(new Error(`processus terminé (${code}) : ${out}`)));
  });
  return { proc, port };
}

async function kill9(proc: ChildProcess) {
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGKILL');
  await exited;
}

/** Invariants de cohérence vérifiés directement dans le fichier SQLite. */
function checkInvariants(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  try {
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    const blocks = db
      .prepare(
        `SELECT b.season_id, b.layer, b.idx, b.hp, b.max_hp, b.destroyed_by,
                (SELECT COUNT(*) FROM hits h WHERE h.season_id = b.season_id AND h.layer = b.layer AND h.idx = b.idx) AS n,
                (SELECT player_id FROM hits h WHERE h.season_id = b.season_id AND h.layer = b.layer AND h.idx = b.idx AND h.destroyed = 1) AS killer
         FROM blocks b`,
      )
      .all() as { hp: number; max_hp: number; n: number; destroyed_by: string | null; killer: string | null }[];
    for (const b of blocks) {
      expect(b.hp).toBeGreaterThanOrEqual(0);
      expect(b.hp).toBe(b.max_hp - b.n); // chaque PV perdu correspond à exactement un coup journalisé
      expect(b.destroyed_by).toBe(b.hp === 0 ? b.killer : null);
    }
    const contrib = db
      .prepare(
        `SELECT c.hits, c.blocks,
                (SELECT COUNT(*) FROM hits h WHERE h.season_id = c.season_id AND h.player_id = c.player_id) AS n,
                (SELECT COUNT(*) FROM hits h WHERE h.season_id = c.season_id AND h.player_id = c.player_id AND h.destroyed = 1) AS d
         FROM contributions c`,
      )
      .all() as { hits: number; blocks: number; n: number; d: number }[];
    for (const c of contrib) expect([c.hits, c.blocks]).toEqual([c.n, c.d]);
    const orphan = db.prepare('SELECT COUNT(*) AS n FROM hits h WHERE NOT EXISTS (SELECT 1 FROM contributions c WHERE c.season_id = h.season_id AND c.player_id = h.player_id)').get() as { n: number };
    expect(orphan.n).toBe(0);
    const brig = db
      .prepare(
        `SELECT bc.hits, (SELECT COUNT(*) FROM hits h WHERE h.season_id = bc.season_id AND h.brigade_id = bc.brigade_id) AS n
         FROM brigade_contributions bc`,
      )
      .all() as { hits: number; n: number }[];
    for (const b of brig) expect(b.hits).toBe(b.n);
    const active = db.prepare("SELECT COUNT(*) AS n FROM seasons WHERE status = 'active'").get() as { n: number };
    expect(active.n).toBeLessThanOrEqual(1);
    return {
      hits: (db.prepare('SELECT COUNT(*) AS n FROM hits').get() as { n: number }).n,
      hit: (playerId: string, actionId: string) => {
        const d = new DatabaseSync(dbPath);
        try {
          return d.prepare('SELECT hp_after, layer, idx FROM hits WHERE player_id = ? AND action_id = ?').get(playerId, actionId) as
            | { hp_after: number; layer: number; idx: number }
            | undefined;
        } finally {
          d.close();
        }
      },
    };
  } finally {
    db.close();
  }
}

describe('arrêt brutal (SIGKILL) pendant le minage', () => {
  it('aucun coup confirmé perdu, état cohérent, reprise complète des comptes, brigades, scores et blocs', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    let { proc, port } = await startProcess(db.path);
    const url = () => `ws://127.0.0.1:${port}/ws`;

    // 12 joueurs, dont 5 dans une brigade.
    const players = Array.from({ length: 12 }, () => new TestClient(url()));
    await Promise.all(players.map((p, i) => p.connect(undefined, `Mineur ${i}`)));
    players[0].send({ t: 'brigadeCreate', name: 'Survivants' });
    const created = await players[0].waitFor((m) => m.t === 'brigade' && m.brigade !== null);
    const code = created.t === 'brigade' ? created.brigade!.inviteCode : '';
    for (const p of players.slice(1, 5)) {
      p.send({ t: 'brigadeJoin', code });
      await p.waitFor((m) => m.t === 'brigade' && m.brigade !== null);
    }

    // Minage continu ; on note chaque coup CONFIRMÉ par le serveur.
    const acked: { player: number; actionId: string; res: MineResultMessage }[] = [];
    const sent: { player: number; actionId: string; layer: number; block: number }[] = [];
    let layer = 0;
    let stop = false;
    let n = 0;
    const loops = players.map(async (p, i) => {
      while (!stop) {
        const actionId = `crash-${i}-${n++}`;
        const block = Math.floor(Math.random() * 9);
        sent.push({ player: i, actionId, layer, block });
        const res = await p.mine(layer, block, actionId).catch(() => null);
        if (!res) break;
        if (res.ok) acked.push({ player: i, actionId, res });
        if (res.reason === 'already_destroyed' || res.reason === 'layer_locked') {
          const l = [...p.received].reverse().find((m) => m.t === 'layer');
          if (l && l.t === 'layer') layer = l.cube.currentLayer;
        }
        await new Promise((r) => setTimeout(r, 210));
      }
    });
    await new Promise((r) => setTimeout(r, 1800));
    await kill9(proc); // en plein vol
    stop = true;
    await Promise.allSettled(loops);
    expect(acked.length).toBeGreaterThan(20);

    // 1) Base cohérente et chaque coup confirmé est bien journalisé.
    const inv = checkInvariants(db.path);
    for (const a of acked) {
      const row = inv.hit(players[a.player].welcome.player.id, a.actionId);
      expect(row, a.actionId).toBeDefined();
      expect(row!.hp_after).toBe(a.res.hpAfter);
    }

    // 2) Redémarrage : mêmes comptes, scores, brigade et blocs.
    ({ proc, port } = await startProcess(db.path));
    const reopened = players.map((p) => new TestClient(url()));
    const welcomes = await Promise.all(reopened.map((c, i) => c.connect(players[i].token)));
    const check = new DatabaseSync(db.path);
    const season = check.prepare("SELECT id FROM seasons WHERE status = 'active'").get() as { id: number };
    welcomes.forEach((w, i) => {
      expect(w.player.id).toBe(players[i].welcome.player.id);
      expect(w.player.name).toBe(`Mineur ${i}`);
      const c = check.prepare('SELECT hits FROM contributions WHERE season_id = ? AND player_id = ?').get(season.id, w.player.id) as { hits: number } | undefined;
      expect(w.me.hits).toBe(c?.hits ?? 0);
      if (i < 5) expect(w.brigade).toMatchObject({ name: 'Survivants', inviteCode: code, members: expect.any(Array) });
      else expect(w.brigade).toBeNull();
    });
    expect(welcomes[0].brigade!.members).toHaveLength(5);
    const cur = welcomes[0].cube!;
    const hpRows = check.prepare('SELECT idx, hp FROM blocks WHERE season_id = ? AND layer = ?').all(season.id, cur.currentLayer) as { idx: number; hp: number }[];
    for (const r of hpRows) expect(cur.currentHp[r.idx]).toBe(r.hp);
    check.close();

    // 3) Renvoi de TOUTES les actions envoyées avant le crash (confirmées ou non) :
    // les confirmées sont des doublons ; aucune n'est appliquée deux fois.
    const before = checkInvariants(db.path).hits;
    let fresh = 0;
    for (const s of sent.slice(-60)) {
      const r = await reopened[s.player].mine(s.layer, s.block, s.actionId);
      if (acked.some((a) => a.actionId === s.actionId)) expect(r).toMatchObject({ ok: true, duplicate: true });
      if (r.ok && !r.duplicate) fresh++;
      await new Promise((res) => setTimeout(res, 40));
    }
    expect(checkInvariants(db.path).hits).toBe(before + fresh);
    await Promise.all(reopened.map((c) => c.close()));
    await kill9(proc);
  }, 60_000);

  it('saisons archivées et classements finaux conservés après SIGKILL', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    let { proc, port } = await startProcess(db.path, { ADMIN_TOKEN: 'admin-secret-token', SEASON_COOLDOWN_SECONDS: '3600' });
    const a = new TestClient(`ws://127.0.0.1:${port}/ws`);
    await a.connect(undefined, 'Archiviste');
    for (let i = 0; i < 3; i++) await a.mine(0, i);
    const end = await fetch(`http://127.0.0.1:${port}/api/admin/season/end`, { method: 'POST', headers: { authorization: 'Bearer admin-secret-token' } });
    expect(end.status).toBe(200);
    await a.close();
    await kill9(proc);

    ({ proc, port } = await startProcess(db.path, { SEASON_COOLDOWN_SECONDS: '3600' }));
    const seasons = await (await fetch(`http://127.0.0.1:${port}/api/seasons`)).json();
    expect(seasons.seasons[0]).toMatchObject({ status: 'ended', endReason: 'admin', championName: 'Archiviste' });
    // Le délai inter-saison d'une heure est respecté malgré le redémarrage.
    expect(seasons.seasons).toHaveLength(1);
    expect(seasons.nextSeasonAt).toBeGreaterThan(Date.now() + 3500_000);
    const res = await (await fetch(`http://127.0.0.1:${port}/api/seasons/${seasons.seasons[0].id}`)).json();
    expect(res.players).toEqual([{ rank: 1, name: 'Archiviste', hits: 3 }]);
    checkInvariants(db.path);
    await kill9(proc);
  }, 60_000);
});

describe('fenêtres de crash entre deux transactions', () => {
  it('régression : dernier bloc validé mais saison non clôturée → clôture au redémarrage avec la bonne Pierre finale', () => {
    const db = tempDbPath();
    try {
      const st = new SqliteStore(db.path);
      const season = st.createSeason({ name: 'S', cubeSize: 1, baseHp: 2, hpPerLayer: 0, startsAt: 0, endsAt: 9e15 });
      for (const [id, name] of [['p1', 'Premier'], ['p2', 'Dernier']]) {
        st.createPlayer({ id, name, nameKey: name.toLowerCase(), tokenHash: null, skin: 'classic', authProvider: 'guest', createdAt: 0 });
      }
      let at = 1000;
      for (const [pid, aid] of [['p1', 'hit-aaaa-1'], ['p2', 'hit-bbbb-2']]) {
        st.transaction(() => {
          const hp = st.damageBlock(season.id, 0, 0, pid, at)!;
          st.insertHit({ season_id: season.id, player_id: pid, action_id: aid, layer: 0, idx: 0, hp_after: hp, destroyed: hp === 0 ? 1 : 0, brigade_id: null, at });
          st.addContribution(season.id, pid, hp === 0, at);
        });
        at += 1000;
      }
      st.close(); // « crash » : endSeason n'a jamais été exécuté

      const st2 = new SqliteStore(db.path);
      const engine = new GameEngine(st2, { ...DEFAULT_RULES, autoStartSeason: false, ...NO_DISCOVERIES }, { now: () => 99_000 });
      expect(engine.activeSeason).toBeNull();
      const s = st2.getSeason(season.id)!;
      expect(s).toMatchObject({ status: 'ended', end_reason: 'completed', final_stone_player_id: 'p2', ended_at: 2000 });
      const info = engine.seasonInfo(s);
      expect(info.finalStoneName).toBe('Dernier');
      expect(info.championName).toBe('Premier'); // égalité 1-1 : le premier à atteindre le score
      expect(engine.seasonResults(season.id)!.players).toHaveLength(2);
      st2.close();
    } finally {
      db.cleanup();
    }
  });

  it('régression : le délai inter-saison est respecté après redémarrage', () => {
    const db = tempDbPath();
    try {
      let t = 1_000_000;
      const rules = { ...DEFAULT_RULES, ...NO_DISCOVERIES, cubeSize: 2, autoStartSeason: true, seasonCooldownMs: 3600_000 };
      const s1 = new SqliteStore(db.path);
      const e1 = new GameEngine(s1, rules, { now: () => t });
      e1.tick();
      e1.endSeason('admin');
      s1.close();
      t += 1000;
      const s2 = new SqliteStore(db.path);
      const e2 = new GameEngine(s2, rules, { now: () => t });
      e2.tick();
      expect(e2.activeSeason).toBeNull();
      expect(e2.upcomingSeasonAt).toBe(1_000_000 + 3600_000);
      t = 1_000_000 + 3600_000;
      e2.tick();
      expect(e2.activeSeason?.name).toBe('Saison 2');
      s2.close();
    } finally {
      db.cleanup();
    }
  });

  it('échéance dépassée pendant l\'arrêt : clôture datée de l\'échéance, pas du redémarrage', () => {
    const db = tempDbPath();
    try {
      let t = 0;
      const rules = { ...DEFAULT_RULES, ...NO_DISCOVERIES, cubeSize: 2, autoStartSeason: false, seasonDurationMs: 3600_000 };
      const s1 = new SqliteStore(db.path);
      new GameEngine(s1, rules, { now: () => t }).startSeason();
      s1.close();
      t = 10 * 3600_000;
      const s2 = new SqliteStore(db.path);
      const e2 = new GameEngine(s2, rules, { now: () => t });
      e2.tick();
      expect(e2.listSeasons()[0]).toMatchObject({ status: 'ended', endReason: 'timeout', endedAt: 3600_000 });
      s2.close();
    } finally {
      db.cleanup();
    }
  });
});

describe('arrêt brutal (SIGKILL) et découvertes collectives', () => {
  it('découvertes confirmées conservées à l\'identique, aucune en double, aucune révélée pour une couche inachevée', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    // Cube de 4 couches de 4 × 4 blocs à 1 PV, profil de démonstration : un fragment par couche.
    const env = { CUBE_SIZE: '4', BLOCK_BASE_HP: '1', BLOCK_HP_PER_LAYER: '0', DISCOVERY_PROFILE: 'mini-48h', MAX_ACTIONS_PER_SECOND: '100' };
    let { proc, port } = await startProcess(db.path, env);
    const A = new TestClient(`ws://127.0.0.1:${port}/ws`);
    const B = new TestClient(`ws://127.0.0.1:${port}/ws`);
    await A.connect(undefined, 'Alpha');
    await B.connect(undefined, 'Bravo');
    for (let layer = 0; layer < 2; layer++) {
      for (let i = 0; i < 16; i++) expect((await A.mine(layer, i)).ok).toBe(true);
    }
    const isPred = (m: { t: string; fragment?: { id: string } }) => m.t === 'discovery' && m.fragment?.id === 'predecessors';
    if (!B.received.some(isPred)) await B.waitFor(isPred);
    const seen = B.received.filter((m) => m.t === 'discovery').map((m) => (m.t === 'discovery' ? m.fragment : null));
    expect(seen.map((f) => f!.id)).toEqual(['echo', 'predecessors']);
    // Rafale sur la couche 3 (sans attendre les réponses), puis SIGKILL en plein vol.
    for (let i = 0; i < 15; i++) A.send({ t: 'mine', actionId: `rafale-${i}-xxxxxxxx`, layer: 2, block: i });
    await new Promise((r) => setTimeout(r, 15));
    await kill9(proc);
    await A.close().catch(() => {});
    await B.close().catch(() => {});

    ({ proc, port } = await startProcess(db.path, env));
    const C = new TestClient(`ws://127.0.0.1:${port}/ws`);
    const w = await C.connect(undefined, 'Charlie');
    const log = w.discoveries!;
    const revealed = log.fragments.filter((f) => f.revealed);
    expect(revealed.map((f) => f.id)).toEqual(['echo', 'predecessors']);
    // Mêmes dates de révélation qu'avant l'arrêt brutal.
    expect(revealed.map((f) => f.revealedAt)).toEqual(seen.map((f) => f!.revealedAt));
    expect(w.cube!.currentLayer).toBe(2);
    await C.close();
    await kill9(proc);

    checkInvariants(db.path);
    const raw = new DatabaseSync(db.path);
    try {
      const rows = raw
        .prepare(
          `SELECT d.layer, d.revealed_at, (SELECT COUNT(*) FROM blocks b WHERE b.season_id = d.season_id AND b.layer = d.layer AND b.hp > 0) AS alive
           FROM discoveries d ORDER BY d.ord`,
        )
        .all() as { layer: number; revealed_at: number | null; alive: number }[];
      expect(rows).toHaveLength(4);
      // Révélée si et seulement si la couche est entièrement détruite.
      for (const r of rows) expect(r.revealed_at !== null).toBe(r.alive === 0);
    } finally {
      raw.close();
    }
  }, 60_000);
});
