/**
 * Catalogue de skins purement cosmétiques.
 * Aucun skin n'apporte d'avantage de jeu et aucun n'est payant dans ce prototype :
 * `price` est volontairement toujours `null`. Un futur magasin cosmétique devra
 * passer par une validation légale/produit avant toute activation.
 */
export interface SkinDef {
  id: string;
  label: string;
  /** Couleur principale (pioche, particules, nom sur le panneau). */
  color: string;
  accent: string;
  price: null;
}

export const SKINS: readonly SkinDef[] = [
  { id: 'classic', label: 'Classique', color: '#f2c14e', accent: '#8a5a12', price: null },
  { id: 'ember', label: 'Braise', color: '#ff6b3d', accent: '#7a1f0b', price: null },
  { id: 'frost', label: 'Givre', color: '#7fd8ff', accent: '#1b5c7a', price: null },
  { id: 'jade', label: 'Jade', color: '#5be39a', accent: '#145c38', price: null },
  { id: 'amethyst', label: 'Améthyste', color: '#c18cff', accent: '#4b2580', price: null },
  { id: 'chalk', label: 'Craie', color: '#f4f1ea', accent: '#6d6a63', price: null },
];

export const DEFAULT_SKIN = 'classic';

export function isValidSkin(id: unknown): id is string {
  return typeof id === 'string' && SKINS.some((s) => s.id === id);
}

export function skinById(id: string): SkinDef {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}
