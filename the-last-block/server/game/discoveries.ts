import { planDiscoveryLayers, type DiscoveryTarget } from '../../shared/discoveries.js';
import rawContent from '../content/discoveries.json' with { type: 'json' };

/**
 * Contenu narratif des découvertes (« Le Signal ») et profils de déclenchement.
 * Les textes sont dans `server/content/discoveries.json` (éditable) et ne sont
 * jamais inclus dans le code du navigateur.
 *
 * Un changement du fichier s'applique aux saisons qui DÉMARRENT ensuite : le
 * plan d'une saison (couches, titres, textes) est figé en base à son début.
 */

export interface FragmentContent {
  id: string;
  code: string;
  title: string;
  text: string;
}

export interface DiscoveryProfile {
  label: string;
  steps: { fragment: string; at: DiscoveryTarget }[];
}

export interface DiscoveryContent {
  fragments: FragmentContent[];
  profiles: Record<string, DiscoveryProfile>;
}

/** Profil spécial : aucune découverte. */
export const NO_DISCOVERIES = 'none';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function nonEmpty(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw new Error(`découvertes : ${what} invalide`);
  return v;
}

/** Vérifie le fichier de contenu ; lève une erreur explicite s'il est incohérent. */
export function validateDiscoveryContent(raw: unknown): DiscoveryContent {
  const r = raw as { fragments?: unknown; profiles?: unknown };
  if (!r || !Array.isArray(r.fragments) || typeof r.profiles !== 'object' || r.profiles === null) {
    throw new Error('découvertes : « fragments » (liste) et « profiles » (objet) sont requis');
  }
  const fragments: FragmentContent[] = [];
  const ids = new Set<string>();
  for (const f of r.fragments as Record<string, unknown>[]) {
    const id = nonEmpty(f?.id, 'identifiant de fragment', 40);
    if (!ID_RE.test(id)) throw new Error(`découvertes : identifiant « ${id} » invalide (minuscules, chiffres, tirets)`);
    if (ids.has(id)) throw new Error(`découvertes : identifiant « ${id} » en double`);
    ids.add(id);
    fragments.push({ id, code: nonEmpty(f.code, `code de « ${id} »`, 8), title: nonEmpty(f.title, `titre de « ${id} »`, 80), text: nonEmpty(f.text, `texte de « ${id} »`, 600) });
  }
  const profiles: Record<string, DiscoveryProfile> = {};
  for (const [name, p] of Object.entries(r.profiles as Record<string, { label?: unknown; steps?: unknown }>)) {
    if (!ID_RE.test(name) || name === NO_DISCOVERIES) throw new Error(`découvertes : nom de profil « ${name} » invalide ou réservé`);
    if (!Array.isArray(p?.steps) || p.steps.length === 0) throw new Error(`découvertes : le profil « ${name} » n'a aucune étape`);
    const used = new Set<string>();
    const steps = (p.steps as { fragment?: unknown; at?: unknown }[]).map((s) => {
      const fid = nonEmpty(s?.fragment, `fragment du profil « ${name} »`, 40);
      if (!ids.has(fid)) throw new Error(`découvertes : le profil « ${name} » cite un fragment inconnu « ${fid} »`);
      if (used.has(fid)) throw new Error(`découvertes : le profil « ${name} » cite deux fois « ${fid} »`);
      used.add(fid);
      const at: DiscoveryTarget = s.at === 'last' ? 'last' : (s.at as number);
      return { fragment: fid, at };
    });
    // Repères croissants, « last » uniquement à la fin (vérifié sur un grand cube fictif).
    const fr = steps.map((s) => s.at).filter((a): a is number => a !== 'last');
    for (let i = 1; i < fr.length; i++) if (!(fr[i] > fr[i - 1])) throw new Error(`découvertes : repères non croissants dans « ${name} »`);
    const check = planDiscoveryLayers(steps.map((s) => s.at), 1000);
    if (!check.ok) throw new Error(`découvertes : profil « ${name} » : ${check.error}`);
    profiles[name] = { label: typeof p.label === 'string' ? p.label : name, steps };
  }
  return { fragments, profiles };
}

export const DISCOVERY_CONTENT: DiscoveryContent = validateDiscoveryContent(rawContent);

export interface PlannedFragment extends FragmentContent {
  order: number;
  /** Couche déclencheuse, indexée à partir de 0 (couche 0 = sommet). */
  layer: number;
}

export type BuiltPlan = { ok: true; fragments: PlannedFragment[] } | { ok: false; error: string };

/** Plan d'une saison : fragments du profil, chacun lié à une couche déclencheuse. */
export function buildDiscoveryPlan(profile: string, layers: number, content: DiscoveryContent = DISCOVERY_CONTENT): BuiltPlan {
  if (profile === NO_DISCOVERIES) return { ok: true, fragments: [] };
  const p = content.profiles[profile];
  if (!p) return { ok: false, error: `profil de découvertes inconnu « ${profile} » (disponibles : ${[NO_DISCOVERIES, ...Object.keys(content.profiles)].join(', ')})` };
  const plan = planDiscoveryLayers(p.steps.map((s) => s.at), layers);
  if (!plan.ok) return { ok: false, error: `profil « ${profile} » incompatible avec un cube de ${layers} couche(s) : ${plan.error}` };
  const byId = new Map(content.fragments.map((f) => [f.id, f]));
  return {
    ok: true,
    fragments: p.steps.map((s, i) => ({ ...byId.get(s.fragment)!, order: i + 1, layer: plan.layers[i] - 1 })),
  };
}

export function isKnownProfile(profile: string, content: DiscoveryContent = DISCOVERY_CONTENT): boolean {
  return profile === NO_DISCOVERIES || profile in content.profiles;
}
