'use client';
import { TaxState } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { SectionCard, AlertBox } from '@/components/ui/SectionCard';

interface Props { state: TaxState; dispatch: React.Dispatch<TaxAction>; }

export function Module7SCI({ state, dispatch }: Props) {
  const sci = state.revenusSCI;
  const update = (changes: Partial<typeof sci>) =>
    dispatch({ type: 'UPDATE_SCI', payload: { ...sci, ...changes } });

  return (
    <div>
      <h2 className="text-2xl font-bold text-blue-900 mb-2">SCI — Société Civile Immobilière</h2>
      <p className="text-gray-600 mb-6">Quote-part des revenus d'une SCI à l'IR à reporter dans votre déclaration personnelle.</p>

      <SectionCard title="Type de SCI" icon="🏗️">
        <RadioGroup<'ir' | 'is'>
          label="Régime fiscal de la SCI"
          value={sci.typeSCI}
          onChange={v => update({ typeSCI: v })}
          options={[
            { value: 'ir', label: 'SCI à l\'IR (transparente)' },
            { value: 'is', label: 'SCI à l\'IS (opaque)' },
          ]}
          tooltip="La SCI à l'IR est fiscalement transparente : chaque associé déclare sa quote-part. La SCI à l'IS est opaque : les distributions sont des dividendes, pas des revenus fonciers."
        />

        {sci.typeSCI === 'is' && (
          <AlertBox variant="warning">
            Votre SCI est à l'IS. Les revenus distribués sont des <strong>dividendes</strong> — à déclarer dans le module Revenus du patrimoine (case 2DC), pas ici.
          </AlertBox>
        )}
      </SectionCard>

      {sci.typeSCI === 'ir' && (
        <>
          <SectionCard title="Votre quote-part dans la SCI" icon="📊">
            <AlertBox variant="info">
              La SCI à l'IR est fiscalement transparente : votre quote-part de résultat s'ajoute directement à vos revenus fonciers directs (cases 4BA ou déficit 4BC/4BD). Mêmes règles que pour la location directe.
            </AlertBox>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <CurrencyInput
                label="Quote-part de résultat foncier net (si bénéfice)"
                value={sci.quotePartResultat}
                onChange={v => update({ quotePartResultat: v, quotePartDeficit: 0 })}
                tooltip="Montant figurant sur le relevé annuel de la SCI, au prorata de votre participation. S'additionne à vos revenus fonciers directs."
              />
              <CurrencyInput
                label="Quote-part de déficit foncier (si déficit)"
                value={sci.quotePartDeficit}
                onChange={v => update({ quotePartDeficit: v, quotePartResultat: 0 })}
                tooltip="En cas de déficit de la SCI, votre quote-part s'impute selon les mêmes règles : 10 700€ max sur revenu global, excédent reportable 10 ans."
              />
            </div>
            <p className="text-xs text-gray-500 mt-2">Justificatif : relevé annuel de la SCI (à conserver)</p>
          </SectionCard>

          <SectionCard title="Information" icon="ℹ️" variant="info">
            <p className="text-sm text-blue-800">
              Votre SCI doit déposer sa propre déclaration <strong>2072</strong> auprès du fisc.
              Ce simulateur traite uniquement votre quote-part personnelle à reporter dans votre déclaration 2042.
            </p>
          </SectionCard>
        </>
      )}
    </div>
  );
}
