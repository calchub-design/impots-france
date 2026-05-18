'use client';
import { TaxState } from '@/lib/types';

interface Tip {
  icon: string;
  title: string;
  desc: string;
}

function getTips(state: TaxState): Tip[] {
  const tips: Tip[] = [];
  const m = state.modules;
  const enfants = state.situationPersonnelle.enfants;

  // Toujours visible
  tips.push({
    icon: '📋',
    title: 'Frais pro forfait 10%',
    desc: 'Déduit automatiquement sur vos salaires, plafonné à 14 555 €. Aucune démarche.',
  });

  if (m.salaires) {
    tips.push({
      icon: '🚗',
      title: 'Frais kilométriques',
      desc: 'Barème officiel accepté sans justificatif de carburant. Conservez seulement le compteur kilométrique.',
    });
  }

  if (m.retraite) {
    tips.push({
      icon: '🏖️',
      title: 'Abattement retraite 10%',
      desc: 'Appliqué automatiquement sur vos pensions, plafonné à 4 439 €. Rien à faire.',
    });
  }

  if (m.locationNue) {
    tips.push({
      icon: '🏠',
      title: 'Forfait gestion directe',
      desc: '20 € par local déduit d\'office si vous gérez vous-même. Pas de facture requise.',
    });
    tips.push({
      icon: '📉',
      title: 'Micro-foncier 30%',
      desc: 'Si vos loyers < 15 000 €/an, abattement forfaitaire 30% sans aucun justificatif.',
    });
  }

  if (m.locationMeublee) {
    tips.push({
      icon: '🛋️',
      title: 'Micro-BIC 50%',
      desc: 'Location meublée : abattement 50% sur recettes si < 77 700 €/an. Aucun justificatif.',
    });
  }

  if (m.independant) {
    tips.push({
      icon: '💼',
      title: 'Micro-BNC 34%',
      desc: 'Professions libérales en micro : abattement 34% automatique sur votre CA.',
    });
    tips.push({
      icon: '🏪',
      title: 'Micro-BIC vente 71%',
      desc: 'Commerce / vente en micro : abattement 71% si CA < 188 700 €/an.',
    });
  }

  if (enfants.length > 0) {
    tips.push({
      icon: '🎓',
      title: 'Déductions scolaires',
      desc: '61 € collège · 153 € lycée · 183 € supérieur, par enfant. Case 7EA/7EC/7EF — zéro justificatif.',
    });
  }

  if (m.chargesDeductibles) {
    tips.push({
      icon: '✊',
      title: 'Cotisations syndicales',
      desc: 'Crédit d\'impôt 66 % de vos cotisations (case 7AC). Attestation fournie par le syndicat.',
    });
    tips.push({
      icon: '👴',
      title: 'Pension enfant majeur',
      desc: 'Jusqu\'à 6 674 € déductibles par enfant majeur non rattaché que vous hébergez.',
    });
  }

  if (m.patrimoinefinancier) {
    tips.push({
      icon: '💰',
      title: 'Option barème dividendes',
      desc: 'Si votre tranche IR est ≤ 11 %, opter pour le barème (case 2OP) peut être plus avantageux que le PFU 30 %.',
    });
  }

  return tips;
}

export function TipsPanel({ state }: { state: TaxState }) {
  const tips = getTips(state);

  return (
    <div className="bg-white rounded-2xl border border-amber-200 shadow-sm p-5">
      <h2 className="font-bold text-amber-800 text-sm mb-3 flex items-center gap-2">
        <span>💡</span>
        Sans justificatif
      </h2>
      <p className="text-xs text-gray-500 mb-3">Éléments déclarables sans pièce à fournir à l'administration.</p>
      <div className="space-y-3">
        {tips.map((tip, i) => (
          <div key={i} className="flex gap-2.5">
            <span className="text-base leading-none mt-0.5 shrink-0">{tip.icon}</span>
            <div>
              <p className="text-xs font-semibold text-gray-800">{tip.title}</p>
              <p className="text-xs text-gray-500 leading-snug">{tip.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
