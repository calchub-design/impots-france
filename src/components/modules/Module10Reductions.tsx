'use client';
import { TaxState } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { SectionCard, AlertBox } from '@/components/ui/SectionCard';

interface Props { state: TaxState; dispatch: React.Dispatch<TaxAction>; }

export function Module10Reductions({ state, dispatch }: Props) {
  const red = state.reductionsCreditImpot;
  const update = (changes: Partial<typeof red>) =>
    dispatch({ type: 'UPDATE_REDUCTIONS', payload: { ...red, ...changes } });

  const nbEnfants = state.situationPersonnelle.enfants.length;
  const plafEmploi = 12000 + nbEnfants * 1500;
  const creditEmploi = Math.min(red.emploiDomicile, plafEmploi) * 0.50;
  const creditGarde = (Math.min(red.gardeEnfant1, 3500) + Math.min(red.gardeEnfant2, 3500) + Math.min(red.gardeEnfant3, 3500)) * 0.50;

  // Dons
  const reductDonsUrgence = Math.min(red.donsUrgence, 1000) * 0.75 + Math.max(0, red.donsUrgence - 1000) * 0.66;
  const reductDonsAssoc = red.donsAssociations * 0.66;

  return (
    <div>
      <h2 className="text-2xl font-bold text-blue-900 mb-2">Réductions et crédits d'impôt</h2>
      <p className="text-gray-600 mb-6">Ces avantages fiscaux viennent directement en déduction de votre impôt calculé.</p>

      {/* Dons */}
      <SectionCard title="Dons et versements" icon="❤️">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <CurrencyInput
              label="Dons associations d'intérêt général — case 7UF"
              value={red.donsAssociations}
              onChange={v => update({ donsAssociations: v })}
              tooltip="Associations loi 1901 d'intérêt général : santé, culture, sport... Réduction d'impôt de 66% du montant versé dans la limite de 20% du revenu imposable."
            />
            {red.donsAssociations > 0 && <p className="text-xs text-green-600 mt-1">Réduction estimée : {Math.round(reductDonsAssoc).toLocaleString('fr-FR')} € (66%)</p>}
          </div>
          <div>
            <CurrencyInput
              label="Dons aux associations d'aide aux personnes — case 7UD"
              value={red.donsUrgence}
              onChange={v => update({ donsUrgence: v })}
              tooltip="Resto du Cœur, Croix-Rouge, Secours Catholique, Secours Populaire, Armée du Salut... 75% de réduction jusqu'à 1 000€, puis 66% au-delà."
            />
            {red.donsUrgence > 0 && <p className="text-xs text-green-600 mt-1">Réduction estimée : {Math.round(reductDonsUrgence).toLocaleString('fr-FR')} € (75% ≤ 1000€, 66% au-delà)</p>}
          </div>
          <CurrencyInput
            label="Dons aux partis politiques — case 7UH"
            value={red.donsPartis}
            onChange={v => update({ donsPartis: v })}
            tooltip="Versements aux partis politiques agréés. Réduction de 66%, plafonnée à 7 500€ par personne."
          />
        </div>
        <p className="text-xs text-gray-500 mt-2">Justificatif : reçu fiscal fourni par l'association (à conserver, ne pas envoyer)</p>
      </SectionCard>

      {/* Emploi à domicile */}
      <SectionCard title="Emploi à domicile" icon="🏡">
        <CurrencyInput
          label="Dépenses totales emploi à domicile (case 7DB)"
          value={red.emploiDomicile}
          onChange={v => update({ emploiDomicile: v })}
          tooltip="Ménage, jardinage, garde d'enfants à domicile, aide aux personnes âgées, soutien scolaire... Salaire brut + charges patronales, ou total CESU. Crédit d'impôt de 50%."
        />
        <div className="text-sm text-gray-600 mt-2 space-y-1">
          <p>Plafond de dépenses : <strong>{plafEmploi.toLocaleString('fr-FR')} €</strong> (12 000€ + 1 500€ × {nbEnfants} enfant(s))</p>
          {red.emploiDomicile > 0 && <p className="text-green-600">Crédit d'impôt estimé : <strong>{Math.round(creditEmploi).toLocaleString('fr-FR')} €</strong></p>}
        </div>
        <p className="text-xs text-gray-500 mt-2">Justificatif : attestation URSSAF annuelle ou relevé CESU (à conserver)</p>
      </SectionCard>

      {/* Garde d'enfants */}
      <SectionCard title="Frais de garde d'enfant hors domicile" icon="🧸">
        <AlertBox variant="info">
          Enfants de moins de 6 ans au 1er janvier 2024 gardés en crèche, halte-garderie, chez une assistante maternelle agréée ou dans un centre de loisirs. Crédit d'impôt 50% dans la limite de 3 500€/enfant.
        </AlertBox>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <CurrencyInput label="1er enfant (case 7GA)" value={red.gardeEnfant1} onChange={v => update({ gardeEnfant1: v })} />
            {red.gardeEnfant1 > 0 && <p className="text-xs text-green-600 mt-1">Crédit : {Math.min(red.gardeEnfant1, 3500) * 0.50} €</p>}
          </div>
          <div>
            <CurrencyInput label="2e enfant (case 7GB)" value={red.gardeEnfant2} onChange={v => update({ gardeEnfant2: v })} />
            {red.gardeEnfant2 > 0 && <p className="text-xs text-green-600 mt-1">Crédit : {Math.min(red.gardeEnfant2, 3500) * 0.50} €</p>}
          </div>
          <div>
            <CurrencyInput label="3e enfant (case 7GC)" value={red.gardeEnfant3} onChange={v => update({ gardeEnfant3: v })} />
            {red.gardeEnfant3 > 0 && <p className="text-xs text-green-600 mt-1">Crédit : {Math.min(red.gardeEnfant3, 3500) * 0.50} €</p>}
          </div>
        </div>
        {(red.gardeEnfant1 + red.gardeEnfant2 + red.gardeEnfant3) > 0 && (
          <p className="text-sm text-green-600 font-medium mt-2">Total crédits garde : {Math.round(creditGarde).toLocaleString('fr-FR')} €</p>
        )}
        <p className="text-xs text-gray-500 mt-2">Justificatif : attestation CAF, PAJE, ou de l'établissement (à conserver)</p>
      </SectionCard>

      {/* Enseignement */}
      <SectionCard title="Scolarité des enfants à charge" icon="🎓">
        <AlertBox variant="success">
          Aucun justificatif requis — déclaratif pur. Saisissez le nombre d'enfants par niveau.
        </AlertBox>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-sm font-medium text-gray-700">Enfants au collège (case 7EA)</label>
            <input
              type="number" min="0" max="10"
              value={red.enfantsCollege || ''}
              onChange={e => update({ enfantsCollege: parseInt(e.target.value) || 0 })}
              className="w-full mt-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            {red.enfantsCollege > 0 && <p className="text-xs text-green-600 mt-1">Réduction : {red.enfantsCollege * 61} € (61€/enfant)</p>}
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Enfants au lycée (case 7EC)</label>
            <input
              type="number" min="0" max="10"
              value={red.enfantsLycee || ''}
              onChange={e => update({ enfantsLycee: parseInt(e.target.value) || 0 })}
              className="w-full mt-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            {red.enfantsLycee > 0 && <p className="text-xs text-green-600 mt-1">Réduction : {red.enfantsLycee * 153} € (153€/enfant)</p>}
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Enfants dans le supérieur (case 7EF)</label>
            <input
              type="number" min="0" max="10"
              value={red.enfantsSup || ''}
              onChange={e => update({ enfantsSup: parseInt(e.target.value) || 0 })}
              className="w-full mt-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            {red.enfantsSup > 0 && <p className="text-xs text-green-600 mt-1">Réduction : {red.enfantsSup * 183} € (183€/enfant)</p>}
          </div>
        </div>
      </SectionCard>

      {/* Investissements */}
      <SectionCard title="Investissements locatifs défiscalisants" icon="🏗️">
        <AlertBox variant="warning">
          Ces dispositifs sont complexes — vérifiez avec votre gestionnaire de patrimoine les cases exactes selon votre contrat et l'année d'engagement.
        </AlertBox>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CurrencyInput
            label="Pinel / Denormandie — quote-part annuelle (case 7QA...)"
            value={red.investPinel}
            onChange={v => update({ investPinel: v })}
            tooltip="Saisissez le montant de la réduction annuelle indiqué sur votre contrat de défiscalisation, pas le montant de l'investissement total."
          />
          <CurrencyInput
            label="Souscription capital PME (case 7CF)"
            value={red.investPME}
            onChange={v => update({ investPME: v })}
            tooltip="Investissements dans le capital de PME non cotées éligibles. Réduction de 25% dans la limite de 50 000€."
          />
          <CurrencyInput
            label="FCPI / FIP (cases 7FQ, 7FM)"
            value={red.investFCPI}
            onChange={v => update({ investFCPI: v })}
            tooltip="Fonds Communs de Placement dans l'Innovation / Fonds d'Investissement de Proximité. Réduction de 18% dans la limite de 12 000€."
          />
        </div>
      </SectionCard>

      {/* Divers */}
      <SectionCard title="Divers" icon="🔖">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <CurrencyInput
              label="Cotisations syndicales (case 7AC)"
              value={red.cotisationsSyndicales}
              onChange={v => update({ cotisationsSyndicales: v })}
              tooltip="Cotisations versées à un syndicat de salariés ou de fonctionnaires. Crédit d'impôt de 66%."
            />
            {red.cotisationsSyndicales > 0 && <p className="text-xs text-green-600 mt-1">Crédit : {Math.round(red.cotisationsSyndicales * 0.66).toLocaleString('fr-FR')} €</p>}
            <p className="text-xs text-gray-500 mt-1">Justificatif : attestation syndicale (à conserver)</p>
          </div>
          <div>
            <CurrencyInput
              label="Frais de comptabilité — auto-entrepreneur au réel (case 7FF)"
              value={red.fraisComptabilite}
              onChange={v => update({ fraisComptabilite: v })}
              tooltip="Si vous êtes auto-entrepreneur au régime réel avec option, les frais d'adhésion à un centre de gestion agréé ou d'un comptable donnent droit à une réduction. Plafond 915€."
            />
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
