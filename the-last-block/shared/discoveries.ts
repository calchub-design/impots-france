/**
 * Découvertes collectives (« Le Signal ») : types publics et calculs purs,
 * partagés par le serveur et le client.
 *
 * Ce fichier ne contient AUCUN texte de fragment : les titres et messages
 * vivent côté serveur (`server/content/discoveries.json`) et ne sont envoyés
 * au navigateur qu'une fois le fragment révélé.
 */

/** Fragment tel qu'envoyé au navigateur. Verrouillé : ni titre ni texte. */
export interface DiscoveryFragment {
  /** Identifiant stable (ex. « echo »). */
  id: string;
  /** Ordre d'apparition, à partir de 1. */
  order: number;
  /** Numéro affiché (« 01 »…). */
  code: string;
  /** Couche déclencheuse, numérotée à partir de 1 depuis le sommet. */
  layer: number;
  revealed: boolean;
  title?: string;
  text?: string;
  revealedAt?: number;
}

/** Journal des découvertes d'une saison (« Archives du cube »). */
export interface DiscoveryLog {
  seasonId: number;
  seasonName: string;
  seasonStatus: 'active' | 'ended';
  /** Profil utilisé (« standard », « mini-48h »…), « none » si aucun. */
  profile: string;
  /** Profil incompatible avec ce cube (trop peu de couches) : aucune découverte cette saison. */
  invalidProfile?: string;
  fragments: DiscoveryFragment[];
}

/** Repère de déclenchement : fraction des couches achevées, ou dernière couche. */
export type DiscoveryTarget = number | 'last';

export type DiscoveryPlan = { ok: true; layers: number[] } | { ok: false; error: string };

/**
 * Numéros de couche déclencheurs (à partir de 1), strictement croissants,
 * calculés UNE fois au démarrage de la saison à partir du nombre de couches.
 * Un repère de 10 % sur 32 couches donne la couche 3 (arrondi au plus proche,
 * au moins 1). Si deux repères tombent sur la même couche, le suivant passe à
 * la couche d'après : jamais deux découvertes sur une même couche. Si le cube
 * a moins de couches que de fragments, le profil est refusé.
 */
export function planDiscoveryLayers(targets: DiscoveryTarget[], layers: number): DiscoveryPlan {
  const n = targets.length;
  if (!Number.isInteger(layers) || layers < 1) return { ok: false, error: `nombre de couches invalide (${layers})` };
  if (n === 0) return { ok: true, layers: [] };
  if (n > layers) return { ok: false, error: `${n} fragments pour ${layers} couche(s) : il faut au moins une couche par fragment` };
  // 1. Repères bruts (arrondi au plus proche, au moins la couche 1).
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = targets[i];
    if (t === 'last') {
      if (i !== n - 1) return { ok: false, error: '« last » doit être le dernier repère' };
      out.push(layers);
    } else {
      if (typeof t !== 'number' || !(t > 0 && t < 1)) return { ok: false, error: `repère invalide (${String(t)}) : fraction attendue entre 0 et 1 exclus` };
      out.push(Math.max(1, Math.round(t * layers)));
    }
  }
  // 2. Strictement croissant : un repère qui rejoint le précédent passe à la couche suivante…
  for (let i = 1; i < n; i++) if (out[i] <= out[i - 1] && targets[i] !== 'last') out[i] = out[i - 1] + 1;
  // 3. …sans dépasser le cube, ni la couche du repère suivant (on recule depuis la fin).
  if (out[n - 1] > layers) out[n - 1] = layers;
  for (let i = n - 2; i >= 0; i--) if (out[i] >= out[i + 1]) out[i] = out[i + 1] - 1;
  if (out[0] < 1) return { ok: false, error: `impossible de placer ${n} fragments sur ${layers} couches` };
  return { ok: true, layers: out };
}

/** Seuils des indices, en fraction des blocs détruits de la couche courante. */
export const HINT_ANOMALY = 0.8;
export const HINT_NEAR = 0.95;

export type HintLevel = 'anomaly' | 'near';

export const HINT_LABELS: Record<HintLevel, string> = {
  anomaly: 'Anomalie détectée',
  near: 'Signal presque accessible',
};

/**
 * Indice discret quand la couche courante cache un fragment non révélé :
 * calculé uniquement à partir de l'état confirmé par le serveur (couche
 * courante et blocs restants). Ne dit rien du contenu du fragment.
 */
export function discoveryHint(
  log: Pick<DiscoveryLog, 'fragments' | 'seasonStatus'> | null,
  currentLayer: number,
  remainingBlocks: number,
  blocksPerLayer: number,
): { level: HintLevel; layer: number } | null {
  if (!log || log.seasonStatus !== 'active' || blocksPerLayer <= 0) return null;
  const f = log.fragments.find((x) => !x.revealed && x.layer === currentLayer + 1);
  if (!f) return null;
  const progress = 1 - remainingBlocks / blocksPerLayer;
  if (progress >= HINT_NEAR) return { level: 'near', layer: f.layer };
  if (progress >= HINT_ANOMALY) return { level: 'anomaly', layer: f.layer };
  return null;
}
