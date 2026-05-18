'use client';
import { TaxState } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { SectionCard, AlertBox } from '@/components/ui/SectionCard';
import { calculerFraisReels, calculerFraisForfait } from '@/lib/calculations';

interface Props {
  state: TaxState;
  dispatch: React.Dispatch<TaxAction>;
}

const estCouple = (state: TaxState) => state.situationPersonnelle.situationMaritale === 'marie_pacse';

function PersonBlock({ qui, label, state, dispatch }: {
  qui: 'declarant' | 'conjoint';
  label: string;
  state: TaxState;
  dispatch: React.Dispatch<TaxAction>;
}) {
  const d = state.revenusSalariaux[qui];
  const salaireBrut = d.salaires + d.avantagesNature;
  const forfait = calculerFraisForfait(salaireBrut);
  const reels = calculerFraisReels(state, qui);
  const recommande = reels > forfait ? 'reel' : 'forfait';

  const update = (changes: Partial<typeof d>) => {
    const updated = { ...state.revenusSalariaux, [qui]: { ...d, ...changes } };
    dispatch({ type: 'UPDATE_SALAIRES', payload: updated });
  };
  const updateFR = (changes: Partial<typeof d.fraisReels>) => {
    update({ fraisReels: { ...d.fraisReels, ...changes } });
  };

  return (
    <SectionCard title={label} icon="💼">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <CurrencyInput
          label="Salaires bruts déclarés"
          value={d.salaires}
          onChange={v => update({ salaires: v })}
          tooltip="Montant figurant sur votre AER (Attestation Employeur Remise) ou sur votre fiche de paie de décembre. Chiffre pré-rempli sur votre déclaration à vérifier."
        />
        <CurrencyInput
          label="Avantages en nature"
          value={d.avantagesNature}
          onChange={v => update({ avantagesNature: v })}
          tooltip="Voiture de fonction, logement de fonction... Montant indiqué sur votre bulletin de salaire."
        />
        <CurrencyInput
          label="Heures supplémentaires exonérées (case 1GH)"
          value={d.heuresSup}
          onChange={v => update({ heuresSup: v })}
          tooltip="Les heures supplémentaires sont exonérées d'impôt dans la limite de 7 500€/an. Ce montant est distinct de vos salaires et figure sur votre fiche de paie."
        />
      </div>

      <div className="mt-5">
        <RadioGroup<'forfait' | 'reel'>
          label="Déduction des frais professionnels"
          value={d.fraisPro}
          onChange={v => update({ fraisPro: v })}
          tooltip="Le forfait 10% est automatique et ne nécessite aucun justificatif. Les frais réels sont plus avantageux si vous avez de nombreux déplacements."
          options={[
            { value: 'forfait', label: `Forfait 10% (${forfait.toLocaleString('fr-FR')} €)` },
            { value: 'reel', label: 'Frais réels (détail ci-dessous)' },
          ]}
        />
        {recommande === 'reel' && d.fraisPro === 'forfait' && (
          <AlertBox variant="info">
            Avec vos frais réels saisis, vous devriez opter pour les frais réels ({reels.toLocaleString('fr-FR')} € vs forfait {forfait.toLocaleString('fr-FR')} €) — gain estimé de {(reels - forfait).toLocaleString('fr-FR')} €.
          </AlertBox>
        )}
      </div>

      {d.fraisPro === 'reel' && (
        <div className="mt-4 space-y-4 border-l-4 border-blue-200 pl-4">
          <p className="text-sm text-gray-600 font-medium">Détail des frais réels 2024</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-gray-700">Kilomètres domicile-travail</label>
              <input
                type="number" min="0"
                value={d.fraisReels.km || ''}
                placeholder="0"
                onChange={e => updateFR({ km: parseFloat(e.target.value) || 0 })}
                className="w-full mt-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700">Type de véhicule</label>
              <select
                value={d.fraisReels.typeVehicule}
                onChange={e => updateFR({ typeVehicule: e.target.value as 'voiture' | 'moto' | 'velo' })}
                className="w-full mt-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="voiture">Voiture</option>
                <option value="moto">Moto / scooter</option>
                <option value="velo">Vélo / trottinette</option>
              </select>
            </div>
            {d.fraisReels.typeVehicule === 'voiture' && (
              <div>
                <label className="text-sm font-medium text-gray-700">Puissance fiscale du véhicule</label>
                <select
                  value={d.fraisReels.cylindree}
                  onChange={e => updateFR({ cylindree: e.target.value as typeof d.fraisReels.cylindree })}
                  className="w-full mt-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  <option value="3cv">3 CV et moins</option>
                  <option value="4cv">4 CV</option>
                  <option value="5cv">5 CV</option>
                  <option value="6cv">6 CV</option>
                  <option value="7cv_plus">7 CV et plus</option>
                </select>
              </div>
            )}
          </div>
          {d.fraisReels.km > 0 && (
            <AlertBox variant="success">
              Frais kilométriques calculés : <strong>{Math.round(calculerFraisReels(state, qui)).toLocaleString('fr-FR')} €</strong> — aucun justificatif requis si vous appliquez le barème kilométrique officiel.
            </AlertBox>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <CurrencyInput label="Frais de repas" value={d.fraisReels.repas} onChange={v => updateFR({ repas: v })} tooltip="Différence entre le repas sur place et le repas pris à domicile (environ 5€/repas de référence)." />
            <CurrencyInput label="Frais de formation professionnelle" value={d.fraisReels.formation} onChange={v => updateFR({ formation: v })} tooltip="Formations directement liées à votre activité professionnelle actuelle." />
            <CurrencyInput label="Frais de double résidence" value={d.fraisReels.doubleResidence} onChange={v => updateFR({ doubleResidence: v })} tooltip="Si vous avez deux résidences pour raisons professionnelles : loyer, charges, frais de transport..." />
            <CurrencyInput label="Autres frais professionnels" value={d.fraisReels.autresFrais} onChange={v => updateFR({ autresFrais: v })} tooltip="Matériel, abonnement téléphone professionnel, documentation..." />
          </div>
          <div className="bg-blue-50 rounded-lg p-3 text-sm">
            <span className="font-medium">Total frais réels : </span>
            <span className="text-blue-800 font-bold">{Math.round(reels).toLocaleString('fr-FR')} €</span>
            <span className="text-gray-600 ml-2">(forfait serait : {Math.round(forfait).toLocaleString('fr-FR')} €)</span>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

export function Module2Salaires({ state, dispatch }: Props) {
  const couple = estCouple(state);
  return (
    <div>
      <h2 className="text-2xl font-bold text-blue-900 mb-2">Revenus salariaux</h2>
      <p className="text-gray-600 mb-6">Cases 1AJ / 1BJ. Ces montants sont pré-remplis par votre employeur — vérifiez-les sur votre avis d'imposition ou AER.</p>

      <PersonBlock qui="declarant" label="Vous" state={state} dispatch={dispatch} />
      {couple && <PersonBlock qui="conjoint" label="Conjoint(e)" state={state} dispatch={dispatch} />}
    </div>
  );
}
