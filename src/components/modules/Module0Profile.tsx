'use client';
import { TaxState, AnneeDeclaration } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { CheckboxField } from '@/components/ui/RadioGroup';
import { SectionCard } from '@/components/ui/SectionCard';
import { PARAMS_2025, PARAMS_2026 } from '@/lib/calculations';

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

const ANNEES: { value: AnneeDeclaration; params: typeof PARAMS_2026 }[] = [
  { value: 2026, params: PARAMS_2026 },
  { value: 2025, params: PARAMS_2025 },
];

export function Module0Profile({ state, dispatch }: Props) {
  const toggle = (key: string, val: boolean) => {
    dispatch({ type: 'UPDATE_MODULES', payload: { [key]: val } });
  };

  const annee = state.anneeDeclaration ?? 2026;

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-blue-900 mb-2">Votre profil</h2>
        <p className="text-gray-600">Sélectionnez tout ce qui vous concerne. Seules les sections pertinentes vous seront présentées.</p>
      </div>

      {/* Sélecteur d'année fiscale */}
      <div className="mb-5 rounded-2xl border-2 border-blue-600 bg-blue-600 p-1 flex gap-1">
        {ANNEES.map(({ value, params }) => (
          <button
            key={value}
            onClick={() => dispatch({ type: 'SET_ANNEE', payload: value })}
            className={`flex-1 rounded-xl py-3 px-4 text-sm font-semibold transition-all ${
              annee === value
                ? 'bg-white text-blue-800 shadow-md'
                : 'text-blue-100 hover:bg-blue-500'
            }`}
          >
            <span className="block text-base font-bold">{params.libelleDeclaration.split(' — ')[0]}</span>
            <span className={`block text-xs mt-0.5 ${annee === value ? 'text-blue-600' : 'text-blue-200'}`}>
              {params.libelleDeclaration.split(' — ')[1]}
              {value === 2026 && <span className="ml-2 bg-blue-600 text-white rounded px-1 py-0.5 text-[10px] font-bold">Par défaut</span>}
            </span>
          </button>
        ))}
      </div>

      {/* Info barème sélectionné */}
      <div className="mb-5 rounded-xl bg-gray-50 border border-gray-200 p-3 text-xs text-gray-600 grid grid-cols-3 gap-2">
        <div className="text-center">
          <p className="font-semibold text-gray-800">Tranche 11%</p>
          <p>jusqu'à {annee === 2026 ? '29 579' : '28 797'} €</p>
        </div>
        <div className="text-center">
          <p className="font-semibold text-gray-800">Tranche 30%</p>
          <p>jusqu'à {annee === 2026 ? '84 577' : '82 341'} €</p>
        </div>
        <div className="text-center">
          <p className="font-semibold text-gray-800">Plafond frais pro</p>
          <p>{annee === 2026 ? '14 555' : '14 426'} €</p>
        </div>
      </div>

      <SectionCard title={`Quelle est votre situation en ${annee === 2026 ? '2025' : '2024'} ?`} icon="✅">
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
