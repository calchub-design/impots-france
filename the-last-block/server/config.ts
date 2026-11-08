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

/**
 * Bêta privée : accès sur invitation et contrôles de configuration au démarrage.
 * Voir docs/BETA-48H.md.
 */
export interface BetaSettings {
  /** Mode bêta : la configuration est vérifiée au démarrage (refus de démarrer si dangereuse). */
  enabled: boolean;
  /** « open » : tout visiteur peut créer un compte invité ; « invite » : création sur code d'invitation. */
  accessMode: 'open' | 'invite';
  /** Secret de pseudonymisation des exports statistiques (HMAC), jamais envoyé au client. */
  pseudonymSecret: string;
  /** Dossier des sauvegardes à chaud (POST /api/admin/backup). */
  backupDir: string;
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
  beta: BetaSettings;
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
  const config: AppConfig = {
    port: int(env, 'PORT', 8080, 0, 65535),
    host: str(env, 'HOST', '0.0.0.0'),
    dbPath: str(env, 'DB_PATH', DEFAULT_DB_PATH),
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
    beta: {
      enabled: bool(env, 'BETA_MODE', false),
      accessMode: accessMode(env),
      pseudonymSecret: str(env, 'STATS_PSEUDONYM_SECRET', ''),
      backupDir: str(env, 'BACKUP_DIR', './data/backups'),
    },
  };
  const check = checkBetaConfig(config);
  if (config.beta.enabled && check.errors.length) {
    throw new Error(`Configuration de bêta refusée :\n - ${check.errors.join('\n - ')}`);
  }
  return config;
}

function accessMode(env: Env): 'open' | 'invite' {
  const v = str(env, 'ACCESS_MODE', 'open').trim().toLowerCase() || 'open';
  if (v !== 'open' && v !== 'invite') throw new Error(`Variable ACCESS_MODE invalide: "${v}" (open ou invite)`);
  return v;
}

export const DEFAULT_DB_PATH = './data/lastblock.sqlite';

/**
 * Contrôles de la configuration d'une bêta privée. `errors` empêchent le démarrage
 * (BETA_MODE=true) ; `warnings` sont affichés au démarrage.
 */
export function checkBetaConfig(c: AppConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (c.beta.accessMode !== 'invite') errors.push('ACCESS_MODE doit valoir « invite » (accès privé sur invitation).');
  if (c.adminToken.length < 32) errors.push('ADMIN_TOKEN doit contenir au moins 32 caractères aléatoires.');
  if (c.beta.pseudonymSecret.length < 32) errors.push('STATS_PSEUDONYM_SECRET doit contenir au moins 32 caractères aléatoires.');
  if (c.beta.pseudonymSecret && c.beta.pseudonymSecret === c.adminToken) errors.push('STATS_PSEUDONYM_SECRET doit être différent de ADMIN_TOKEN.');
  if (c.dbPath === DEFAULT_DB_PATH || c.dbPath === ':memory:') errors.push(`DB_PATH doit désigner une base dédiée à la bêta (pas ${c.dbPath}).`);
  if (c.allowedOrigins.length === 0) errors.push('ALLOWED_ORIGINS doit lister l\'origine HTTPS de la bêta.');
  else if (c.allowedOrigins.some((o) => !o.startsWith('https://'))) errors.push('ALLOWED_ORIGINS : seules des origines https:// sont acceptées en bêta.');
  if (c.rules.maxActionsPerSecond !== 5) errors.push('MAX_ACTIONS_PER_SECOND doit rester à 5 (règle de production).');
  if (c.rules.dailyActiveLimitMs !== 4 * 3600_000) errors.push('DAILY_ACTIVE_LIMIT_MINUTES doit rester à 240 (4 h, règle de production).');
  if (c.rules.brigadeMinSize < 5) errors.push('BRIGADE_MIN_SIZE doit être d\'au moins 5 (règle de production).');
  if (c.rules.discoveryProfile !== 'mini-48h') errors.push('DISCOVERY_PROFILE doit valoir « mini-48h » pour la bêta de 48 h.');
  if (c.rules.seasonDurationMs !== 48 * 3600_000) warnings.push('SEASON_DURATION_HOURS ne vaut pas 48 : la saison automatique ne durera pas 48 h.');
  if (c.rules.autoStartSeason) warnings.push('AUTO_START_SEASON=true : une saison démarrera seule. Recommandé : false, puis démarrage par l\'administration après le test de fumée.');
  if (c.host !== '127.0.0.1' && c.host !== 'localhost') warnings.push(`HOST=${c.host} : le serveur écoute sur toutes les interfaces. Recommandé : 127.0.0.1 derrière le reverse proxy HTTPS.`);
  if (!c.security.trustProxy) warnings.push('TRUST_PROXY=false : derrière un reverse proxy, les limites par IP verraient toutes les connexions venir du proxy.');
  return { errors, warnings };
}
