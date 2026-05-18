'use client';
import { TaxState } from '@/lib/types';
import { TaxAction } from '@/lib/taxReducer';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { CheckboxField } from '@/components/ui/RadioGroup';
import { SectionCard, AlertBox } from '@/components/ui/SectionCard';

interface Props { state: TaxState; dispatch: React.Dispatch<TaxAction>; }

export function Module8Patrimoine({ state, dispatch }: Props) {
  const pat = state.revenusPatrimoine;
  const update = (changes: Partial<typeof pat>) =>
    dispatch({ type: 'UPDATE_PATRIMOINE', payload: { ...pat, ...changes } });

  const pvNette = Math.max(0, pat.plusValuesMobilieres - pat.moinsValuesMobilieres);

  // Simulation comparaison PFU vs barème
  const dividendesBruts = pat.dividendes + pat.revenusDistribuesFCP;
  const imposableBareme = dividendesBruts * 0.60; // après abattement 40%
  const pfuBrut = dividendesBruts * 0.30;

  return (
    <div>
      <h2 className="text-2xl font-bold text-blue-900 mb-2">Revenus du patrimoine financier</h2>
      <p className="text-gray-600 mb-6">Intérêts, dividendes, plus-values mobilières, assurance-vie. Cases 2TR, 2DC, 3VG...</p>

      <SectionCard title="Intérêts et produits de placement" icon="💶">
        <CurrencyInput
          label="Intérêts (comptes courants, DAT, obligations) — case 2TR"
          value={pat.interets}
          onChange={v => update({ interets: v })}
          tooltip="Intérêts sur comptes courants, dépôts à terme, obligations... Ces montants sont pré-remplis par votre banque sur l'IFU. Les livrets réglementés (Livret A, LDDS, LEP) sont exonérés — ne pas les déclarer."
        />
        <AlertBox variant="success">
          Livret A, LDDS, LEP : <strong>exonérés d'impôt</strong>, ne pas les déclarer ici.
        </AlertBox>
        <p className="text-xs text-gray-500 mt-2">Ces montants figurent sur l'IFU (Imprimé Fiscal Unique) fourni par votre banque — vérifiez le montant pré-rempli.</p>
      </SectionCard>

      <SectionCard title="Dividendes" icon="📈">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CurrencyInput
            label="Dividendes bruts — case 2DC"
            value={pat.dividendes}
            onChange={v => update({ dividendes: v })}
            tooltip="Dividendes versés par des sociétés françaises ou étrangères. Montant brut avant tout prélèvement. Disponible sur votre IFU."
          />
          <CurrencyInput
            label="Revenus distribués SICAV/FCP — case 2TS"
            value={pat.revenusDistribuesFCP}
            onChange={v => update({ revenusDistribuesFCP: v })}
            tooltip="Revenus distribués par vos fonds communs de placement. Disponible sur votre IFU ou relevé de compte titres."
          />
          <CurrencyInput
            label="Crédit d'impôt étranger — case 2AB"
            value={pat.avoirFiscal}
            onChange={v => update({ avoirFiscal: v })}
            tooltip="Retenue à la source prélevée à l'étranger sur vos dividendes étrangers. Disponible sur votre IFU."
          />
          <CurrencyInput
            label="CSG déductible (pré-remplie) — case 2BH"
            value={pat.csgDeductible}
            onChange={v => update({ csgDeductible: v })}
            tooltip="La CSG déductible est normalement pré-remplie par l'administration fiscale. Elle correspond à une partie de la CSG prélevée sur vos revenus du patrimoine de l'année précédente."
          />
        </div>

        {dividendesBruts > 0 && (
          <div className="mt-4 space-y-3">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-sm font-semibold text-amber-900 mb-2">Choisissez le mode d'imposition des dividendes</p>
              <CheckboxField
                label="Opter pour le barème progressif (case 2OP)"
                checked={pat.optionBarem}
                onChange={v => update({ optionBarem: v })}
                tooltip="Si votre tranche marginale d'imposition est inférieure à 30%, le barème progressif peut être plus avantageux. Cocher la case 2OP permet également de bénéficier de l'abattement 40% sur les dividendes."
              />
              <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div className={`p-3 rounded-lg ${!pat.optionBarem ? 'bg-blue-100 border-2 border-blue-400' : 'bg-gray-100'}`}>
                  <p className="font-medium">PFU 30% (flat tax)</p>
                  <p className="text-gray-600">Impôt estimé : {(pfuBrut).toLocaleString('fr-FR')} €</p>
                  <p className="text-xs text-gray-500">Par défaut — simple et prévisible</p>
                </div>
                <div className={`p-3 rounded-lg ${pat.optionBarem ? 'bg-blue-100 border-2 border-blue-400' : 'bg-gray-100'}`}>
                  <p className="font-medium">Barème + abattement 40%</p>
                  <p className="text-gray-600">Base : {Math.round(imposableBareme).toLocaleString('fr-FR')} €</p>
                  <p className="text-xs text-gray-500">Si TMI {'<'} 30%, peut être avantageux</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Plus-values mobilières" icon="📉">
        <AlertBox variant="info">
          Ces montants figurent sur votre IFU fourni par votre courtier (Boursorama, Degiro, Fortuneo...).
        </AlertBox>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CurrencyInput
            label="Plus-values de cession — case 3VG"
            value={pat.plusValuesMobilieres}
            onChange={v => update({ plusValuesMobilieres: v })}
            tooltip="Total des plus-values réalisées sur ventes d'actions, OPCVM, ETF... en 2024. Les PEA de plus de 5 ans sont exonérés — ne pas les inclure."
          />
          <CurrencyInput
            label="Moins-values imputables — case 3VH"
            value={pat.moinsValuesMobilieres}
            onChange={v => update({ moinsValuesMobilieres: v })}
            tooltip="Moins-values de l'année imputable sur les plus-values. Les moins-values en excès sont reportables sur 10 ans."
          />
        </div>
        {pvNette > 0 && (
          <div className="bg-blue-50 rounded-lg p-3 text-sm mt-2">
            Plus-value nette imposable : <strong>{pvNette.toLocaleString('fr-FR')} €</strong> — soumise au PFU 30% (ou barème si option 2OP).
          </div>
        )}
        <AlertBox variant="success">
          <strong>PEA de plus de 5 ans :</strong> les plus-values sont exonérées d'impôt. Ne pas les déclarer.
        </AlertBox>
      </SectionCard>

      <SectionCard title="Plus-value immobilière" icon="🏘️">
        <AlertBox variant="success">
          La plus-value sur la <strong>résidence principale</strong> est totalement exonérée — ne pas déclarer.
        </AlertBox>
        <p className="text-sm text-gray-600 mb-3">
          Pour une résidence secondaire ou un bien locatif vendu en 2024, la plus-value est calculée et déclarée
          par votre <strong>notaire</strong> (formulaire 2048). Elle doit apparaître pré-remplie sur votre déclaration.
          Vérifiez la case <strong>3VZ</strong>.
        </p>
        <CurrencyInput
          label="Plus-value immobilière nette imposable (case 3VZ) — si non pré-remplie"
          value={pat.plusValueImmobiliere}
          onChange={v => update({ plusValueImmobiliere: v })}
          tooltip="Si ce montant n'est pas pré-rempli, renseignez-le depuis le formulaire 2048 établi par votre notaire."
        />
      </SectionCard>

      <SectionCard title="Assurance-vie" icon="🌿">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CurrencyInput
            label="Produits de rachats sur contrats de + de 8 ans (case 2CH)"
            value={pat.assuranceVieCt8ans}
            onChange={v => update({ assuranceVieCt8ans: v })}
            tooltip="Gains imposables sur rachats partiels ou total de contrats d'assurance-vie de plus de 8 ans. Abattement annuel : 4 600€ (célibataire) ou 9 200€ (couple). L'assureur indique le montant imposable net sur votre IFU."
          />
          <CurrencyInput
            label="Produits de rachats sur contrats de - de 8 ans"
            value={pat.assuranceVieMt8ans}
            onChange={v => update({ assuranceVieMt8ans: v })}
            tooltip="Gains sur rachats de contrats de moins de 8 ans. Soumis au PFU 30%. L'assureur vous fournit l'IFU avec le montant exact."
          />
        </div>
        <AlertBox variant="info">
          L'assureur fournit l'IFU avec le montant imposable exact. Vérifiez votre relevé annuel ou espace client assureur.
        </AlertBox>
      </SectionCard>
    </div>
  );
}
