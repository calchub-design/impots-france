'use client';
import { TaxState } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { SectionCard, AlertBox } from '@/components/ui/SectionCard';

interface Props { state: TaxState; dispatch: React.Dispatch<TaxAction>; }

const FRACTIONS_RENTE: Record<string, string> = {
  '<50': '70% imposable',
  '50-59': '50% imposable',
  '60-69': '40% imposable',
  '≥70': '30% imposable',
};

function PersonBlock({ qui, label, state, dispatch }: {
  qui: 'declarant' | 'conjoint';
  label: string;
  state: TaxState;
  dispatch: React.Dispatch<TaxAction>;
}) {
  const d = state.revenusRemplacement[qui];
  const update = (changes: Partial<typeof d>) => {
    dispatch({ type: 'UPDATE_REMPLACEMENT', payload: { ...state.revenusRemplacement, [qui]: { ...d, ...changes } } });
  };
  const abattRetraite = Math.min(d.retraite * 0.10, 4321);

  const getFractionRente = (age: number) => {
    if (age < 50) return 0.70;
    if (age < 60) return 0.50;
    if (age < 70) return 0.40;
    return 0.30;
  };

  return (
    <SectionCard title={label} icon="📋">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <CurrencyInput
          label="Allocations chômage ARE (case 1AP)"
          value={d.chomage}
          onChange={v => update({ chomage: v })}
          tooltip="Allocations versées par France Travail (ex-Pôle Emploi). Intégralement imposables."
        />
        <CurrencyInput
          label="Indemnités journalières maladie / maternité"
          value={d.indemMaladie}
          onChange={v => update({ indemMaladie: v })}
          tooltip="Les IJSS (indemnités journalières de Sécurité Sociale) sont imposables. Le montant figure sur votre attestation CPAM."
        />
        <CurrencyInput
          label="Pensions de retraite (case 1AS)"
          value={d.retraite}
          onChange={v => update({ retraite: v })}
          tooltip="Pension de base (Sécurité Sociale), complémentaires (ARRCO, AGIRC), pension de réversion... Un abattement de 10% est automatiquement appliqué, plafonné à 4 321€ par foyer."
        />
        <CurrencyInput
          label="Pensions d'invalidité (case 1AZ)"
          value={d.invalidite}
          onChange={v => update({ invalidite: v })}
          tooltip="Pension versée par la CPAM ou votre employeur en cas d'invalidité. Imposable."
        />
        <CurrencyInput
          label="Indemnités de licenciement (partie imposable)"
          value={d.indemLicenciement}
          onChange={v => update({ indemLicenciement: v })}
          tooltip="Seule la partie dépassant les seuils d'exonération (le plus élevé entre l'indemnité légale, 2× la rémunération brute, ou 50% de l'indemnité) est imposable. Pour simplifier, saisissez uniquement la partie imposable que votre employeur doit vous avoir communiquée."
        />
      </div>

      {d.retraite > 0 && (
        <AlertBox variant="success">
          Abattement retraite calculé : <strong>{abattRetraite.toLocaleString('fr-FR')} €</strong> (10% de {d.retraite.toLocaleString('fr-FR')} €, plafonné à 4 321 €/foyer)
        </AlertBox>
      )}

      <div className="mt-4 border-t pt-4">
        <p className="text-sm font-medium text-gray-700 mb-3">Rente viagère à titre onéreux</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CurrencyInput
            label="Montant annuel de la rente (cases 1AW)"
            value={d.renteViagere}
            onChange={v => update({ renteViagere: v })}
            tooltip="Rente perçue suite à la vente d'un bien en viager ou la cession d'un capital. Seule une fraction est imposable, selon votre âge au premier versement."
          />
          <div>
            <label className="text-sm font-medium text-gray-700">Âge lors du premier versement</label>
            <input
              type="number" min="0" max="100"
              value={d.ageRenteViagere}
              onChange={e => update({ ageRenteViagere: parseInt(e.target.value) || 70 })}
              className="w-full mt-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
        </div>
        {d.renteViagere > 0 && (
          <AlertBox variant="info">
            Fraction imposable : <strong>{(d.renteViagere * getFractionRente(d.ageRenteViagere)).toLocaleString('fr-FR')} €</strong>
            {' '}({(getFractionRente(d.ageRenteViagere) * 100)}% pour un âge de {d.ageRenteViagere} ans)
          </AlertBox>
        )}
      </div>
    </SectionCard>
  );
}

export function Module3Remplacement({ state, dispatch }: Props) {
  const couple = state.situationPersonnelle.situationMaritale === 'marie_pacse';
  return (
    <div>
      <h2 className="text-2xl font-bold text-blue-900 mb-2">Revenus de remplacement et retraites</h2>
      <p className="text-gray-600 mb-6">Cases 1AP, 1AS, 1AZ, 1AW. Ces montants sont généralement pré-remplis par les organismes payeurs.</p>
      <PersonBlock qui="declarant" label="Vous" state={state} dispatch={dispatch} />
      {couple && <PersonBlock qui="conjoint" label="Conjoint(e)" state={state} dispatch={dispatch} />}
    </div>
  );
}
