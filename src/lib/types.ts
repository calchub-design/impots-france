// ============================================================
// Types centraux pour la déclaration d'impôts 2024 (revenus 2024)
// ============================================================

export type SituationMaritale = 'celibataire' | 'marie_pacse' | 'divorce' | 'veuf';
export type RegimeFoncier = 'micro' | 'reel' | null;
export type RegimeLMNP = 'micro' | 'reel' | null;
export type RegimeMicroBIC = 'vente' | 'services_bic' | 'services_bnc' | null;
export type FraisPro = 'forfait' | 'reel';

export interface Enfant {
  id: string;
  age: number;
  gardeAlternee: boolean;
}

// ---- Module 0 : Profil / activation ----
export interface ModuleActivation {
  salaires: boolean;
  retraite: boolean;
  independant: boolean;
  locationNue: boolean;
  locationMeublee: boolean;
  sci: boolean;
  patrimoinefinancier: boolean;
  plusValues: boolean;
  chargesDeductibles: boolean;
}

// ---- Module 1 : Situation personnelle ----
export interface SituationPersonnelle {
  situationMaritale: SituationMaritale;
  anneeNaissanceDeclarant: string;
  anneeNaissanceConjoint: string;
  enfants: Enfant[];
  parentIsole: boolean;
  invalide: boolean;
  ancienCombattant: boolean;
  invalideConjoint: boolean;
}

// ---- Module 2 : Revenus salariaux ----
export interface FraisReels {
  km: number;
  typeVehicule: 'voiture' | 'moto' | 'velo';
  cylindree: '3cv' | '4cv' | '5cv' | '6cv' | '7cv_plus';
  repas: number;
  formation: number;
  doubleResidence: number;
  autresFrais: number;
}

export interface RevenusSalariaux {
  declarant: {
    salaires: number;
    avantagesNature: number;
    heuresSup: number;
    fraisPro: FraisPro;
    fraisReels: FraisReels;
  };
  conjoint: {
    salaires: number;
    avantagesNature: number;
    heuresSup: number;
    fraisPro: FraisPro;
    fraisReels: FraisReels;
  };
}

// ---- Module 3 : Revenus de remplacement ----
export interface RevenusRemplacement {
  declarant: {
    chomage: number;
    indemMaladie: number;
    retraite: number;
    invalidite: number;
    indemLicenciement: number;
    renteViagere: number;
    ageRenteViagere: number;
  };
  conjoint: {
    chomage: number;
    indemMaladie: number;
    retraite: number;
    invalidite: number;
    indemLicenciement: number;
    renteViagere: number;
    ageRenteViagere: number;
  };
}

// ---- Module 4 : Indépendant / auto-entrepreneur ----
export interface RevenusIndependant {
  microEntreprise: {
    actif: boolean;
    typeActivite: RegimeMicroBIC;
    chiffreAffaires: number;
    versementLiberatoire: boolean;
  };
  reel: {
    actif: boolean;
    typeFiscal: 'bic' | 'bnc';
    resultatNet: number;
    deficit: number;
  };
  gerantSarl: {
    actif: boolean;
    remuneration: number;
    fraisPro: FraisPro;
  };
}

// ---- Module 5 : Revenus fonciers ----
export interface RevenusFonciers {
  regime: RegimeFoncier;
  recettes: {
    loyersNus: number;
    chargesRecuperees: number;
    subventionsANAH: number;
  };
  charges: {
    chargesCopro: number;
    chargesRecupereesSurLocataire: number;
    interetsEmprunt: number;
    assuranceADI: number;
    fraisGarantie: number;
    mainleveeHypotheque: number;
    assurancePNO: number;
    assuranceGLI: number;
    taxeFonciere: number;
    teomRecuperee: boolean;
    fraisGestionAgence: number;
    fraisGestionDirect: number;
    fraisGestionDirectNbLocaux: number;
    fraisProcedure: number;
    travauxEntretien: number;
    travauxAmelioration: number;
  };
  deficitAnterieurs: number;
  microFoncierCA: number;
}

// ---- Module 6 : LMNP ----
export interface RevenusLMNP {
  statut: 'lmnp' | 'lmp';
  regime: RegimeLMNP;
  recettes: number;
  charges: {
    chargesCopro: number;
    interetsEmprunt: number;
    assuranceADI: number;
    assurancePNO: number;
    taxeFonciere: number;
    fraisGestion: number;
    travauxEntretien: number;
    amortissementBien: number;
    amortissementMobilier: number;
    amortissementTravaux: number;
  };
}

// ---- Module 7 : SCI ----
export interface RevenusSCI {
  quotePartResultat: number;
  quotePartDeficit: number;
  typeSCI: 'ir' | 'is';
}

// ---- Module 8 : Patrimoine financier ----
export interface RevenusPatrimoine {
  interets: number;
  dividendes: number;
  revenusDistribuesFCP: number;
  avoirFiscal: number;
  optionBarem: boolean;
  csgDeductible: number;
  plusValuesMobilieres: number;
  moinsValuesMobilieres: number;
  plusValueImmobiliere: number;
  assuranceVieCt8ans: number;
  assuranceVieMt8ans: number;
}

// ---- Module 9 : Charges déductibles ----
export interface ChargesDeductibles {
  pensionEnfantMajeur: number;
  pensionExConjoint: number;
  pensionParents: number;
  versementsPER: number;
  versementsPERP: number;
  versementsMadelin: number;
  csgDeductible: number;
  deficitFoncierAnterieur: number;
}

// ---- Module 10 : Réductions / crédits d'impôt ----
export interface ReductionsCreditImpot {
  donsAssociations: number;
  donsUrgence: number;
  donsPartis: number;
  emploiDomicile: number;
  gardeEnfant1: number;
  gardeEnfant2: number;
  gardeEnfant3: number;
  enfantsCollege: number;
  enfantsLycee: number;
  enfantsSup: number;
  investPinel: number;
  investPME: number;
  investFCPI: number;
  cotisationsSyndicales: number;
  fraisComptabilite: number;
}

// ---- Module 11 : IFI ----
export interface IFI {
  assujetti: boolean;
  valeurBrute: number;
  passifDeductible: number;
}

// ---- État global ----
export interface TaxState {
  currentStep: number;
  modules: ModuleActivation;
  situationPersonnelle: SituationPersonnelle;
  revenusSalariaux: RevenusSalariaux;
  revenusRemplacement: RevenusRemplacement;
  revenusIndependant: RevenusIndependant;
  revenusFonciers: RevenusFonciers;
  revenusLMNP: RevenusLMNP;
  revenusSCI: RevenusSCI;
  revenusPatrimoine: RevenusPatrimoine;
  chargesDeductibles: ChargesDeductibles;
  reductionsCreditImpot: ReductionsCreditImpot;
  ifi: IFI;
}

// ---- Résultats de calcul ----
export interface FoncierCalc {
  totalRecettes: number;
  totalCharges: number;
  resultatNet: number;
  deficitImputableGlobal: number;
  deficitReportable: number;
  case4BA: number;
  case4BB: number;
  case4BC: number;
  case4BD: number;
}

export interface TaxCalculation {
  revenuBrutGlobal: number;
  chargesDeductiblesTotal: number;
  revenuNetGlobal: number;
  revenuImposable: number;
  nombreParts: number;
  quotientFamilial: number;
  impotBrut: number;
  gainQuotient: number;
  impotApresQF: number;
  decote: number;
  reductionsTotal: number;
  creditsTotal: number;
  prelevementsSociaux: number;
  impotNet: number;
  foncierCalc: FoncierCalc;
}

// ---- Cases fiscales ----
export interface CaseFiscale {
  code: string;
  libelle: string;
  montant: number;
  formulaire: string;
  justificatif: string;
}
