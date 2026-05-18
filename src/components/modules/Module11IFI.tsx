'use client';
import { TaxState } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { CheckboxField } from '@/components/ui/RadioGroup';
import { SectionCard, AlertBox } from '@/components/ui/SectionCard';

interface Props { state: TaxState; dispatch: React.Dispatch<TaxAction>; }

export function Module11IFI({ state, dispatch }: Props) {
  const ifi = state.ifi;
  const update = (changes: Partial<typeof ifi>) =>
    dispatch({ type: 'UPDATE_IFI', payload: { ...ifi, ...changes } });

  return (
    <div>
      <h2 className="text-2xl font-bold text-blue-900 mb-2">Impôt sur la Fortune Immobilière (IFI)</h2>
      <p className="text-gray-600 mb-6">L'IFI s'applique si la valeur nette de votre patrimoine immobilier dépasse 1 300 000 €.</p>

      <SectionCard title="Êtes-vous assujetti à l'IFI ?" icon="🏰">
        <CheckboxField
          label="La valeur nette de mon patrimoine immobilier dépasse 1 300 000 €"
          checked={ifi.assujetti}
          onChange={v => update({ assujetti: v })}
          tooltip="Le seuil d'entrée dans l'IFI est de 1,3 million d'euros de patrimoine immobilier net (valeur des biens moins les dettes liées). Toutes les biens immobiliers sont concernés sauf la résidence principale (abattement 30%)."
        />
      </SectionCard>

      {ifi.assujetti ? (
        <>
          <SectionCard title="Éléments indicatifs IFI" icon="📊" variant="warning">
            <AlertBox variant="warning">
              L'IFI nécessite le formulaire <strong>2042-IFI</strong>. Ce simulateur vous indique les grandes cases
              mais nous recommandons un <strong>notaire ou conseiller fiscal</strong> pour ce volet complexe.
            </AlertBox>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <CurrencyInput
                label="Valeur brute du patrimoine immobilier (case 9HI)"
                value={ifi.valeurBrute}
                onChange={v => update({ valeurBrute: v })}
                tooltip="Valeur vénale au 1er janvier 2024 de l'ensemble de vos biens immobiliers (résidence principale × 70%, biens locatifs, parts SCI...). Hors biens professionnels exonérés."
              />
              <CurrencyInput
                label="Passif déductible (dettes, emprunts) — case 9HJ"
                value={ifi.passifDeductible}
                onChange={v => update({ passifDeductible: v })}
                tooltip="Capital restant dû de vos emprunts immobiliers au 1er janvier 2024, ainsi que les dettes afférentes aux biens taxables."
              />
            </div>
            {ifi.valeurBrute > 0 && (
              <div className="bg-orange-50 rounded-lg p-4 mt-4 text-sm">
                <div className="flex justify-between"><span>Valeur brute</span><span>{ifi.valeurBrute.toLocaleString('fr-FR')} €</span></div>
                <div className="flex justify-between"><span>- Passif déductible</span><span>- {ifi.passifDeductible.toLocaleString('fr-FR')} €</span></div>
                <div className="flex justify-between font-bold border-t pt-1 mt-1">
                  <span>Valeur nette taxable (case 9HM)</span>
                  <span>{(ifi.valeurBrute - ifi.passifDeductible).toLocaleString('fr-FR')} €</span>
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Barème IFI 2024" icon="📋" variant="info">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-600 border-b">
                  <th className="pb-2">Fraction de la valeur nette</th>
                  <th className="pb-2 text-right">Taux</th>
                </tr>
              </thead>
              <tbody className="space-y-1">
                {[
                  ['Jusqu\'à 800 000 €', '0%'],
                  ['De 800 001 € à 1 300 000 €', '0,50%'],
                  ['De 1 300 001 € à 2 570 000 €', '0,70%'],
                  ['De 2 570 001 € à 5 000 000 €', '1%'],
                  ['De 5 000 001 € à 10 000 000 €', '1,25%'],
                  ['Au-delà de 10 000 000 €', '1,50%'],
                ].map(([tranche, taux]) => (
                  <tr key={tranche} className="border-b border-gray-100">
                    <td className="py-1.5">{tranche}</td>
                    <td className="py-1.5 text-right font-medium text-blue-700">{taux}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SectionCard>
        </>
      ) : (
        <SectionCard title="Non assujetti" icon="✅" variant="success">
          <p className="text-sm text-green-800">
            Vous n'êtes pas soumis à l'IFI. Ce module ne génèrera pas de cases dans votre déclaration.
          </p>
        </SectionCard>
      )}
    </div>
  );
}
