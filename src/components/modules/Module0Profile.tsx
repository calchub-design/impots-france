'use client';
import { TaxState } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { CheckboxField } from '@/components/ui/RadioGroup';
import { SectionCard } from '@/components/ui/SectionCard';

interface Props {
  state: TaxState;
  dispatch: React.Dispatch<TaxAction>;
}

const questions = [
  { key: 'salaires', label: 'Vous avez perçu des salaires ou traitements', desc: 'Employé(e), fonctionnaire, apprenti(e)...' },
  { key: 'retraite', label: 'Vous êtes retraité(e) ou avez perçu des allocations (chômage, maladie...)', desc: 'ARE, IJSS, pensions de retraite, invalidité...' },
  { key: 'independant', label: 'Vous exercez une activité indépendante ou êtes auto-entrepreneur', desc: 'Micro-entreprise, libéral, BNC, BIC, gérant SARL...' },
  { key: 'locationNue', label: 'Vous êtes propriétaire d\'un bien loué vide (location nue)', desc: 'Appartement ou maison loué sans meubles' },
  { key: 'locationMeublee', label: 'Vous êtes propriétaire d\'un bien loué meublé (LMNP / LMP)', desc: 'Location meublée, airbnb, saisonnier...' },
  { key: 'sci', label: 'Vous détenez des parts dans une SCI à l\'IR', desc: 'Société Civile Immobilière translucide fiscalement' },
  { key: 'patrimoinefinancier', label: 'Vous avez des revenus de placement (livrets, actions, dividendes)', desc: 'Intérêts, dividendes, plus-values, assurance-vie...' },
  { key: 'plusValues', label: 'Vous avez réalisé des plus-values (mobilières ou immobilières)', desc: 'Vente d\'actions, OPCVM, bien locatif...' },
  { key: 'chargesDeductibles', label: 'Vous avez des charges déductibles spécifiques ou crédits d\'impôt', desc: 'Dons, emploi à domicile, garde d\'enfants, PER...' },
] as const;

export function Module0Profile({ state, dispatch }: Props) {
  const toggle = (key: string, val: boolean) => {
    dispatch({ type: 'UPDATE_MODULES', payload: { [key]: val } });
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-blue-900 mb-2">Votre profil</h2>
        <p className="text-gray-600">Sélectionnez tout ce qui vous concerne. Seules les sections pertinentes vous seront présentées.</p>
      </div>

      <SectionCard title="Quelle est votre situation en 2025 ?" icon="✅">
        <div className="space-y-4">
          {questions.map(q => (
            <div key={q.key} className="flex flex-col gap-0.5">
              <CheckboxField
                label={q.label}
                checked={state.modules[q.key as keyof typeof state.modules]}
                onChange={v => toggle(q.key, v)}
              />
              <p className="text-xs text-gray-500 ml-8">{q.desc}</p>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 text-sm text-blue-800">
        <strong>Vos données restent sur votre appareil.</strong> Rien n'est envoyé à un serveur.
        La sauvegarde est automatique dans votre navigateur.
      </div>
    </div>
  );
}
