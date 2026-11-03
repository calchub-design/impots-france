import { createHash, randomBytes } from 'node:crypto';

/**
 * Comptes invités du prototype.
 *
 * Le serveur génère un jeton aléatoire de 256 bits, le remet UNE fois au
 * client (stocké dans localStorage) et ne conserve que son empreinte SHA-256.
 * Ce n'est PAS une authentification forte : quiconque obtient le jeton
 * (accès au navigateur, XSS) contrôle le compte, et rien n'empêche une
 * personne de créer plusieurs comptes invités. Voir docs/SECURITY.md.
 */
export function generateGuestToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}
