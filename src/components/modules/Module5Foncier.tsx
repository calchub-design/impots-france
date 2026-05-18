'use client';
import { TaxState } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { RadioGroup, CheckboxField } from '@/components/ui/RadioGroup';
import { SectionCard, AlertBox } from '@/components/ui/SectionCard';
import { calculerFoncier } from '@/lib/calculations';

interface Props { state: TaxState; dispatch: React.Dispatch<TaxAction>; }

function fmt(n: number) {
  return n.toLocaleString('fr-FR') + ' €';
}

export function Module5Foncier({ state, dispatch }: Props) {
  const f = state.revenusFonciers;
  const update = (changes: Partial<typeof f>) =>
    dispatch({ type: 'UPDATE_FONCIERS', payload: { ...f, ...changes } });
  const updateRec = (changes: Partial<typeof f.recettes>) =>
    update({ recettes: { ...f.recettes, ...changes } });
  const updateChg = (changes: Partial<typeof f.charges>) =>
    update({ charges: { ...f.charges, ...changes } });

  const totalLoyers = f.recettes.loyersNus + f.recettes.chargesRecuperees + f.recettes.subventionsANAH;
  const regimeObligatoire = totalLoyers >= 15000;
  const aEmprunt = f.charges.interetsEmprunt > 0;
  const calc = calculerFoncier(state);

  return (
    <div>
      <h2 className="text-2xl font-bold text-blue-900 mb-2">Revenus fonciers — Location nue</h2>
      <p className="text-gray-600 mb-6">Cases 4BA / 4BE / 4BC / 4BD. Pour les biens loués sans meubles.</p>

      {/* Choix du régime */}
      <SectionCard title="Choix du régime fiscal" icon="⚖️">
        <CurrencyInput
          label="Total des loyers nus encaissés en 2024 (tous biens)"
          value={f.microFoncierCA}
          onChange={v => update({ microFoncierCA: v, recettes: { ...f.recettes, loyersNus: v } })}
          tooltip="Loyers hors charges. Sert à choisir le régime."
        />

        {f.microFoncierCA > 0 && (
          <div className="mt-4">
            {regimeObligatoire ? (
              <AlertBox variant="warning">
                Vos loyers dépassent 15 000 € — le <strong>régime réel</strong> est obligatoire. Vous ne pouvez pas utiliser le micro-foncier.
              </AlertBox>
            ) : aEmprunt ? (
              <AlertBox variant="warning">
                Vous avez un emprunt locatif en cours — le <strong>régime réel</strong> est fortement recommandé car les intérêts d'emprunt sont déductibles, ce qui n'est pas possible en micro-foncier.
              </AlertBox>
            ) : null}

            {!regimeObligatoire && (
              <RadioGroup<'micro' | 'reel'>
                label="Régime fiscal"
                value={f.regime || 'micro'}
                onChange={v => update({ regime: v })}
                tooltip="Micro-foncier : abattement automatique de 30%, aucun justificatif. Régime réel : déduction de toutes vos charges réelles (souvent plus avantageux avec un emprunt)."
                options={[
                  { value: 'micro', label: `Micro-foncier (abattement 30% = ${Math.round(f.microFoncierCA * 0.3).toLocaleString('fr-FR')} €)` },
                  { value: 'reel', label: 'Régime réel (déduction des charges réelles)' },
                ]}
              />
            )}
            {regimeObligatoire && f.regime !== 'reel' ? (update({ regime: 'reel' }), null) : null}
          </div>
        )}
      </SectionCard>

      {(f.regime === 'reel' || (f.microFoncierCA > 0 && regimeObligatoire)) && (
        <>
          {/* Recettes */}
          <SectionCard title="Recettes à déclarer" icon="💰">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <CurrencyInput
                label="Loyers nus encaissés en 2024"
                value={f.recettes.loyersNus}
                onChange={v => updateRec({ loyersNus: v })}
                tooltip="Loyers perçus de vos locataires, hors charges locatives. Ne pas inclure les dépôts de garantie."
              />
              <CurrencyInput
                label="Charges récupérées sur le locataire"
                value={f.recettes.chargesRecuperees}
                onChange={v => updateRec({ chargesRecuperees: v })}
                tooltip="Charges que vous avez récupérées auprès du locataire (eau, ordures ménagères...). Elles sont à la fois une recette ET une charge — elles se neutralisent."
              />
              <CurrencyInput
                label="Subventions ANAH perçues pour travaux"
                value={f.recettes.subventionsANAH}
                onChange={v => updateRec({ subventionsANAH: v })}
                tooltip="Les aides ANAH sont imposables en tant que revenus fonciers."
              />
            </div>
            <AlertBox variant="info">
              Les <strong>dépôts de garantie</strong> ne sont pas des recettes tant qu'ils ne sont pas définitivement acquis.
            </AlertBox>
          </SectionCard>

          {/* Charges copropriété */}
          <SectionCard title="Charges de copropriété" icon="🏢">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <CurrencyInput
                label="Charges courantes appelées par le syndic en 2024"
                value={f.charges.chargesCopro}
                onChange={v => updateChg({ chargesCopro: v })}
                tooltip="Montant total appelé par le syndic en 2024. À déduire : les charges récupérables sur le locataire."
              />
              <CurrencyInput
                label="Charges récupérables sur le locataire (à déduire)"
                value={f.charges.chargesRecupereesSurLocataire}
                onChange={v => updateChg({ chargesRecupereesSurLocataire: v })}
                tooltip="La part des charges de copropriété que vous avez refacturée au locataire n'est pas déductible car elle figure déjà en recette."
              />
            </div>
            <p className="text-xs text-gray-500 mt-2">Justificatif : relevé annuel du syndic (à conserver, ne pas envoyer)</p>
          </SectionCard>

          {/* Emprunt */}
          <SectionCard title="Emprunt immobilier locatif" icon="🏦">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <CurrencyInput
                label="Intérêts d'emprunt payés en 2024"
                value={f.charges.interetsEmprunt}
                onChange={v => updateChg({ interetsEmprunt: v })}
                tooltip="Intérêts uniquement (pas le capital). Disponible sur votre attestation fiscale annuelle fournie par votre banque."
              />
              <CurrencyInput
                label="Assurance décès-invalidité (ADI)"
                value={f.charges.assuranceADI}
                onChange={v => updateChg({ assuranceADI: v })}
                tooltip="Prime de l'assurance emprunteur liée au prêt. Déductible à 100%."
              />
              <CurrencyInput
                label="Frais de garantie (caution, hypothèque...)"
                value={f.charges.fraisGarantie}
                onChange={v => updateChg({ fraisGarantie: v })}
                tooltip="Frais de dossier bancaire, caution Crédit Logement, frais d'hypothèque ou PPD si le prêt a été contracté en 2024."
              />
              <CurrencyInput
                label="Frais de mainlevée hypothécaire"
                value={f.charges.mainleveeHypotheque}
                onChange={v => updateChg({ mainleveeHypotheque: v })}
                tooltip="Si vous avez remboursé votre prêt par anticipation et levé l'hypothèque en 2024."
              />
            </div>
            <AlertBox variant="warning">
              <strong>Règle importante :</strong> les intérêts d'emprunt ne peuvent pas créer de déficit imputable sur votre revenu global. Ils génèrent uniquement un déficit reportable sur les revenus fonciers des 10 années suivantes.
            </AlertBox>
            <p className="text-xs text-gray-500">Justificatif : attestation fiscale annuelle de la banque (à conserver)</p>
          </SectionCard>

          {/* Assurances */}
          <SectionCard title="Assurances" icon="🛡️">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <CurrencyInput
                label="Assurance PNO (Propriétaire Non Occupant)"
                value={f.charges.assurancePNO}
                onChange={v => updateChg({ assurancePNO: v })}
                tooltip="Assurance couvrant le bien lorsqu'il est loué. Prime annuelle déductible à 100%."
              />
              <CurrencyInput
                label="Assurance loyers impayés (GLI)"
                value={f.charges.assuranceGLI}
                onChange={v => updateChg({ assuranceGLI: v })}
                tooltip="Garantie Loyers Impayés. Prime annuelle déductible à 100%."
              />
            </div>
            <p className="text-xs text-gray-500 mt-2">Justificatif : attestation assureur (à conserver)</p>
          </SectionCard>

          {/* Taxe foncière */}
          <SectionCard title="Taxe foncière" icon="📄">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <CurrencyInput
                label="Taxe foncière 2024 (montant total)"
                value={f.charges.taxeFonciere}
                onChange={v => updateChg({ taxeFonciere: v })}
                tooltip="Montant figurant sur votre avis de taxe foncière 2024. Déductible sauf la TEOM si récupérée sur le locataire."
              />
            </div>
            <div className="mt-3">
              <CheckboxField
                label="La TEOM (ordures ménagères) est récupérée sur le locataire"
                checked={f.charges.teomRecuperee}
                onChange={v => updateChg({ teomRecuperee: v })}
                tooltip="Si vous récupérez la TEOM auprès de votre locataire, vous ne pouvez pas la déduire (elle figure aussi en recette)."
              />
            </div>
            <p className="text-xs text-gray-500 mt-2">Justificatif : avis de taxe foncière 2024 (à conserver)</p>
          </SectionCard>

          {/* Frais de gestion */}
          <SectionCard title="Frais de gestion" icon="🏠">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <CurrencyInput
                label="Honoraires d'agence (gestion, mise en location, renouvellement)"
                value={f.charges.fraisGestionAgence}
                onChange={v => updateChg({ fraisGestionAgence: v })}
                tooltip="Tous les honoraires versés à l'agence gestionnaire : frais de gestion courants, honoraires de mise en location, renouvellement de bail..."
              />
              <div>
                <CurrencyInput
                  label="Gestion directe — nombre de locaux"
                  value={f.charges.fraisGestionDirectNbLocaux}
                  onChange={v => updateChg({ fraisGestionDirectNbLocaux: v })}
                  suffix="locaux"
                  tooltip="Si vous gérez vous-même, vous pouvez déduire un forfait de 20€ par local sans aucun justificatif."
                />
                <p className="text-xs text-blue-600 mt-1">Forfait : {f.charges.fraisGestionDirectNbLocaux * 20} € — aucun justificatif requis</p>
              </div>
              <CurrencyInput
                label="Frais de procédure judiciaire (loyers impayés)"
                value={f.charges.fraisProcedure}
                onChange={v => updateChg({ fraisProcedure: v })}
                tooltip="Honoraires d'avocat, frais d'huissier en cas de litige avec un locataire."
              />
            </div>
            <p className="text-xs text-gray-500 mt-2">Justificatif agence : relevé de gérance annuel (à conserver)</p>
          </SectionCard>

          {/* Travaux */}
          <SectionCard title="Travaux" icon="🔧">
            <AlertBox variant="info">
              Vous pouvez déclarer même sans toutes les factures — saisissez vos estimations et mettez à jour avant envoi de la déclaration.
            </AlertBox>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <CurrencyInput
                  label="Travaux d'entretien et de réparation (déductibles)"
                  value={f.charges.travauxEntretien}
                  onChange={v => updateChg({ travauxEntretien: v })}
                  tooltip="Remplacement chaudière, chauffe-eau, ravalement de façade, réfection toiture, peintures, électricité, plomberie..."
                />
                <p className="text-xs text-green-600 mt-1">Déductibles à 100%</p>
              </div>
              <div>
                <CurrencyInput
                  label="Travaux d'amélioration sans agrandissement (déductibles)"
                  value={f.charges.travauxAmelioration}
                  onChange={v => updateChg({ travauxAmelioration: v })}
                  tooltip="Double vitrage, isolation, installation cuisine équipée, salle de bain, mise aux normes électriques..."
                />
                <p className="text-xs text-green-600 mt-1">Déductibles à 100%</p>
              </div>
            </div>
            <AlertBox variant="warning">
              <strong>Non déductibles :</strong> travaux de construction, agrandissement (extension, surélévation, construction de dépendances).
            </AlertBox>
            <p className="text-xs text-gray-500">Justificatif : factures d'artisans (à conserver 3 ans)</p>
          </SectionCard>
        </>
      )}

      {/* Déficits antérieurs */}
      {f.regime === 'reel' && (
        <SectionCard title="Déficits fonciers antérieurs" icon="📈">
          <CurrencyInput
            label="Déficits fonciers reportables des années précédentes (case 4BD)"
            value={f.deficitAnterieurs}
            onChange={v => update({ deficitAnterieurs: v })}
            tooltip="Si vous avez déclaré un déficit foncier les années précédentes, les années non encore imputées sont reportables 10 ans."
          />
        </SectionCard>
      )}

      {/* Récapitulatif */}
      {f.regime === 'reel' && f.recettes.loyersNus > 0 && (
        <SectionCard title="Récapitulatif foncier" icon="📊" variant="info">
          <div className="space-y-1.5 text-sm font-mono">
            <div className="flex justify-between"><span className="text-gray-600">Loyers nus</span><span>{fmt(f.recettes.loyersNus)}</span></div>
            <div className="flex justify-between"><span className="text-gray-600">+ Charges récupérées locataire</span><span>{fmt(f.recettes.chargesRecuperees)}</span></div>
            <div className="flex justify-between"><span className="text-gray-600">+ Subventions ANAH</span><span>{fmt(f.recettes.subventionsANAH)}</span></div>
            <div className="flex justify-between font-semibold border-t pt-1"><span>= Total recettes</span><span>{fmt(calc.totalRecettes)}</span></div>
            <div className="flex justify-between text-red-600"><span>- Total charges</span><span>- {fmt(calc.totalCharges)}</span></div>
            <div className={`flex justify-between font-bold border-t pt-1 text-base ${calc.resultatNet >= 0 ? 'text-gray-900' : 'text-orange-700'}`}>
              <span>= Résultat net</span>
              <span>{calc.resultatNet >= 0 ? fmt(calc.resultatNet) : `- ${fmt(Math.abs(calc.resultatNet))}`}</span>
            </div>
            {calc.resultatNet >= 0 && <div className="text-blue-700 text-xs mt-1">→ Case 4BA : {fmt(calc.case4BA)}</div>}
            {calc.case4BC > 0 && <div className="text-orange-700 text-xs mt-1">→ Case 4BC (imputable revenu global, max 10 700€) : {fmt(calc.case4BC)}</div>}
            {calc.case4BD > 0 && <div className="text-orange-700 text-xs mt-1">→ Case 4BD (reportable 10 ans sur rev. fonciers) : {fmt(calc.case4BD)}</div>}
          </div>
        </SectionCard>
      )}
    </div>
  );
}
