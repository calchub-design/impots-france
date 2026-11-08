import { createHmac, randomBytes } from 'node:crypto';
import type { GameStore } from '../db/store.js';
import { dayKey } from './playtime.js';

/**
 * Statistiques de la bêta privée, calculées à la demande à partir des tables
 * existantes (joueurs, temps actif, coups, missions, brigades) et de trois
 * tables d'observation (sessions, compteurs journaliers, présence à la clôture).
 *
 * - Les comptes de test (invitation de type « test ») sont EXCLUS partout, sauf
 *   des compteurs de refus, agrégés sans identité.
 * - Aucune adresse IP, aucun jeton, aucun pseudo n'est exporté : les joueurs et
 *   brigades sont désignés par un pseudonyme stable (HMAC avec un secret serveur).
 * - Lecture seule : rien n'est modifié, rien n'est recalculé dans le jeu.
 */

const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;

export function pseudonymizer(secret: string) {
  const key = secret || randomBytes(32).toString('hex'); // hors bêta : pseudonymes valables pour ce seul processus
  return (kind: 'J' | 'B', id: string) => `${kind}-${createHmac('sha256', key).update(`${kind}:${id}`).digest('hex').slice(0, 10)}`;
}

/** Valeur CSV sûre : guillemets si nécessaire, et neutralisation des formules (=, +, -, @). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

export class BetaStats {
  private readonly pseudo: (kind: 'J' | 'B', id: string) => string;

  constructor(
    private readonly store: GameStore,
    secret: string,
    private readonly now: () => number,
    private readonly brigadeMinSize: number,
  ) {
    this.pseudo = pseudonymizer(secret);
  }

  private q<T>(sql: string, ...p: (string | number | null)[]) {
    return this.store.query<T>(sql, ...p);
  }

  /** Saison analysée : celle demandée, sinon l'active, sinon la dernière terminée. */
  private season(seasonId?: number) {
    const rows = seasonId !== undefined
      ? this.q<{ id: number; name: string; status: string; starts_at: number; ends_at: number; ended_at: number | null }>('SELECT id, name, status, starts_at, ends_at, ended_at FROM seasons WHERE id = ?', seasonId)
      : this.q<{ id: number; name: string; status: string; starts_at: number; ends_at: number; ended_at: number | null }>(
          "SELECT id, name, status, starts_at, ends_at, ended_at FROM seasons ORDER BY (status = 'active') DESC, id DESC LIMIT 1",
        );
    return rows[0] ?? null;
  }

  /** Premier jour actif et jours actifs de chaque joueur réel. */
  private activity() {
    const rows = this.q<{ player_id: string; day: string; active_ms: number }>(
      'SELECT t.player_id, t.day, t.active_ms FROM playtime t JOIN players p ON p.id = t.player_id WHERE p.is_test = 0 AND t.active_ms > 0 ORDER BY t.day',
    );
    const byPlayer = new Map<string, { days: Set<string>; first: string; ms: number }>();
    for (const r of rows) {
      const e = byPlayer.get(r.player_id) ?? { days: new Set<string>(), first: r.day, ms: 0 };
      e.days.add(r.day);
      e.ms += r.active_ms;
      byPlayer.set(r.player_id, e);
    }
    return { rows, byPlayer };
  }

  /** Retour le lendemain (jour UTC) et retour sous 24 h (nouvelle session entre 1 h et 24 h après la première). */
  private retention(byPlayer: Map<string, { days: Set<string>; first: string }>) {
    const today = dayKey(this.now());
    let eligD1 = 0;
    let retD1 = 0;
    for (const e of byPlayer.values()) {
      const next = dayKey(Date.parse(`${e.first}T00:00:00Z`) + DAY_MS);
      if (next > today) continue; // lendemain pas encore écoulé
      eligD1++;
      if (e.days.has(next)) retD1++;
    }
    const sessions = this.q<{ player_id: string; started_at: number }>(
      'SELECT s.player_id, s.started_at FROM sessions s JOIN players p ON p.id = s.player_id WHERE p.is_test = 0 ORDER BY s.started_at',
    );
    const firsts = new Map<string, number>();
    const later = new Map<string, number[]>();
    for (const s of sessions) {
      if (!firsts.has(s.player_id)) firsts.set(s.player_id, s.started_at);
      else (later.get(s.player_id) ?? later.set(s.player_id, []).get(s.player_id)!).push(s.started_at);
    }
    let elig24 = 0;
    let ret24 = 0;
    for (const [pid, t0] of firsts) {
      const back = (later.get(pid) ?? []).some((t) => t - t0 >= HOUR_MS && t - t0 <= DAY_MS);
      if (back) ret24++;
      if (back || this.now() - t0 >= DAY_MS) elig24++;
    }
    return {
      nextDay: { eligible: eligD1, returned: retD1, ratePct: pct(retD1, eligD1) },
      within24h: { eligible: elig24, returned: ret24, ratePct: pct(ret24, elig24) },
    };
  }

  summary(seasonId?: number) {
    const s = this.season(seasonId);
    const players = this.q<{ total: number; tests: number }>('SELECT SUM(is_test = 0) AS total, SUM(is_test = 1) AS tests FROM players')[0];
    const byInvite = this.q<{ label: string | null; n: number }>(
      'SELECT i.label, COUNT(*) AS n FROM players p LEFT JOIN invites i ON i.id = p.invite_id WHERE p.is_test = 0 GROUP BY i.label ORDER BY i.label',
    );
    const { rows: act, byPlayer } = this.activity();
    const activeDays = new Map<string, { players: number; ms: number }>();
    for (const r of act) {
      const d = activeDays.get(r.day) ?? { players: 0, ms: 0 };
      d.players++;
      d.ms += r.active_ms;
      activeDays.set(r.day, d);
    }
    const sess = this.q<{ day: string; started_at: number; ended_at: number | null }>(
      "SELECT strftime('%Y-%m-%d', s.started_at / 1000, 'unixepoch') AS day, s.started_at, s.ended_at FROM sessions s JOIN players p ON p.id = s.player_id WHERE p.is_test = 0",
    );
    const durations = sess.filter((x) => x.ended_at !== null).map((x) => (x.ended_at! - x.started_at) / 1000);
    const counters = this.q<{ day: string; key: string; value: number }>('SELECT day, key, value FROM daily_counters ORDER BY day, key');
    const sumKey = (pred: (k: string) => boolean) => counters.filter((c) => pred(c.key)).reduce((a, c) => a + c.value, 0);
    const refusedByReason: Record<string, number> = {};
    for (const c of counters) if (c.key.startsWith('refused:')) refusedByReason[c.key.slice(8)] = (refusedByReason[c.key.slice(8)] ?? 0) + c.value;

    let seasonPart: Record<string, unknown> | null = null;
    if (s) {
      const hits = this.q<{ n: number; miners: number }>(
        'SELECT COUNT(*) AS n, COUNT(DISTINCT h.player_id) AS miners FROM hits h JOIN players p ON p.id = h.player_id WHERE h.season_id = ? AND p.is_test = 0',
        s.id,
      )[0];
      const cube = this.q<{ total: number; destroyed: number }>('SELECT COUNT(*) AS total, SUM(hp = 0) AS destroyed FROM blocks WHERE season_id = ?', s.id)[0];
      const missions = this.q<{ mission_id: string; n: number; players: number }>(
        'SELECT m.mission_id, COUNT(*) AS n, COUNT(DISTINCT m.player_id) AS players FROM mission_completions m JOIN players p ON p.id = m.player_id WHERE m.season_id = ? AND p.is_test = 0 GROUP BY m.mission_id ORDER BY m.mission_id',
        s.id,
      );
      const brigades = this.q<{ id: string; members: number; hits: number | null }>(
        `SELECT b.id, (SELECT COUNT(*) FROM brigade_members m WHERE m.brigade_id = b.id) AS members,
                (SELECT hits FROM brigade_contributions c WHERE c.brigade_id = b.id AND c.season_id = ?) AS hits
         FROM brigades b`,
        s.id,
      );
      const inBrigade = this.q<{ n: number }>('SELECT COUNT(*) AS n FROM brigade_members m JOIN players p ON p.id = m.player_id WHERE p.is_test = 0')[0].n;
      const brigadeHits = this.q<{ n: number }>(
        'SELECT COUNT(*) AS n FROM hits h JOIN players p ON p.id = h.player_id WHERE h.season_id = ? AND h.brigade_id IS NOT NULL AND p.is_test = 0',
        s.id,
      )[0].n;
      const closure = this.q<{ connected_players: number; active_last_5_min: number; at: number }>(
        'SELECT connected_players, active_last_5_min, at FROM season_closure_presence WHERE season_id = ?',
        s.id,
      )[0];
      seasonPart = {
        id: s.id,
        name: s.name,
        status: s.status,
        startsAt: s.starts_at,
        endsAt: s.ends_at,
        endedAt: s.ended_at,
        acceptedHits: hits.n,
        miners: hits.miners,
        cube: { destroyedBlocks: cube.destroyed ?? 0, totalBlocks: cube.total, progressPct: pct(cube.destroyed ?? 0, cube.total) },
        missions: missions.map((m) => ({ mission: m.mission_id, completions: m.n, players: m.players })),
        brigades: {
          count: brigades.length,
          qualified: brigades.filter((b) => b.members >= this.brigadeMinSize).length,
          membersHistogram: Object.fromEntries([...new Set(brigades.map((b) => b.members))].sort((a, b) => a - b).map((k) => [k, brigades.filter((b) => b.members === k).length])),
          playersInBrigadePct: pct(inBrigade, players.total ?? 0),
          hitsByBrigadeMembersPct: pct(brigadeHits, hits.n),
        },
        closure: closure ? { connectedPlayers: closure.connected_players, activeLast5Min: closure.active_last_5_min, at: closure.at } : null,
      };
    }
    return {
      generatedAt: this.now(),
      participants: { registered: players.total ?? 0, testAccountsExcluded: players.tests ?? 0, byInvite: byInvite.map((b) => ({ invite: b.label ?? '(sans invitation)', players: b.n })) },
      activePlayersByDay: [...activeDays].map(([day, d]) => ({ day, activePlayers: d.players, activeMinutes: Math.round(d.ms / 60_000) })),
      sessions: {
        count: sess.length,
        medianMinutes: durations.length ? Math.round((median(durations)! / 60) * 10) / 10 : null,
        byDay: Object.entries(sess.reduce<Record<string, number>>((a, x) => ((a[x.day] = (a[x.day] ?? 0) + 1), a), {})).map(([day, n]) => ({ day, sessions: n })),
      },
      retention: this.retention(byPlayer),
      hitsCounters: { accepted: sumKey((k) => k === 'accepted'), duplicates: sumKey((k) => k === 'duplicate'), refused: sumKey((k) => k.startsWith('refused:')), refusedByReason },
      season: seasonPart,
    };
  }

  /** Exports CSV pseudonymisés. */
  exportCsv(table: string, seasonId?: number): string {
    const s = this.season(seasonId);
    const sid = s?.id ?? -1;
    switch (table) {
      case 'players': {
        const { byPlayer } = this.activity();
        const rows = this.q<{ id: string; created_at: number; label: string | null; brigade_id: string | null; hits: number | null; blocks: number | null; sessions: number; missions: number }>(
          `SELECT p.id, p.created_at, i.label, m.brigade_id,
                  c.hits, c.blocks,
                  (SELECT COUNT(*) FROM sessions s WHERE s.player_id = p.id) AS sessions,
                  (SELECT COUNT(*) FROM mission_completions mc WHERE mc.player_id = p.id AND mc.season_id = ?) AS missions
           FROM players p LEFT JOIN invites i ON i.id = p.invite_id LEFT JOIN brigade_members m ON m.player_id = p.id
           LEFT JOIN contributions c ON c.player_id = p.id AND c.season_id = ?
           WHERE p.is_test = 0 ORDER BY p.created_at`,
          sid,
          sid,
        );
        const ret = (pid: string) => {
          const e = byPlayer.get(pid);
          if (!e) return '';
          const next = dayKey(Date.parse(`${e.first}T00:00:00Z`) + DAY_MS);
          return next > dayKey(this.now()) ? '' : e.days.has(next) ? 1 : 0;
        };
        return toCsv(
          rows.map((r) => ({
            joueur: this.pseudo('J', r.id),
            jour_inscription: dayKey(r.created_at),
            invitation: r.label ?? '',
            brigade: r.brigade_id ? this.pseudo('B', r.brigade_id) : '',
            coups_saison: r.hits ?? 0,
            blocs_saison: r.blocks ?? 0,
            jours_actifs: byPlayer.get(r.id)?.days.size ?? 0,
            minutes_actives: Math.round((byPlayer.get(r.id)?.ms ?? 0) / 60_000),
            sessions: r.sessions,
            missions_saison: r.missions,
            premier_jour_actif: byPlayer.get(r.id)?.first ?? '',
            retour_lendemain: ret(r.id),
          })),
          ['joueur', 'jour_inscription', 'invitation', 'brigade', 'coups_saison', 'blocs_saison', 'jours_actifs', 'minutes_actives', 'sessions', 'missions_saison', 'premier_jour_actif', 'retour_lendemain'],
        );
      }
      case 'sessions': {
        const rows = this.q<{ player_id: string; started_at: number; ended_at: number | null }>(
          'SELECT s.player_id, s.started_at, s.ended_at FROM sessions s JOIN players p ON p.id = s.player_id WHERE p.is_test = 0 ORDER BY s.started_at',
        );
        return toCsv(
          rows.map((r) => ({
            joueur: this.pseudo('J', r.player_id),
            debut: new Date(r.started_at).toISOString(),
            fin: r.ended_at ? new Date(r.ended_at).toISOString() : '',
            duree_s: r.ended_at ? Math.round((r.ended_at - r.started_at) / 1000) : '',
          })),
          ['joueur', 'debut', 'fin', 'duree_s'],
        );
      }
      case 'daily': {
        const sum = this.summary(seasonId);
        const counters = this.q<{ day: string; key: string; value: number }>('SELECT day, key, value FROM daily_counters');
        const days = new Set([...sum.activePlayersByDay.map((d) => d.day), ...counters.map((c) => c.day)]);
        const v = (day: string, pred: (k: string) => boolean) => counters.filter((c) => c.day === day && pred(c.key)).reduce((a, c) => a + c.value, 0);
        return toCsv(
          [...days].sort().map((day) => ({
            jour: day,
            joueurs_actifs: sum.activePlayersByDay.find((d) => d.day === day)?.activePlayers ?? 0,
            minutes_actives: sum.activePlayersByDay.find((d) => d.day === day)?.activeMinutes ?? 0,
            sessions: sum.sessions.byDay.find((d) => d.day === day)?.sessions ?? 0,
            coups_acceptes: v(day, (k) => k === 'accepted'),
            doublons: v(day, (k) => k === 'duplicate'),
            coups_refuses: v(day, (k) => k.startsWith('refused:')),
            refus_cadence: v(day, (k) => k === 'refused:rate_limited'),
            refus_limite_4h: v(day, (k) => k === 'refused:daily_limit'),
            invitations_refusees: v(day, (k) => k.startsWith('invite:')),
          })),
          ['jour', 'joueurs_actifs', 'minutes_actives', 'sessions', 'coups_acceptes', 'doublons', 'coups_refuses', 'refus_cadence', 'refus_limite_4h', 'invitations_refusees'],
        );
      }
      case 'cube': {
        const rows = this.q<{ hour: number; destroyed: number; hits: number }>(
          'SELECT (at / 3600000) AS hour, SUM(destroyed) AS destroyed, COUNT(*) AS hits FROM hits WHERE season_id = ? GROUP BY hour ORDER BY hour',
          sid,
        );
        const total = this.q<{ n: number }>('SELECT COUNT(*) AS n FROM blocks WHERE season_id = ?', sid)[0].n;
        let cum = 0;
        return toCsv(
          rows.map((r) => {
            cum += r.destroyed;
            return { heure_utc: new Date(r.hour * HOUR_MS).toISOString(), coups: r.hits, blocs_detruits: r.destroyed, blocs_cumules: cum, progression_pct: pct(cum, total) };
          }),
          ['heure_utc', 'coups', 'blocs_detruits', 'blocs_cumules', 'progression_pct'],
        );
      }
      case 'brigades': {
        const rows = this.q<{ id: string; members: number; hits: number | null; contributors: number }>(
          `SELECT b.id, (SELECT COUNT(*) FROM brigade_members m WHERE m.brigade_id = b.id) AS members,
                  (SELECT hits FROM brigade_contributions c WHERE c.brigade_id = b.id AND c.season_id = ?) AS hits,
                  (SELECT COUNT(*) FROM brigade_member_contributions mc WHERE mc.brigade_id = b.id AND mc.season_id = ?) AS contributors
           FROM brigades b ORDER BY b.created_at`,
          sid,
          sid,
        );
        return toCsv(
          rows.map((r) => ({ brigade: this.pseudo('B', r.id), membres: r.members, qualifiee: r.members >= this.brigadeMinSize ? 1 : 0, coups_saison: r.hits ?? 0, contributeurs: r.contributors })),
          ['brigade', 'membres', 'qualifiee', 'coups_saison', 'contributeurs'],
        );
      }
      default:
        throw new Error('table inconnue');
    }
  }
}

export const EXPORT_TABLES = ['players', 'sessions', 'daily', 'cube', 'brigades'] as const;
