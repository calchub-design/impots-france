'use client';
import { TaxState } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { RadioGroup, CheckboxField } from '@/components/ui/RadioGroup';
import { SectionCard, AlertBox } from '@/components/ui/SectionCard';

interface Props { state: TaxState; dispatch: React.Dispatch<TaxAction>; }

export function Module4Independant({ state, dispatch }: Props) {
  const ind = state.revenusIndependant;
  const update = (changes: Partial<typeof ind>) =>
    dispatch({ type: 'UPDATE_INDEPENDANT', payload: { ...ind, ...changes } });
  const updateMicro = (changes: Partial<typeof ind.microEntreprise>) =>
    update({ microEntreprise: { ...ind.microEntreprise, ...changes } });
  const updateReel = (changes: Partial<typeof ind.reel>) =>
    update({ reel: { ...ind.reel, ...changes } });
  const updateGerant = (changes: Partial<typeof ind.gerantSarl>) =>
    update({ gerantSarl: { ...ind.gerantSarl, ...changes } });

  const ca = ind.microEntreprise.chiffreAffaires;
  const type = ind.microEntreprise.typeActivite;
  const abattement = type === 'vente' ? 0.71 : type === 'services_bic' ? 0.50 : type === 'services_bnc' ? 0.34 : 0;
  const baseImposable = ca * (1 - abattement);

  // Seuils franchise TVA 2024
  const seuilTVA = type === 'vente' ? 91900 : 36800;

  return (
    <div>
      <h2 className="text-2xl font-bold text-blue-900 mb-2">Activité indépendante</h2>
      <p className="text-gray-600 mb-6">Auto-entrepreneur, professions libérales, commerçants, artisans, gérants de SARL.</p>

      {/* Micro-entreprise */}
      <SectionCard title="Micro-entreprise (auto-entrepreneur)" icon="🏪">
        <CheckboxField
          label="J'ai une activité en micro-entreprise en 2024"
          checked={ind.microEntreprise.actif}
          onChange={v => updateMicro({ actif: v })}
        />
        {ind.microEntreprise.actif && (
          <div className="mt-4 space-y-4">
            <RadioGroup<'vente' | 'services_bic' | 'services_bnc'>
              label="Type d'activité principale"
              value={ind.microEntreprise.typeActivite as 'vente' | 'services_bic' | 'services_bnc' || 'services_bnc'}
              onChange={v => updateMicro({ typeActivite: v })}
              options={[
                { value: 'vente', label: 'Vente de marchandises (abattement 71%)' },
                { value: 'services_bic', label: 'Prestations services BIC (abattement 50%)' },
                { value: 'services_bnc', label: 'Prestations services BNC (abattement 34%)' },
              ]}
              tooltip="BIC = activités commerciales ou artisanales. BNC = professions libérales (consultants, freelances, etc.)"
            />
            <CurrencyInput
              label="Chiffre d'affaires brut total 2024 (avant abattement)"
              value={ca}
              onChange={v => updateMicro({ chiffreAffaires: v })}
              tooltip="Total de toutes vos recettes encaissées en 2024, avant tout abattement. C'est le chiffre que vous avez déclaré à l'URSSAF."
            />

            {ca > 0 && type && (
              <div className="bg-blue-50 rounded-lg p-4 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">CA brut déclaré</span>
                  <span className="font-medium">{ca.toLocaleString('fr-FR')} €</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Abattement ({(abattement * 100).toFixed(0)}%)</span>
                  <span className="text-green-600 font-medium">- {(ca * abattement).toLocaleString('fr-FR')} €</span>
                </div>
                <div className="flex justify-between text-sm font-semibold border-t pt-1">
                  <span>Base imposable (à déclarer)</span>
                  <span className="text-blue-800">{Math.round(baseImposable).toLocaleString('fr-FR')} €</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">Case {type === 'vente' ? '5KO' : type === 'services_bic' ? '5KP' : '5HQ'} — aucun justificatif requis pour l'abattement</p>
              </div>
            )}

            {ca > seuilTVA * 0.9 && (
              <AlertBox variant="warning">
                Votre CA ({ca.toLocaleString('fr-FR')} €) approche du seuil de franchise TVA ({seuilTVA.toLocaleString('fr-FR')} €).
                Au-delà, vous devrez facturer la TVA.
              </AlertBox>
            )}

            <CheckboxField
              label="J'ai opté pour le versement libératoire de l'impôt (case 5KA)"
              checked={ind.microEntreprise.versementLiberatoire}
              onChange={v => updateMicro({ versementLiberatoire: v })}
              tooltip="Si vous avez choisi le versement libératoire, votre impôt est prélevé directement par l'URSSAF sur vos recettes. Vous devez quand même déclarer votre CA mais il n'est pas re-imposé."
            />
            {ind.microEntreprise.versementLiberatoire && (
              <AlertBox variant="success">
                Votre impôt sur ce CA est déjà réglé via le versement libératoire. Vous devez tout de même reporter le CA case 5KA pour que l'administration puisse vérifier les plafonds et le calcul du revenu fiscal de référence.
              </AlertBox>
            )}
          </div>
        )}
      </SectionCard>

      {/* Régime réel */}
      <SectionCard title="Régime réel BIC / BNC (avec comptabilité)" icon="📒">
        <CheckboxField
          label="J'ai une activité au régime réel (BIC ou BNC)"
          checked={ind.reel.actif}
          onChange={v => updateReel({ actif: v })}
          tooltip="Si vous tenez une comptabilité réelle et déposez une déclaration 2035 (BNC) ou 2031 (BIC), renseignez ici votre résultat net fiscal."
        />
        {ind.reel.actif && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <RadioGroup<'bnc' | 'bic'>
              label="Type fiscal"
              value={ind.reel.typeFiscal}
              onChange={v => updateReel({ typeFiscal: v })}
              options={[
                { value: 'bnc', label: 'BNC (décl. 2035)' },
                { value: 'bic', label: 'BIC (décl. 2031)' },
              ]}
            />
            <CurrencyInput
              label="Résultat net fiscal (de votre liasse)"
              value={ind.reel.resultatNet}
              onChange={v => updateReel({ resultatNet: v })}
              tooltip="Montant figurant sur votre déclaration 2035 (BNC) ou 2031 (BIC), après toutes déductions charges."
            />
            <CurrencyInput
              label="Déficit reportable des années précédentes"
              value={ind.reel.deficit}
              onChange={v => updateReel({ deficit: v })}
              tooltip="Si vous avez un déficit des années antérieures encore non imputé, saisissez-le ici."
            />
          </div>
        )}
      </SectionCard>

      {/* Gérant SARL */}
      <SectionCard title="Gérant majoritaire de SARL (article 62 CGI)" icon="🏢">
        <CheckboxField
          label="Je suis gérant majoritaire de SARL soumise à l'IS"
          checked={ind.gerantSarl.actif}
          onChange={v => updateGerant({ actif: v })}
          tooltip="Le gérant majoritaire de SARL à l'IS déclare sa rémunération case 1GB, avec droit à la déduction de 10% comme un salarié."
        />
        {ind.gerantSarl.actif && (
          <div className="mt-4 space-y-4">
            <CurrencyInput
              label="Rémunération de gérance nette (case 1GB)"
              value={ind.gerantSarl.remuneration}
              onChange={v => updateGerant({ remuneration: v })}
            />
            <RadioGroup<'forfait' | 'reel'>
              label="Frais professionnels"
              value={ind.gerantSarl.fraisPro}
              onChange={v => updateGerant({ fraisPro: v })}
              options={[
                { value: 'forfait', label: 'Déduction forfaitaire 10%' },
                { value: 'reel', label: 'Frais réels' },
              ]}
            />
          </div>
        )}
      </SectionCard>
    </div>
  );
}
