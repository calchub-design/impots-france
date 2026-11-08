import { randomBytes, randomInt } from 'node:crypto';
import { hashToken } from './guest.js';

/**
 * Codes d'invitation de la bêta privée.
 *
 * Format lisible au téléphone : « TLB-XXXX-XXXX » (alphabet sans caractères
 * ambigus : pas de 0/O, 1/I/L). 31⁸ ≈ 8,5 × 10¹¹ combinaisons, et les essais
 * ratés sont limités par adresse IP. Seule l'empreinte SHA-256 du code
 * normalisé est conservée en base : la base seule ne permet pas de les retrouver.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateBetaInviteCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `TLB-${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Forme canonique (majuscules, sans espaces ni tirets, préfixe facultatif) ; null si impossible. */
export function normalizeBetaInvite(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  let s = raw.toUpperCase().replace(/[\s-]/g, '');
  if (s.startsWith('TLB')) s = s.slice(3);
  return new RegExp(`^[${ALPHABET}]{8}$`).test(s) ? s : null;
}

export function hashBetaInvite(normalized: string): string {
  return hashToken(`invite:${normalized}`);
}

export function newInviteId(): string {
  return `inv_${randomBytes(6).toString('hex')}`;
}
