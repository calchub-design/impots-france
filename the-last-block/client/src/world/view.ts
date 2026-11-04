import type { ImpactKind, SurfaceState, WorldLayer } from './surface.js';
import type { PointerKind } from './gestures.js';

/**
 * Contrat commun des rendus de la surface (classique 2.5D et « monolithe »
 * en perspective). `main.ts` ne dépend que de ce contrat : on peut changer de
 * rendu sans toucher au réseau, à la sélection ni au minage.
 */

export interface ViewBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface ViewCamera {
  /** Point visé sur la face (en blocs). */
  x: number;
  y: number;
  /** Pixels par bloc au point visé. */
  zoom: number;
  minZoom: number;
  maxZoom: number;
  viewW: number;
  viewH: number;
  vx: number;
  vy: number;
  inertia: boolean;
  readonly animating: boolean;
  setViewport(w: number, h: number): void;
  setBounds(b: ViewBounds): void;
  fitZoom(w: number, h: number): number;
  worldToScreen(wx: number, wy: number): [number, number];
  screenToWorld(sx: number, sy: number): [number, number];
  visibleWorld(): { minX: number; minY: number; maxX: number; maxY: number };
  panByScreen(dx: number, dy: number): void;
  fling(pxPerSecX: number, pxPerSecY: number): void;
  stop(): void;
  zoomAt(factor: number, sx?: number, sy?: number): void;
  animateTo(to: Partial<{ x: number; y: number; zoom: number }>, duration?: number): void;
  update(dtMs: number): boolean;
}

export interface WorldView {
  readonly kind: 'classic' | 'monolith';
  readonly camera: ViewCamera;
  state: SurfaceState;
  lowFx: boolean;
  reducedMotion: boolean;
  layers: WorldLayer[];
  keyPan: { x: number; y: number };
  onTap: (wx: number, wy: number, kind: PointerKind) => void;
  onCameraMove: () => void;
  setState(patch: Partial<SurfaceState>): void;
  resize(): void;
  requestRender(): void;
  impact(idx: number, kind: ImpactKind, color?: string, label?: string): void;
  readonly recentFrameTimes: number[];
  readonly recentFrameIntervals: number[];
}
