import type { IncomingMessage } from 'node:http';

/**
 * Adresse IP du client. Derrière un reverse proxy de confiance (TRUST_PROXY),
 * on prend la DERNIÈRE valeur de X-Forwarded-For, celle ajoutée par notre
 * proxy (les précédentes sont fournies par le client et falsifiables).
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  let ip = req.socket.remoteAddress ?? 'unknown';
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff.join(',') : xff;
    const last = raw?.split(',').map((v) => v.trim()).filter(Boolean).at(-1);
    if (last) ip = last;
  }
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
