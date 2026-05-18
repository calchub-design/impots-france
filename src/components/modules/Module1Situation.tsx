'use client';
import { TaxState, Enfant, SituationMaritale } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { RadioGroup, CheckboxField } from '@/components/ui/RadioGroup';
import { SectionCard } from '@/components/ui/SectionCard';
import { calculerParts } from '@/lib/calculations';
import { Plus, Trash2 } from 'lucide-react';

interface Props {
  state: TaxState;
  dispatch: React.Dispatch<TaxAction>;
}

export function Module1Situation({ state, dispatch }: Props) {
  const sp = state.situationPersonnelle;
  const parts = calculerParts(state);
  const estCouple = sp.situationMaritale === 'marie_pacse';

  const update = (payload: Partial<TaxState['situationPersonnelle']>) =>
    dispatch({ type: 'UPDATE_SITUATION', payload });

  const addEnfant = () => {
    const newEnfant: Enfant = { id: Date.now().toString(), age: 10, gardeAlternee: false };
    update({ enfants: [...sp.enfants, newEnfant] });
  };

  const removeEnfant = (id: string) =>
    update({ enfants: sp.enfants.filter(e => e.id !== id) });

  const updateEnfant = (id: string, changes: Partial<Enfant>) =>
    update({ enfants: sp.enfants.map(e => e.id === id ? { ...e, ...changes } : e) });

  return (
    <div>
      <h2 className="text-2xl font-bold text-blue-900 mb-2">Situation personnelle</h2>
      <p className="text-gray-600 mb-6">Ces informations déterminent votre quotient familial et votre nombre de parts fiscales.</p>

      <SectionCard title="Situation maritale" icon="👤">
        <RadioGroup<SituationMaritale>
          value={sp.situationMaritale}
          options={[
            { value: 'celibataire', label: 'Célibataire' },
            { value: 'marie_pacse', label: 'Marié(e) / Pacsé(e)' },
            { value: 'divorce', label: 'Divorcé(e)' },
            { value: 'veuf', label: 'Veuf/Veuve' },
          ]}
          onChange={v => update({ situationMaritale: v })}
        />

        <div className="grid grid-cols-2 gap-4 mt-4">
          <div>
            <label className="text-sm font-medium text-gray-700">Année de naissance (vous)</label>
            <input
              type="number"
              min="1920" max="2006"
              value={sp.anneeNaissanceDeclarant}
              onChange={e => update({ anneeNaissanceDeclarant: e.target.value })}
              placeholder="ex: 1980"
              className="w-full mt-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          {estCouple && (
            <div>
              <label className="text-sm font-medium text-gray-700">Année de naissance (conjoint)</label>
              <input
                type="number"
                min="1920" max="2006"
                value={sp.anneeNaissanceConjoint}
                onChange={e => update({ anneeNaissanceConjoint: e.target.value })}
                placeholder="ex: 1982"
                className="w-full mt-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Enfants à charge" icon="👶">
        {sp.enfants.map((enfant, idx) => (
          <div key={enfant.id} className="flex flex-wrap items-center gap-3 mb-3 p-3 bg-gray-50 rounded-lg">
            <span className="text-sm font-medium text-gray-600 w-20">Enfant {idx + 1}</span>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500">Âge :</label>
              <input
                type="number" min="0" max="25"
                value={enfant.age}
                onChange={e => updateEnfant(enfant.id, { age: parseInt(e.target.value) || 0 })}
                className="w-16 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <CheckboxField
              label="Garde alternée"
              checked={enfant.gardeAlternee}
              onChange={v => updateEnfant(enfant.id, { gardeAlternee: v })}
              tooltip="En garde alternée, vous bénéficiez d'une demi-part au lieu d'une part entière (+0,25 au lieu de +0,5 pour les 2 premiers enfants)"
            />
            <button
              onClick={() => removeEnfant(enfant.id)}
              className="ml-auto text-red-400 hover:text-red-600 transition-colors"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        <button
          onClick={addEnfant}
          className="flex items-center gap-2 text-blue-600 hover:text-blue-800 text-sm font-medium mt-2 transition-colors"
        >
          <Plus size={16} />
          Ajouter un enfant
        </button>
      </SectionCard>

      <SectionCard title="Situations particulières" icon="⭐">
        <div className="space-y-3">
          <CheckboxField
            label="Parent isolé (case T)"
            checked={sp.parentIsole}
            onChange={v => update({ parentIsole: v })}
            tooltip="Parent célibataire, divorcé ou veuf avec enfant(s) à charge. Donne droit à une demi-part supplémentaire."
          />
          <CheckboxField
            label="Vous êtes invalide ou titulaire de la carte mobilité inclusion (case P)"
            checked={sp.invalide}
            onChange={v => update({ invalide: v })}
            tooltip="Titulaire d'une carte d'invalidité ou d'une pension d'invalidité ≥ 40% : +0,5 part fiscale."
          />
          <CheckboxField
            label="Vous êtes ancien combattant / titulaire d'une pension militaire > 75 ans (case G)"
            checked={sp.ancienCombattant}
            onChange={v => update({ ancienCombattant: v })}
            tooltip="Si vous êtes âgé de plus de 75 ans et titulaire de certaines pensions militaires : +0,5 part."
          />
          {estCouple && (
            <CheckboxField
              label="Votre conjoint est invalide (case W)"
              checked={sp.invalideConjoint}
              onChange={v => update({ invalideConjoint: v })}
              tooltip="Si votre conjoint est titulaire d'une carte d'invalidité : +0,5 part."
            />
          )}
        </div>
      </SectionCard>

      {/* Résumé parts */}
      <div className="rounded-xl bg-blue-600 text-white p-5 mt-2">
        <div className="text-sm opacity-80 mb-1">Nombre de parts fiscales calculé</div>
        <div className="text-4xl font-bold">{parts.toFixed(1)}</div>
        <div className="text-sm opacity-80 mt-1">
          {parts === 1 ? 'Célibataire sans enfant' :
           parts === 2 ? 'Couple sans enfant' :
           `Foyer avec ${sp.enfants.length} enfant(s)`}
        </div>
      </div>
    </div>
  );
}
