import { describe, expect, it } from 'vitest';
import { holoAlert, type HoloData } from '../client/src/world/monolith/hologram.js';

const base: HoloData = {
  seasonName: 'Saison 1',
  countdown: 'fin dans 6 j',
  top: [],
  brigade: null,
  progress: 0,
  layer: 0,
  layers: 32,
  layerLeft: 1,
  finalStone: false,
};

describe('écran holographique : alertes', () => {
  it('rien de notable au début de la couche', () => {
    expect(holoAlert(base)).toBeNull();
  });
  it('couche presque terminée sous 10 % restants', () => {
    expect(holoAlert({ ...base, layer: 4, layerLeft: 0.05 })).toBe('▲ COUCHE 5 PRESQUE TERMINÉE');
    expect(holoAlert({ ...base, layer: 4, layerLeft: 0.2 })).toBeNull();
  });
  it('dernière couche, puis Pierre finale prioritaire', () => {
    expect(holoAlert({ ...base, layer: 31 })).toBe('▲ DERNIÈRE COUCHE');
    expect(holoAlert({ ...base, layer: 31, finalStone: true })).toBe('◆ PIERRE FINALE EN JEU');
  });
});
