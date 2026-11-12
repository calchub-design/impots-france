import { describe, it, expect } from 'vitest';
import {
  calculerFoncier,
  calculerIFI,
  calculerImpot,
  calculerImpotBrut,
  calculerParts,
  genererCases,
} from '../calculations';
import { hydraterEtat, initialState } from '../taxState';
import { TaxState } from '../types';

type Partiel<T> = { [K in keyof T]?: T[K] extends object ? Partiel<T[K]> : T[K] };

// Construit un état complet à partir des seuls champs utiles au test.
const etat = (partiel: Partiel<TaxState> = {}): TaxState => hydraterEtat(partiel);

const enfant = (gardeAlternee = false) => ({ id: Math.random().toString(), age: 8, gardeAlternee });

// Location nue au réel, sans le forfait de gestion pour garder des chiffres ronds.
const foncierReel = (recettes: number, charges: Partiel<TaxState['revenusFonciers']['charges']>) =>
  etat({
    modules: { locationNue: true },
    revenusFonciers: {
      regime: 'reel',
      recettes: { loyersNus: recettes },
      charges: { fraisGestionDirectNbLocaux: 0, ...charges },
    },
  });

describe('barème 2026 (revenus 2025)', () => {
  it('applique les tranches par part', () => {
    expect(calculerImpotBrut(11600)).toBe(0);
    expect(calculerImpotBrut(29579)).toBeCloseTo(1977.69, 2);
    expect(calculerImpotBrut(84577)).toBeCloseTo(18477.09, 2);
    expect(calculerImpotBrut(100000)).toBeCloseTo(24800.52, 2);
    expect(calculerImpotBrut(200000)).toBeCloseTo(66523.84, 2);
  });
});

describe('état vide', () => {
  it('ne produit aucun revenu, aucune charge et aucun impôt', () => {
    const calc = calculerImpot(initialState);
    expect(calc.revenuBrutGlobal).toBe(0);
    expect(calc.chargesDeductiblesTotal).toBe(0);
    expect(calc.impotNet).toBe(0);
    expect(genererCases(initialState, calc)).toEqual([]);
  });
});

describe('salaires', () => {
  it('célibataire à 30 000 € : abattement 10 %, barème et décote', () => {
    const calc = calculerImpot(etat({
      modules: { salaires: true },
      revenusSalariaux: { declarant: { salaires: 30000 } },
    }));
    expect(calc.revenuNetGlobal).toBe(27000);
    expect(calc.impotApresQF).toBeCloseTo(1694, 2);
    expect(calc.decote).toBeCloseTo(130.47, 2);
    expect(calc.impotNet).toBeCloseTo(1563.53, 2);
  });

  it('couple avec deux enfants : quotient familial et décote couple', () => {
    const calc = calculerImpot(etat({
      modules: { salaires: true },
      situationPersonnelle: { situationMaritale: 'marie_pacse', enfants: [enfant(), enfant()] },
      revenusSalariaux: { declarant: { salaires: 40000 }, conjoint: { salaires: 30000 } },
    }));
    expect(calc.nombreParts).toBe(3);
    expect(calc.revenuNetGlobal).toBe(63000);
    expect(calc.impotApresQF).toBeCloseTo(3102, 2);
    expect(calc.impotNet).toBeCloseTo(3022.655, 2);
  });

  it('plafonne l\'abattement de 10 %', () => {
    const calc = calculerImpot(etat({
      modules: { salaires: true },
      revenusSalariaux: { declarant: { salaires: 200000 } },
    }));
    expect(calc.revenuNetGlobal).toBe(200000 - 14555);
  });

  it('ignore les données d\'un module décoché', () => {
    const calc = calculerImpot(etat({
      revenusSalariaux: { declarant: { salaires: 30000 } },
    }));
    expect(calc.revenuBrutGlobal).toBe(0);
  });
});

describe('plafonnement du quotient familial', () => {
  it('limite l\'avantage à 1 807 € par demi-part', () => {
    const calc = calculerImpot(etat({
      modules: { independant: true },
      situationPersonnelle: { situationMaritale: 'marie_pacse', enfants: [enfant()] },
      revenusIndependant: { reel: { actif: true, resultatNet: 200000 } },
    }));
    expect(calc.nombreParts).toBe(2.5);
    expect(calc.impotApresQF).toBeCloseTo(49601.04 - 1807, 2);
  });
});

describe('nombre de parts', () => {
  const parts = (sp: Partiel<TaxState['situationPersonnelle']>) => calculerParts(etat({ situationPersonnelle: sp }));

  it('compte une part entière à partir du troisième enfant', () => {
    expect(parts({ situationMaritale: 'marie_pacse', enfants: [enfant(), enfant(), enfant()] })).toBe(4);
  });

  it('divise par deux en garde alternée, y compris au troisième rang', () => {
    expect(parts({ enfants: [enfant(true)] })).toBe(1.25);
    expect(parts({ enfants: [enfant(true), enfant(true), enfant(true)] })).toBe(2);
    expect(parts({ enfants: [enfant(), enfant(), enfant(true)] })).toBe(2.5);
  });

  it('accorde la demi-part de parent isolé', () => {
    expect(parts({ parentIsole: true, enfants: [enfant()] })).toBe(2);
    expect(parts({ parentIsole: true, enfants: [enfant(true)] })).toBe(1.5);
    expect(parts({ parentIsole: true, enfants: [] })).toBe(1);
    expect(parts({ situationMaritale: 'marie_pacse', parentIsole: true, enfants: [enfant()] })).toBe(2.5);
  });
});

describe('revenus de remplacement', () => {
  it('impose la retraite des deux conjoints après abattement de 10 %', () => {
    const calc = calculerImpot(etat({
      modules: { retraite: true },
      situationPersonnelle: { situationMaritale: 'marie_pacse' },
      revenusRemplacement: { declarant: { retraite: 20000 }, conjoint: { retraite: 15000 } },
    }));
    expect(calc.revenuBrutGlobal).toBe(31500);
  });

  it('plafonne l\'abattement des pensions par foyer', () => {
    const calc = calculerImpot(etat({
      modules: { retraite: true },
      situationPersonnelle: { situationMaritale: 'marie_pacse' },
      revenusRemplacement: { declarant: { retraite: 40000 }, conjoint: { retraite: 30000 } },
    }));
    expect(calc.revenuBrutGlobal).toBe(70000 - 4439);
  });

  it('applique la déduction de 10 % au chômage et aux indemnités journalières', () => {
    const calc = calculerImpot(etat({
      modules: { retraite: true },
      revenusRemplacement: { declarant: { chomage: 15000, indemMaladie: 5000 } },
    }));
    expect(calc.revenuBrutGlobal).toBe(18000);
  });

  it('impose la part imposable des indemnités de licenciement', () => {
    const calc = calculerImpot(etat({
      modules: { retraite: true },
      revenusRemplacement: { declarant: { indemLicenciement: 10000 } },
    }));
    expect(calc.revenuBrutGlobal).toBe(9000);
  });

  it('déclare la pension d\'invalidité seule en 1AZ et les IJ en 1AJ', () => {
    const s = etat({
      modules: { retraite: true },
      revenusRemplacement: { declarant: { invalidite: 8000, indemMaladie: 2000 } },
    });
    const cases = genererCases(s, calculerImpot(s));
    expect(cases.find(c => c.code === '1AZ')?.montant).toBe(8000);
    expect(cases.find(c => c.code === '1AJ')?.montant).toBe(2000);
  });
});

describe('revenus fonciers', () => {
  it('ne crée aucun déficit quand il n\'y a pas de location', () => {
    const fc = calculerFoncier(initialState);
    expect(fc.case4BC).toBe(0);
    expect(fc.case4BD).toBe(0);
    expect(fc.totalCharges).toBe(0);
  });

  it('ignore des données foncières saisies puis désactivées', () => {
    const s = { ...foncierReel(1000, { travauxEntretien: 9000 }), modules: initialState.modules };
    expect(calculerFoncier(s).case4BC).toBe(0);
  });

  it('impute les intérêts d\'abord sur les loyers : le déficit vient des autres charges', () => {
    const fc = calculerFoncier(foncierReel(10000, { interetsEmprunt: 8000, travauxEntretien: 5000 }));
    expect(fc.resultatNet).toBe(-3000);
    expect(fc.case4BC).toBe(3000);
    expect(fc.case4BD).toBe(0);
  });

  it('rend seulement reportable le déficit dû aux intérêts', () => {
    const fc = calculerFoncier(foncierReel(5000, { interetsEmprunt: 8000 }));
    expect(fc.case4BC).toBe(0);
    expect(fc.case4BD).toBe(3000);
  });

  it('plafonne l\'imputation sur le revenu global à 10 700 €', () => {
    const fc = calculerFoncier(foncierReel(5000, { interetsEmprunt: 8000, travauxEntretien: 15000 }));
    expect(fc.case4BC).toBe(10700);
    expect(fc.case4BD).toBe(3000 + 4300);
  });

  it('déduit le déficit imputable du revenu global', () => {
    const s = foncierReel(10000, { interetsEmprunt: 8000, travauxEntretien: 5000 });
    const calc = calculerImpot({
      ...s,
      modules: { ...s.modules, salaires: true },
      revenusSalariaux: etat({ revenusSalariaux: { declarant: { salaires: 30000 } } }).revenusSalariaux,
    });
    expect(calc.revenuNetGlobal).toBe(27000 - 3000);
  });

  it('ne retire que la TEOM récupérée de la taxe foncière', () => {
    const fc = calculerFoncier(foncierReel(10000, { taxeFonciere: 1500, teomRecuperee: true, teomMontant: 200 }));
    expect(fc.totalCharges).toBe(1300);
    expect(fc.case4BA).toBe(8700);
  });

  it('ajoute le forfait de gestion de 20 € par local', () => {
    const fc = calculerFoncier(foncierReel(10000, { fraisGestionDirectNbLocaux: 2 }));
    expect(fc.totalCharges).toBe(40);
  });

  it('impute les déficits antérieurs sur le bénéfice foncier', () => {
    const s = foncierReel(5000, {});
    s.revenusFonciers.deficitAnterieurs = 2000;
    expect(calculerFoncier(s).case4BA).toBe(3000);
    s.revenusFonciers.deficitAnterieurs = 9000;
    expect(calculerFoncier(s).case4BA).toBe(0);
  });

  it('applique l\'abattement de 30 % du micro-foncier', () => {
    const fc = calculerFoncier(etat({
      modules: { locationNue: true },
      revenusFonciers: { regime: 'micro', microFoncierCA: 10000 },
    }));
    expect(fc.case4BA).toBe(7000);
  });

  it('compense le déficit de SCI avec le bénéfice de la location directe', () => {
    const s = foncierReel(6000, {});
    s.modules.sci = true;
    s.revenusSCI.quotePartDeficit = 4000;
    expect(calculerFoncier(s).case4BA).toBe(2000);
    s.revenusSCI.quotePartDeficit = 9000;
    const fc = calculerFoncier(s);
    expect(fc.case4BA).toBe(0);
    expect(fc.case4BC).toBe(3000);
  });

  it('ajoute le bénéfice de SCI aux revenus fonciers, même sans location directe', () => {
    const s = etat({ modules: { sci: true }, revenusSCI: { quotePartResultat: 4000 } });
    const calc = calculerImpot(s);
    expect(calc.foncierCalc.case4BA).toBe(4000);
    expect(genererCases(s, calc).find(c => c.code === '4BA')?.montant).toBe(4000);
  });
});

describe('patrimoine financier', () => {
  const revenus = { interets: 1000, dividendes: 2000, plusValuesMobilieres: 3000 };

  it('PFU : 12,8 % d\'impôt et rien au barème', () => {
    const calc = calculerImpot(etat({ modules: { patrimoinefinancier: true }, revenusPatrimoine: revenus }));
    expect(calc.revenuBrutGlobal).toBe(0);
    expect(calc.impotForfaitaire).toBeCloseTo(768, 2);
    // 17,2 % sur intérêts et dividendes, 18,6 % sur les plus-values
    expect(calc.prelevementsSociaux).toBeCloseTo(516 + 558, 2);
    expect(calc.impotNet).toBeCloseTo(1842, 2);
  });

  it('option barème : tout passe au barème, dividendes abattus de 40 %', () => {
    const calc = calculerImpot(etat({
      modules: { patrimoinefinancier: true },
      revenusPatrimoine: { ...revenus, optionBarem: true },
    }));
    expect(calc.revenuBrutGlobal).toBe(1000 + 1200 + 3000);
    expect(calc.impotForfaitaire).toBe(0);
    expect(calc.prelevementsSociaux).toBeCloseTo(516 + 558, 2);
  });

  it('impute les moins-values sur les plus-values', () => {
    const calc = calculerImpot(etat({
      modules: { plusValues: true },
      revenusPatrimoine: { plusValuesMobilieres: 3000, moinsValuesMobilieres: 5000 },
    }));
    expect(calc.impotNet).toBe(0);
  });

  it('assurance-vie de plus de 8 ans : abattement puis 7,5 %', () => {
    const calc = calculerImpot(etat({
      modules: { patrimoinefinancier: true },
      revenusPatrimoine: { assuranceVieCt8ans: 6600 },
    }));
    expect(calc.impotForfaitaire).toBeCloseTo(150, 2);
  });
});

describe('location meublée', () => {
  it('micro-BIC : abattement de 50 % et prélèvements sociaux à 18,6 %', () => {
    const calc = calculerImpot(etat({
      modules: { locationMeublee: true },
      revenusLMNP: { regime: 'micro', recettes: 10000 },
    }));
    expect(calc.revenuBrutGlobal).toBe(5000);
    expect(calc.prelevementsSociaux).toBeCloseTo(930, 2);
  });
});

describe('réductions et crédits d\'impôt', () => {
  const smicard = { modules: { salaires: true, chargesDeductibles: true }, revenusSalariaux: { declarant: { salaires: 12000 } } };

  it('rembourse un crédit d\'impôt à un foyer non imposable', () => {
    const calc = calculerImpot(etat({ ...smicard, reductionsCreditImpot: { emploiDomicile: 2000 } }));
    expect(calc.impotApresQF).toBe(0);
    expect(calc.creditsTotal).toBe(1000);
    expect(calc.impotNet).toBe(-1000);
  });

  it('plafonne les dépenses d\'emploi à domicile', () => {
    const calc = calculerImpot(etat({ ...smicard, reductionsCreditImpot: { emploiDomicile: 20000 } }));
    expect(calc.creditsTotal).toBe(6000);
  });

  it('applique le plafonnement global des niches à 10 000 €', () => {
    const calc = calculerImpot(etat({
      ...smicard,
      situationPersonnelle: { enfants: [enfant(), enfant(), enfant()] },
      reductionsCreditImpot: { emploiDomicile: 20000, gardeEnfant1: 3500, gardeEnfant2: 3500, gardeEnfant3: 3500 },
    }));
    expect(calc.creditsTotal).toBe(10000);
  });

  it('ne rembourse pas une réduction d\'impôt et plafonne les dons à 20 % du revenu', () => {
    const base = {
      modules: { salaires: true, chargesDeductibles: true },
      revenusSalariaux: { declarant: { salaires: 30000 } },
    };
    const gros = calculerImpot(etat({ ...base, reductionsCreditImpot: { donsAssociations: 10000 } }));
    expect(gros.reductionsTotal).toBeCloseTo(1563.53, 2);
    expect(gros.impotNet).toBe(0);

    const petit = calculerImpot(etat({ ...base, reductionsCreditImpot: { donsAssociations: 1000 } }));
    expect(petit.reductionsTotal).toBeCloseTo(660, 2);
    expect(petit.impotNet).toBeCloseTo(903.53, 2);
  });

  it('applique 75 % aux dons d\'aide aux personnes jusqu\'à 1 000 €', () => {
    const calc = calculerImpot(etat({
      modules: { salaires: true, chargesDeductibles: true },
      revenusSalariaux: { declarant: { salaires: 60000 } },
      reductionsCreditImpot: { donsUrgence: 1500 },
    }));
    expect(calc.reductionsTotal).toBeCloseTo(750 + 330, 2);
  });

  it('limite les cotisations syndicales à 1 % des salaires', () => {
    const calc = calculerImpot(etat({ ...smicard, reductionsCreditImpot: { cotisationsSyndicales: 500 } }));
    expect(calc.creditsTotal).toBeCloseTo(120 * 0.66, 2);
  });
});

describe('indépendants', () => {
  it('déclare le chiffre d\'affaires en 5TE avec le versement libératoire', () => {
    const s = etat({
      modules: { independant: true },
      revenusIndependant: {
        microEntreprise: { actif: true, typeActivite: 'services_bnc', chiffreAffaires: 30000, versementLiberatoire: true },
      },
    });
    const calc = calculerImpot(s);
    const codes = genererCases(s, calc).map(c => c.code);
    expect(calc.revenuBrutGlobal).toBe(0);
    expect(codes).toContain('5TE');
    expect(codes).not.toContain('5HQ');
  });

  it('applique l\'abattement micro-BNC de 34 %', () => {
    const calc = calculerImpot(etat({
      modules: { independant: true },
      revenusIndependant: { microEntreprise: { actif: true, typeActivite: 'services_bnc', chiffreAffaires: 30000 } },
    }));
    expect(calc.revenuBrutGlobal).toBeCloseTo(19800, 2);
  });
});

describe('IFI', () => {
  const ifi = (valeurBrute: number, passifDeductible = 0) =>
    calculerIFI(etat({ ifi: { assujetti: true, valeurBrute, passifDeductible } }));

  it('n\'est pas dû sous 1,3 M€ de patrimoine net', () => {
    expect(ifi(1_200_000)).toBe(0);
    expect(ifi(1_500_000, 300_000)).toBe(0);
  });

  it('applique le barème et la décote', () => {
    expect(ifi(1_300_000)).toBeCloseTo(1250, 2);
    expect(ifi(2_000_000)).toBeCloseTo(7400, 2);
  });
});

describe('restauration d\'un état sauvegardé', () => {
  it('complète les champs absents d\'une ancienne sauvegarde', () => {
    const s = hydraterEtat({ currentStep: 3, revenusFonciers: { charges: { taxeFonciere: 900 } } });
    expect(s.currentStep).toBe(3);
    expect(s.revenusFonciers.charges.taxeFonciere).toBe(900);
    expect(s.revenusFonciers.charges.teomMontant).toBe(0);
    expect(s.ifi).toEqual(initialState.ifi);
  });

  it('écarte les valeurs corrompues', () => {
    expect(hydraterEtat(null)).toEqual(initialState);
    const s = hydraterEtat({ revenusSalariaux: 'oups', ifi: { valeurBrute: 'abc' }, situationPersonnelle: { enfants: 4 } });
    expect(s.revenusSalariaux).toEqual(initialState.revenusSalariaux);
    expect(s.ifi.valeurBrute).toBe(0);
    expect(s.situationPersonnelle.enfants).toEqual([]);
    expect(Number.isFinite(calculerImpot(s).impotNet)).toBe(true);
  });
});
