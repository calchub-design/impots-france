import { randomInt } from 'node:crypto';

const NAME_RE = /^[\p{L}\p{N} _.'-]+$/u;

export class GameError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Nettoie et valide un pseudo de joueur (2 à 20 caractères). */
export function cleanPlayerName(raw: unknown): string {
  if (typeof raw !== 'string') throw new GameError('invalid_name', 'Pseudo invalide.');
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 20) throw new GameError('invalid_name', 'Le pseudo doit contenir 2 à 20 caractères.');
  if (!NAME_RE.test(name)) throw new GameError('invalid_name', 'Caractères autorisés : lettres, chiffres, espace, _ . \' -');
  return name;
}

/** Nettoie et valide un nom de brigade (3 à 24 caractères). */
export function cleanBrigadeName(raw: unknown): string {
  if (typeof raw !== 'string') throw new GameError('invalid_brigade_name', 'Nom de brigade invalide.');
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name.length < 3 || name.length > 24) throw new GameError('invalid_brigade_name', 'Le nom de brigade doit contenir 3 à 24 caractères.');
  if (!NAME_RE.test(name)) throw new GameError('invalid_brigade_name', 'Caractères autorisés : lettres, chiffres, espace, _ . \' -');
  return name;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateInviteCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export function normalizeInviteCode(raw: unknown): string {
  if (typeof raw !== 'string') throw new GameError('invalid_code', "Code d'invitation invalide.");
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) throw new GameError('invalid_code', "Code d'invitation invalide.");
  return code;
}

export function guestName(): string {
  return `Mineur-${randomInt(1000, 10000)}`;
}
