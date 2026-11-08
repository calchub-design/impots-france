import { CLOSE_CODES, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../../shared/protocol.js';

/** Identifiant d'action aléatoire (fonctionne aussi hors contexte sécurisé, ex. IP locale en HTTP). */
export function newActionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * `replaced` : session fermée car ouverte ailleurs (pas de reconnexion automatique).
 * `invite` : bêta privée, invitation requise pour créer un compte (pas de reconnexion automatique).
 */
export type ConnState = 'connecting' | 'online' | 'offline' | 'replaced' | 'invite';

interface PendingAction {
  layer: number;
  block: number;
  sentAt: number;
}

/**
 * Connexion WebSocket avec reconnexion automatique (backoff exponentiel +
 * gigue) et renvoi des actions non confirmées. Le serveur déduplique les
 * renvois grâce à l'`actionId`, ce qui rend l'opération idempotente.
 */
export class GameSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private readonly pending = new Map<string, PendingAction>();
  private readonly sentTimes: number[] = [];
  private closedByUser = false;

  constructor(
    private readonly profile: string,
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onState: (s: ConnState) => void,
    private readonly onNotice: (text: string) => void,
    private readonly maxPerSecond = 5,
  ) {}

  private get tokenKey() {
    return `tlb.token.${this.profile}`;
  }

  get token(): string | undefined {
    return storage()?.getItem(this.tokenKey) ?? undefined;
  }

  /** Bêta privée : code d'invitation mémorisé (lien ou saisie) jusqu'à la création du compte. */
  private get inviteKey() {
    return `tlb.invite.${this.profile}`;
  }

  setInvite(code: string) {
    storage()?.setItem(this.inviteKey, code.trim());
  }

  /** Échecs de connexion consécutifs (affichage « serveur indisponible »). */
  get failures() {
    return this.attempt;
  }

  forgetToken() {
    storage()?.removeItem(this.tokenKey);
  }

  connect() {
    this.closedByUser = false;
    this.onState('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      const token = this.token;
      const invite = token ? undefined : (storage()?.getItem(this.inviteKey) ?? undefined);
      this.send({ t: 'hello', v: PROTOCOL_VERSION, token, ...(invite ? { invite } : {}) });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        if (msg.token) {
          storage()?.setItem(this.tokenKey, msg.token);
          storage()?.removeItem(this.inviteKey); // compte créé : le code n'est plus utile
        }
        this.onState('online');
        this.onMessage(msg);
        this.resendPending();
        return;
      }
      if (msg.t === 'token') {
        // Rotation demandée par ce client : on conserve le nouveau jeton.
        storage()?.setItem(this.tokenKey, msg.token);
        return this.onNotice('Nouveau jeton enregistré : vos autres sessions ont été déconnectées.');
      }
      if (msg.t === 'error' && msg.code === 'invalid_token') {
        this.forgetToken();
        this.pending.clear();
        return this.onNotice('Session invalide ou révoquée : un nouveau compte invité va être créé.');
      }
      if (msg.t === 'mineResult') this.pending.delete(msg.actionId);
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === CLOSE_CODES.inviteRequired) {
        // Bêta privée : on attend que le joueur saisisse un code (pas de boucle de reconnexion).
        this.closedByUser = true;
        this.onState('invite');
        return;
      }
      if (ev.code === CLOSE_CODES.replaced) {
        // Trop de sessions : celle-ci a été remplacée. Ne pas se reconnecter
        // automatiquement (sinon les onglets se chasseraient en boucle).
        this.closedByUser = true;
        this.onState('replaced');
        return;
      }
      this.onState('offline');
      if (this.closedByUser) return;
      // Refus de politique (ex. trop de comptes créés) : on espace fortement.
      if (ev.code === 1008) this.attempt = Math.max(this.attempt, 6);
      const delay = Math.min(30_000, 400 * 2 ** this.attempt) * (0.7 + Math.random() * 0.6);
      this.attempt++;
      setTimeout(() => this.connect(), delay);
    };
  }

  /** Ferme et rouvre la connexion (ex. changement de profil). */
  restart() {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
    this.pending.clear();
    setTimeout(() => this.connect(), 50);
  }

  get online() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Limite côté client (confort) — la vraie limite est appliquée par le serveur. */
  canMine(now = performance.now()): boolean {
    while (this.sentTimes.length && now - this.sentTimes[0] > 1050) this.sentTimes.shift();
    return this.sentTimes.length < this.maxPerSecond && this.pending.size < 8;
  }

  mine(layer: number, block: number): string | null {
    if (!this.online || !this.canMine()) return null;
    const actionId = newActionId();
    this.pending.set(actionId, { layer, block, sentAt: Date.now() });
    this.sentTimes.push(performance.now());
    this.send({ t: 'mine', actionId, layer, block });
    return actionId;
  }

  private resendPending() {
    const now = Date.now();
    for (const [actionId, p] of this.pending) {
      if (now - p.sentAt > 60_000) {
        this.pending.delete(actionId);
        continue;
      }
      this.send({ t: 'mine', actionId, layer: p.layer, block: p.block });
    }
  }
}
