'use client';
import { TaxState } from '@/lib/types';
import { calculerImpot, calculerParts } from '@/lib/calculations';

interface Props {
  state: TaxState;
}

function fmt(n: number) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}

export function SidePanel({ state }: Props) {
  const calc = calculerImpot(state);
  const parts = calculerParts(state);

  const rows = [
    { label: 'Revenu brut global', value: calc.revenuBrutGlobal, bold: false },
    { label: 'Charges déductibles', value: -calc.chargesDeductiblesTotal, bold: false },
    { label: 'Revenu net global', value: calc.revenuNetGlobal, bold: true },
    { label: `Quotient familial (${parts} parts)`, value: calc.quotientFamilial, bold: false },
    { label: 'Impôt brut calculé', value: calc.impotApresQF, bold: false },
    { label: 'Décote', value: -calc.decote, bold: false },
    { label: 'Réductions d\'impôt', value: -calc.reductionsTotal, bold: false },
    { label: 'Crédits d\'impôt', value: -calc.creditsTotal, bold: false },
    { label: 'Prélèvements sociaux', value: calc.prelevementsSociaux, bold: false },
  ];

  return (
    <div className="bg-white rounded-2xl border-2 border-blue-100 shadow-sm p-5 sticky top-4">
      <h2 className="font-bold text-blue-900 text-base mb-4 flex items-center gap-2">
        <span className="text-lg">📊</span>
        Estimation en temps réel
      </h2>
      <div className="space-y-2">
        {rows.map((r, i) => (
          r.value !== 0 ? (
            <div key={i} className={`flex justify-between text-sm ${r.bold ? 'font-semibold text-gray-900 border-t border-gray-200 pt-2' : 'text-gray-600'}`}>
              <span>{r.label}</span>
              <span className={r.value < 0 ? 'text-green-600' : 'text-gray-900'}>{fmt(r.value)}</span>
            </div>
          ) : null
        ))}
      </div>
      <div className="mt-4 pt-4 border-t-2 border-blue-200">
        <div className="flex justify-between font-bold text-blue-900 text-base">
          <span>IMPÔT NET ESTIMÉ</span>
          <span className="text-xl">{fmt(Math.max(0, calc.impotNet))}</span>
        </div>
      </div>
      <p className="text-xs text-gray-400 mt-3 leading-relaxed">
        Estimation indicative — l'administration fiscale peut avoir des informations complémentaires.
      </p>
    </div>
  );
}
