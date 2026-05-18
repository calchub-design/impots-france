'use client';
import { TaxState } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { SectionCard, AlertBox } from '@/components/ui/SectionCard';
import { calculerPlafondPER } from '@/lib/calculations';

interface Props { state: TaxState; dispatch: React.Dispatch<TaxAction>; }

export function Module9Charges({ state, dispatch }: Props) {
  const ch = state.chargesDeductibles;
  const update = (changes: Partial<typeof ch>) =>
    dispatch({ type: 'UPDATE_CHARGES', payload: { ...ch, ...changes } });

  const plafondPER = calculerPlafondPER(state);
  const totalPER = ch.versementsPER + ch.versementsPERP + ch.versementsMadelin;

  return (
    <div>
      <h2 className="text-2xl font-bold text-blue-900 mb-2">Charges déductibles du revenu global</h2>
      <p className="text-gray-600 mb-6">Ces charges réduisent directement votre revenu imposable avant application du barème.</p>

      <SectionCard title="Pensions alimentaires" icon="👨‍👩‍👧">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CurrencyInput
            label="Pension à un enfant majeur non rattaché (case 6EL)"
            value={ch.pensionEnfantMajeur}
            onChange={v => update({ pensionEnfantMajeur: v })}
            tooltip="Aide versée à votre enfant majeur qui ne fait plus partie de votre foyer fiscal. Si vous le logez et nourrissez : forfait de 4 080€ sans justificatif. Sinon, montant réel justifié."
          />
          <CurrencyInput
            label="Pension versée à l'ex-conjoint (case 6GU)"
            value={ch.pensionExConjoint}
            onChange={v => update({ pensionExConjoint: v })}
            tooltip="Pension alimentaire fixée par décision de justice versée à votre ex-conjoint. Justificatif : décision judiciaire + preuves de paiement."
          />
          <CurrencyInput
            label="Aide aux parents dans le besoin (case 6EL)"
            value={ch.pensionParents}
            onChange={v => update({ pensionParents: v })}
            tooltip="Aide en espèces ou en nature à vos parents ou beaux-parents dans le besoin. Des forfaits officiels s'appliquent pour nourriture et logement sans justificatif détaillé."
          />
        </div>
      </SectionCard>

      <SectionCard title="Épargne retraite (PER, PERP, Madelin)" icon="🏦">
        <AlertBox variant="info">
          Plafond estimé de déduction disponible : <strong>{plafondPER.toLocaleString('fr-FR')} €</strong>
          {' '}(10% des revenus N-1 plafonnés à 35 816 €, minimum 4 478 €).
          {totalPER > plafondPER && (
            <span className="text-red-600"> ⚠️ Vos versements ({totalPER.toLocaleString('fr-FR')} €) dépassent le plafond.</span>
          )}
        </AlertBox>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CurrencyInput
            label="Versements PER individuel en 2024 (case 6NS)"
            value={ch.versementsPER}
            onChange={v => update({ versementsPER: v })}
            tooltip="Versements volontaires sur un Plan d'Épargne Retraite individuel effectués en 2024. Disponible sur votre attestation annuelle de l'organisme assureur."
          />
          <CurrencyInput
            label="Versements PERP (contrats anciens)"
            value={ch.versementsPERP}
            onChange={v => update({ versementsPERP: v })}
            tooltip="Si vous avez encore un PERP non transformé en PER, les versements sont déductibles dans les mêmes limites."
          />
          <CurrencyInput
            label="Versements contrat Madelin (TNS)"
            value={ch.versementsMadelin}
            onChange={v => update({ versementsMadelin: v })}
            tooltip="Pour les travailleurs non salariés : les cotisations retraite Madelin sont déductibles dans certaines limites spécifiques aux TNS."
          />
        </div>
        <p className="text-xs text-gray-500 mt-2">Justificatif : attestation de l'organisme assureur (à conserver)</p>
      </SectionCard>

      <SectionCard title="Autres charges déductibles" icon="📋">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CurrencyInput
            label="CSG déductible sur revenus du patrimoine (case 6DE)"
            value={ch.csgDeductible}
            onChange={v => update({ csgDeductible: v })}
            tooltip="La CSG déductible est normalement pré-remplie par l'administration. Elle correspond à 6,8% de la CSG payée sur vos revenus du patrimoine de l'année précédente."
          />
          <CurrencyInput
            label="Déficit foncier antérieur reporté (case 4BD des années précédentes)"
            value={ch.deficitFoncierAnterieur}
            onChange={v => update({ deficitFoncierAnterieur: v })}
            tooltip="Si vous avez un déficit foncier des années précédentes non encore imputé sur vos revenus fonciers. Saisissez uniquement la part que vous pouvez imputer cette année."
          />
        </div>
      </SectionCard>
    </div>
  );
}
