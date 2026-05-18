'use client';
import { TaxState } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { SectionCard, AlertBox } from '@/components/ui/SectionCard';

interface Props { state: TaxState; dispatch: React.Dispatch<TaxAction>; }

export function Module6LMNP({ state, dispatch }: Props) {
  const lmnp = state.revenusLMNP;
  const update = (changes: Partial<typeof lmnp>) =>
    dispatch({ type: 'UPDATE_LMNP', payload: { ...lmnp, ...changes } });
  const updateChg = (changes: Partial<typeof lmnp.charges>) =>
    update({ charges: { ...lmnp.charges, ...changes } });

  const seuilMicro = 77700;
  const chargesTotal = Object.values(lmnp.charges).reduce((a, b) => a + b, 0);
  const benefReel = Math.max(0, lmnp.recettes - chargesTotal);
  const benefMicro = lmnp.recettes * 0.50;
  const isLMP = lmnp.statut === 'lmp';

  return (
    <div>
      <h2 className="text-2xl font-bold text-blue-900 mb-2">Location meublée (LMNP)</h2>
      <p className="text-gray-600 mb-6">Cases 5ND / 5NA. Pour les locations avec meubles (appartement meublé, Airbnb, saisonnier...).</p>

      <SectionCard title="Statut et régime" icon="🏠">
        <RadioGroup<'lmnp' | 'lmp'>
          label="Votre statut"
          value={lmnp.statut}
          onChange={v => update({ statut: v })}
          options={[
            { value: 'lmnp', label: 'LMNP (Loueur Meublé Non Professionnel)' },
            { value: 'lmp', label: 'LMP (Loueur Meublé Professionnel)' },
          ]}
          tooltip="Le statut LMP s'applique si vos recettes locatives meublées dépassent 23 000€ ET représentent plus de la moitié des revenus de votre foyer."
        />
        {isLMP && (
          <AlertBox variant="warning">
            Le statut LMP a des règles spécifiques (imposition des plus-values, exonération possible, cotisations sociales...). Ce simulateur couvre le cas général mais nous recommandons un expert-comptable pour ce statut.
          </AlertBox>
        )}

        <div className="mt-4">
          <CurrencyInput
            label="Recettes annuelles de location meublée (loyers + charges)"
            value={lmnp.recettes}
            onChange={v => update({ recettes: v })}
            tooltip="Total des loyers encaissés en 2024, charges comprises. Pour les locations meublées courte durée (Airbnb), il s'agit des paiements effectivement reçus."
          />
        </div>

        {lmnp.recettes > 0 && lmnp.recettes <= seuilMicro && (
          <div className="mt-4">
            <RadioGroup<'micro' | 'reel'>
              label="Régime fiscal"
              value={lmnp.regime || 'micro'}
              onChange={v => update({ regime: v })}
              tooltip="Micro-BIC : abattement automatique de 50%, aucune comptabilité requise. Régime réel : déduction de toutes les charges réelles + amortissements (très avantageux mais nécessite un expert-comptable)."
              options={[
                { value: 'micro', label: `Micro-BIC (abattement 50% = ${Math.round(lmnp.recettes * 0.5).toLocaleString('fr-FR')} €)` },
                { value: 'reel', label: 'Régime réel simplifié (charges + amortissements)' },
              ]}
            />
          </div>
        )}
        {lmnp.recettes > seuilMicro && (
          <AlertBox variant="warning">
            Vos recettes ({lmnp.recettes.toLocaleString('fr-FR')} €) dépassent le seuil micro-BIC de {seuilMicro.toLocaleString('fr-FR')} € — le régime réel est obligatoire.
          </AlertBox>
        )}
      </SectionCard>

      {lmnp.regime === 'reel' && (
        <SectionCard title="Charges déductibles (régime réel)" icon="📋">
          <AlertBox variant="info">
            Le régime réel LMNP est très avantageux grâce à l'amortissement du bien. Nous vous aidons à préparer les chiffres, mais une déclaration 2031-SD est nécessaire — souvent avec l'aide d'un expert-comptable.
          </AlertBox>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <CurrencyInput label="Charges de copropriété" value={lmnp.charges.chargesCopro} onChange={v => updateChg({ chargesCopro: v })} />
            <CurrencyInput label="Intérêts d'emprunt" value={lmnp.charges.interetsEmprunt} onChange={v => updateChg({ interetsEmprunt: v })} />
            <CurrencyInput label="Assurance emprunt (ADI)" value={lmnp.charges.assuranceADI} onChange={v => updateChg({ assuranceADI: v })} />
            <CurrencyInput label="Assurance PNO" value={lmnp.charges.assurancePNO} onChange={v => updateChg({ assurancePNO: v })} />
            <CurrencyInput label="Taxe foncière" value={lmnp.charges.taxeFonciere} onChange={v => updateChg({ taxeFonciere: v })} />
            <CurrencyInput label="Frais de gestion / agence" value={lmnp.charges.fraisGestion} onChange={v => updateChg({ fraisGestion: v })} />
            <CurrencyInput label="Travaux d'entretien déductibles" value={lmnp.charges.travauxEntretien} onChange={v => updateChg({ travauxEntretien: v })} />
          </div>

          <div className="mt-5 border-t pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">Amortissements</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <CurrencyInput
                label="Amortissement du bien (hors terrain, ~2-3%/an)"
                value={lmnp.charges.amortissementBien}
                onChange={v => updateChg({ amortissementBien: v })}
                tooltip="Calculé par votre expert-comptable sur la valeur du bâti hors terrain. En général 2 à 3% de la valeur du bien par an."
              />
              <CurrencyInput
                label="Amortissement du mobilier (~10-20%/an)"
                value={lmnp.charges.amortissementMobilier}
                onChange={v => updateChg({ amortissementMobilier: v })}
                tooltip="Amortissement des meubles et équipements. En général 10 à 20% de la valeur du mobilier par an."
              />
              <CurrencyInput
                label="Amortissement des travaux immobilisés"
                value={lmnp.charges.amortissementTravaux}
                onChange={v => updateChg({ amortissementTravaux: v })}
                tooltip="Si certains travaux ont été immobilisés plutôt que passés en charges, ils sont amortis sur leur durée de vie."
              />
            </div>
            <AlertBox variant="success">
              Les amortissements ne peuvent pas créer de déficit (règle LMNP spécifique). L'excédent est reporté sans limite de durée.
            </AlertBox>
          </div>

          <div className="mt-4 bg-blue-50 rounded-lg p-4 text-sm">
            <div className="flex justify-between"><span className="text-gray-600">Recettes</span><span>{lmnp.recettes.toLocaleString('fr-FR')} €</span></div>
            <div className="flex justify-between"><span className="text-gray-600">- Charges totales</span><span>- {chargesTotal.toLocaleString('fr-FR')} €</span></div>
            <div className={`flex justify-between font-bold border-t pt-1 mt-1 ${benefReel > 0 ? 'text-gray-900' : 'text-orange-700'}`}>
              <span>= Résultat LMNP</span>
              <span>{benefReel > 0 ? `${benefReel.toLocaleString('fr-FR')} €` : `Reportable : ${Math.abs(lmnp.recettes - chargesTotal).toLocaleString('fr-FR')} €`}</span>
            </div>
            {benefReel > 0 && <p className="text-xs text-blue-700 mt-1">→ Case 5NA</p>}
          </div>
        </SectionCard>
      )}

      {lmnp.regime === 'micro' && lmnp.recettes > 0 && (
        <SectionCard title="Résumé micro-BIC" icon="✅" variant="success">
          <div className="space-y-1 text-sm">
            <div className="flex justify-between"><span>Recettes</span><span>{lmnp.recettes.toLocaleString('fr-FR')} €</span></div>
            <div className="flex justify-between text-green-600"><span>- Abattement 50%</span><span>- {Math.round(lmnp.recettes * 0.5).toLocaleString('fr-FR')} €</span></div>
            <div className="flex justify-between font-bold border-t pt-1"><span>= Base imposable (case 5ND)</span><span>{Math.round(benefMicro).toLocaleString('fr-FR')} €</span></div>
          </div>
          <p className="text-xs text-gray-500 mt-2">Aucun justificatif requis — abattement forfaitaire automatique</p>
        </SectionCard>
      )}

      <SectionCard title="CFE (Cotisation Foncière des Entreprises)" icon="ℹ️" variant="info">
        <p className="text-sm text-blue-800">
          En tant que LMNP, vous êtes soumis à la CFE (impôt local des entreprises).
          Elle est calculée par votre commune et fait l'objet d'un avis d'imposition séparé.
          Elle n'est <strong>pas</strong> déclarée sur votre déclaration de revenus (formulaire 2042).
        </p>
      </SectionCard>
    </div>
  );
}
