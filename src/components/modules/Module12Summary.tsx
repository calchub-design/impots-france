'use client';
import { TaxState } from '@/lib/types';
import { calculerImpot, genererCases } from '@/lib/calculations';

interface Props {
  state: TaxState;
  onGeneratePDF: () => void;
}

function fmt(n: number) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}

function fmt2(n: number) {
  return n.toLocaleString('fr-FR') + ' €';
}

const JUSTIFICATIFS_REQUIS = [
  'Bulletins de salaire / AER employeur',
  'Tableau d\'amortissement du prêt + attestation fiscale banque',
  'Relevé annuel du syndic de copropriété',
  'Avis de taxe foncière 2024',
  'Attestations assurance PNO et GLI',
  'Attestation assurance emprunt (ADI)',
  'Relevé de gérance agence (si applicable)',
  'Factures travaux artisans',
  'Relevé CESU / attestation URSSAF emploi domicile',
  'Attestation organismes de dons (reçus fiscaux)',
  'IFU de votre banque / courtier (dividendes, plus-values, intérêts)',
  'Attestation versements PER / PERP',
];

const AUCUN_JUSTIFICATIF = [
  'Forfait frais gestion directe 20€/local',
  'Abattement micro-foncier 30% (case 4BE)',
  'Abattement micro-BIC 50% (case 5ND / 5KP)',
  'Abattement micro-BIC 71% vente (case 5KO)',
  'Abattement micro-BNC 34% (case 5HQ)',
  'Déduction scolaire enfants (cases 7EA, 7EC, 7EF)',
  'Frais professionnels forfait 10% (case 1AJ)',
];

export function Module12Summary({ state, onGeneratePDF }: Props) {
  const calc = calculerImpot(state);
  const cases = genererCases(state, calc);

  // Grouper par formulaire
  const byForm: Record<string, typeof cases> = {};
  cases.forEach(c => {
    if (!byForm[c.formulaire]) byForm[c.formulaire] = [];
    byForm[c.formulaire].push(c);
  });

  const lignesImpot = [
    { label: 'Revenu brut global', value: calc.revenuBrutGlobal, indent: false },
    { label: '- Charges déductibles', value: -calc.chargesDeductiblesTotal, indent: true },
    { label: '= Revenu net global imposable', value: calc.revenuNetGlobal, indent: false, bold: true },
    { label: `Nombre de parts (${calc.nombreParts})`, value: null, indent: false },
    { label: 'Quotient familial (revenu / parts)', value: calc.quotientFamilial, indent: true },
    { label: 'Impôt brut calculé', value: calc.impotApresQF, indent: false },
    { label: '- Décote', value: calc.decote > 0 ? -calc.decote : null, indent: true },
    { label: '- Réductions d\'impôt', value: calc.reductionsTotal > 0 ? -calc.reductionsTotal : null, indent: true },
    { label: '- Crédits d\'impôt', value: calc.creditsTotal > 0 ? -calc.creditsTotal : null, indent: true },
    { label: '+ Prélèvements sociaux (17,2%)', value: calc.prelevementsSociaux > 0 ? calc.prelevementsSociaux : null, indent: true },
  ];

  return (
    <div>
      <h2 className="text-2xl font-bold text-blue-900 mb-2">Récapitulatif & Simulation</h2>
      <p className="text-gray-600 mb-6">Vérifiez l'ensemble de vos saisies avant de générer le PDF.</p>

      {/* Tableau des cases */}
      <div className="rounded-xl border-2 border-gray-200 overflow-hidden mb-6">
        <div className="bg-blue-800 text-white px-4 py-3 font-semibold text-sm flex items-center gap-2">
          <span>📋</span> Cases fiscales à reporter dans votre déclaration
        </div>
        {Object.entries(byForm).map(([form, formCases]) => (
          <div key={form}>
            <div className="bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-800 border-b border-blue-100">
              {form}
            </div>
            <table className="w-full text-sm">
              <tbody>
                {formCases.map((c, i) => (
                  <tr key={c.code} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="px-4 py-2 font-mono font-bold text-blue-700 w-16">{c.code}</td>
                    <td className="px-2 py-2 text-gray-700">{c.libelle}</td>
                    <td className="px-4 py-2 text-right font-semibold text-gray-900 w-28">{fmt2(c.montant)}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 hidden md:table-cell">{c.justificatif}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {cases.length === 0 && (
          <div className="p-8 text-center text-gray-500">
            Aucune case à afficher — complétez les modules précédents.
          </div>
        )}
      </div>

      {/* Simulation impôt */}
      <div className="rounded-xl border-2 border-blue-200 overflow-hidden mb-6">
        <div className="bg-blue-700 text-white px-4 py-3 font-semibold text-sm flex items-center gap-2">
          <span>🧮</span> Simulation de l'impôt 2024
        </div>
        <div className="p-4 space-y-2">
          {lignesImpot.map((l, i) => l.value !== null ? (
            <div key={i} className={`flex justify-between text-sm ${l.bold ? 'font-bold text-gray-900 border-t border-b py-2 my-1' : l.indent ? 'text-gray-600 pl-4' : 'text-gray-700'}`}>
              <span>{l.label}</span>
              <span className={(l.value || 0) < 0 ? 'text-green-600' : 'text-gray-900'}>{fmt(l.value || 0)}</span>
            </div>
          ) : (
            <div key={i} className="text-sm text-gray-500 flex justify-between">
              <span>{l.label}</span><span></span>
            </div>
          ))}
          <div className="flex justify-between font-bold text-lg border-t-2 border-blue-200 pt-3 mt-2">
            <span className="text-blue-900">IMPÔT NET ESTIMÉ</span>
            <span className="text-blue-900">{fmt(Math.max(0, calc.impotNet))}</span>
          </div>
        </div>
        <div className="bg-red-50 border-t border-red-200 px-4 py-3 text-xs text-red-700">
          ⚠️ <strong>Estimation indicative</strong> — l'administration fiscale peut avoir des informations complémentaires.
          Vérifiez sur <strong>impots.gouv.fr</strong>
        </div>
      </div>

      {/* Justificatifs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="rounded-xl border-2 border-green-200 p-4">
          <h3 className="font-semibold text-green-800 mb-3 flex items-center gap-2">
            <span>📁</span> À conserver (3 ans) — NE PAS ENVOYER
          </h3>
          <ul className="space-y-1.5">
            {JUSTIFICATIFS_REQUIS.map(j => (
              <li key={j} className="flex items-start gap-2 text-sm text-gray-700">
                <span className="text-green-500 mt-0.5 flex-shrink-0">□</span>
                {j}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border-2 border-blue-200 p-4">
          <h3 className="font-semibold text-blue-800 mb-3 flex items-center gap-2">
            <span>✅</span> Aucun justificatif requis
          </h3>
          <ul className="space-y-1.5">
            {AUCUN_JUSTIFICATIF.map(j => (
              <li key={j} className="flex items-start gap-2 text-sm text-gray-700">
                <span className="text-blue-500 mt-0.5 flex-shrink-0">✓</span>
                {j}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Bouton PDF */}
      <div className="flex flex-col items-center gap-3 mt-8">
        <button
          onClick={onGeneratePDF}
          className="flex items-center gap-3 px-8 py-4 bg-green-600 text-white font-bold text-lg rounded-2xl hover:bg-green-700 shadow-lg transition-all hover:shadow-xl active:scale-98"
        >
          <span className="text-2xl">📄</span>
          Télécharger mon récapitulatif PDF
        </button>
        <p className="text-sm text-gray-500">Document récapitulatif personnalisé avec toutes vos cases et justificatifs</p>
      </div>
    </div>
  );
}
