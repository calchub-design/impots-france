import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { ClientMessage, MineResultMessage, ServerMessage, WelcomeMessage } from '../shared/protocol.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';

/** Client WebSocket minimal pour les tests d'intégration et le test de charge. */
export class TestClient {
  ws!: WebSocket;
  welcome!: WelcomeMessage;
  token: string | undefined;
  received: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

  constructor(private readonly url: string) {}

  /** Code et motif de fermeture de la dernière connexion. */
  closed!: Promise<{ code: number; reason: string }>;

  async connect(token?: string, name?: string): Promise<WelcomeMessage> {
    this.received = [];
    this.ws = new WebSocket(this.url);
    this.closed = new Promise((resolve) => this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.received.push(msg);
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          clearTimeout(w.timer);
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    const welcome = this.waitFor((m) => m.t === 'welcome');
    this.send({ t: 'hello', v: PROTOCOL_VERSION, token: token ?? this.token, name });
    this.welcome = (await welcome) as WelcomeMessage;
    if (this.welcome.token) this.token = this.welcome.token;
    return this.welcome;
  }

  /** Volontairement non typé strictement : les tests envoient aussi des messages forgés. */
  send(msg: ClientMessage | object) {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string) {
    this.ws.send(data);
  }

  waitFor<T extends ServerMessage = ServerMessage>(pred: (m: ServerMessage) => boolean, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.findIndex((w) => w.timer === timer), 1);
        reject(new Error('timeout en attente d\'un message'));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: resolve as (m: ServerMessage) => void, reject, timer });
    });
  }

  mine(layer: number, block: number, actionId: string = randomUUID()): Promise<MineResultMessage> {
    const p = this.waitFor<MineResultMessage>((m) => m.t === 'mineResult' && m.actionId === actionId);
    this.send({ t: 'mine', actionId, layer, block });
    return p;
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}
