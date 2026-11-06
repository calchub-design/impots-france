import { DISCOVERY_CONTENT, isKnownProfile } from './game/discoveries.js';

/**
 * Configuration centralisée, lue depuis les variables d'environnement.
 * Voir `.env.example` pour la liste commentée.
 */

export interface GameRules {
  cubeSize: number;
  baseHp: number;
  hpPerLayer: number;
  seasonDurationMs: number;
  maxActionsPerSecond: number;
  rateWindowMs: number;
  dailyActiveLimitMs: number;
  /**
   * Fenêtre d'activité : chaque coup accepté rend le joueur « actif » pendant
   * cette durée. Le temps actif est la réunion de ces fenêtres (voir playtime.ts).
   */
  idleGapMs: number;
  brigadeMinSize: number;
  brigadeMaxSize: number;
  autoStartSeason: boolean;
  seasonCooldownMs: number;
  leaderboardSize: number;
  /**
   * Profil de découvertes collectives des nouvelles saisons (`server/content/discoveries.json`),
   * ou « none ». Un profil incompatible avec la taille du cube est signalé (journal du serveur,
   * archives) et la saison démarre sans découverte : jamais deux fragments sur une même couche.
   */
  discoveryProfile: string;
}

export interface DonationSettings {
  enabled: boolean;
  associationName: string;
  associationUrl: string;
  note: string;
}

export interface SecuritySettings {
  /** Lire l'IP client dans X-Forwarded-For (uniquement derrière un proxy de confiance). */
  trustProxy: boolean;
  maxConnectionsPerIp: number;
  maxConnectionsPerAccount: number;
  newAccountsPerIpPerHour: number;
  sqliteSynchronous: 'NORMAL' | 'FULL';
}

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  adminToken: string;
  allowedOrigins: string[];
  staticDir: string;
  rules: GameRules;
  security: SecuritySettings;
  donation: DonationSettings;
  auth: { googleClientId: string; appleClientId: string };
}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Variable ${key} invalide: "${raw}" (entier attendu entre ${min} et ${max})`);
  }
  return n;
}

function bool(env: Env, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'oui', 'on'].includes(raw.toLowerCase());
}

function str(env: Env, key: string, def: string): string {
  const raw = env[key];
  return raw === undefined ? def : raw;
}

function discoveryProfile(env: Env): string {
  const v = str(env, 'DISCOVERY_PROFILE', 'standard').trim() || 'standard';
  if (!isKnownProfile(v)) throw new Error(`Variable DISCOVERY_PROFILE invalide: "${v}" (profils : none, ${Object.keys(DISCOVERY_CONTENT.profiles).join(', ')})`);
  return v;
}

export const DEFAULT_RULES: GameRules = {
  // 32 × 32 blocs par couche : une surface bien plus grande que l'écran (refonte « cube colossal »).
  cubeSize: 32,
  baseHp: 3,
  hpPerLayer: 1,
  seasonDurationMs: 7 * 24 * 3600_000,
  maxActionsPerSecond: 5,
  rateWindowMs: 1000,
  dailyActiveLimitMs: 4 * 3600_000,
  idleGapMs: 5_000,
  brigadeMinSize: 5,
  brigadeMaxSize: 10,
  autoStartSeason: true,
  seasonCooldownMs: 60_000,
  leaderboardSize: 10,
  discoveryProfile: 'standard',
};

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    port: int(env, 'PORT', 8080, 0, 65535),
    host: str(env, 'HOST', '0.0.0.0'),
    dbPath: str(env, 'DB_PATH', './data/lastblock.sqlite'),
    adminToken: str(env, 'ADMIN_TOKEN', ''),
    allowedOrigins: str(env, 'ALLOWED_ORIGINS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    staticDir: str(env, 'STATIC_DIR', './dist/client'),
    rules: {
      cubeSize: int(env, 'CUBE_SIZE', DEFAULT_RULES.cubeSize, 1, 64),
      baseHp: int(env, 'BLOCK_BASE_HP', DEFAULT_RULES.baseHp, 1, 1_000_000),
      hpPerLayer: int(env, 'BLOCK_HP_PER_LAYER', DEFAULT_RULES.hpPerLayer, 0, 1_000_000),
      seasonDurationMs: int(env, 'SEASON_DURATION_HOURS', 168, 1, 24 * 366) * 3600_000,
      maxActionsPerSecond: int(env, 'MAX_ACTIONS_PER_SECOND', 5, 1, 100),
      rateWindowMs: 1000,
      dailyActiveLimitMs: int(env, 'DAILY_ACTIVE_LIMIT_MINUTES', 240, 1, 1440) * 60_000,
      idleGapMs: int(env, 'IDLE_GAP_SECONDS', 5, 1, 3600) * 1000,
      brigadeMinSize: int(env, 'BRIGADE_MIN_SIZE', 5, 1, 100),
      brigadeMaxSize: int(env, 'BRIGADE_MAX_SIZE', 10, 1, 100),
      autoStartSeason: bool(env, 'AUTO_START_SEASON', true),
      seasonCooldownMs: int(env, 'SEASON_COOLDOWN_SECONDS', 60, 0, 30 * 24 * 3600) * 1000,
      leaderboardSize: int(env, 'LEADERBOARD_SIZE', 10, 1, 100),
      discoveryProfile: discoveryProfile(env),
    },
    security: {
      trustProxy: bool(env, 'TRUST_PROXY', false),
      maxConnectionsPerIp: int(env, 'MAX_CONNECTIONS_PER_IP', 20, 1, 100_000),
      maxConnectionsPerAccount: int(env, 'MAX_CONNECTIONS_PER_ACCOUNT', 4, 1, 100),
      newAccountsPerIpPerHour: int(env, 'NEW_ACCOUNTS_PER_IP_PER_HOUR', 30, 1, 1_000_000),
      sqliteSynchronous: str(env, 'SQLITE_SYNCHRONOUS', 'NORMAL').toUpperCase() === 'FULL' ? 'FULL' : 'NORMAL',
    },
    donation: {
      enabled: bool(env, 'DONATION_DISPLAY_ENABLED', false),
      associationName: str(env, 'DONATION_ASSOCIATION_NAME', ''),
      associationUrl: str(env, 'DONATION_ASSOCIATION_URL', ''),
      note: str(
        env,
        'DONATION_NOTE',
        "Projet futur : une contribution à une association choisie en l'honneur du champion. " +
          "Aucun paiement, aucune collecte et aucun transfert d'argent n'existe dans ce prototype.",
      ),
    },
    auth: {
      googleClientId: str(env, 'GOOGLE_CLIENT_ID', ''),
      appleClientId: str(env, 'APPLE_CLIENT_ID', ''),
    },
  };
}
