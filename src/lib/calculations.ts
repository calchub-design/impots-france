import { TaxState, TaxCalculation, FoncierCalc, CaseFiscale } from './types';
import { initialState } from './taxState';

// ── Paramètres fiscaux par année de déclaration ─────────────
interface ParamsFiscaux {
  // Barème IR (tranches sur le quotient familial)
  tranches: [number, number, number][]; // [seuil_haut, taux, montant_base_tranche_precedente]
  // Quotient familial
  plafondDemiPart: number;
  // Décote
  decoteCelibataire: [number, number]; // [seuil_impot, montant_reference]
  decoteCouple: [number, number];
  // Frais professionnels
  plafondFraisPro: number;
  // Retraite
  plafondAbattRetraite: number;
  // PER
  plafondPER: number;
  minPER: number;
  // Déficit foncier imputable sur le revenu global
  plafondDeficitFoncier: number;
  // Prélèvements sociaux et prélèvement forfaitaire
  tauxPS: number;            // revenus fonciers, intérêts et dividendes perçus en 2025
  tauxPSMajore: number;      // plus-values mobilières, LMNP (CSG à 10,6 % — LFSS 2026)
  tauxPFU: number;           // part impôt sur le revenu du PFU
  // Années de revenus / libellé
  anneeRevenus: number;
  libelleDeclaration: string;
}

// Déclaration 2026 — Revenus 2025
// Source : loi de finances 2026, JO du 19 février 2026
const PARAMS: ParamsFiscaux = {
  tranches: [
    [11600,  0.00, 0],
    [29579,  0.11, 0],
    [84577,  0.30, 17979 * 0.11],
    [181917, 0.41, 17979 * 0.11 + 54998 * 0.30],
    [Infinity, 0.45, 17979 * 0.11 + 54998 * 0.30 + 97340 * 0.41],
  ],
  plafondDemiPart: 1807,
  decoteCelibataire: [1982, 897],
  decoteCouple: [3277, 1483],
  plafondFraisPro: 14555,
  plafondAbattRetraite: 4439,
  plafondPER: 37680,
  minPER: 4710,
  plafondDeficitFoncier: 10700,
  tauxPS: 0.172,
  tauxPSMajore: 0.186,
  tauxPFU: 0.128,
  anneeRevenus: 2025,
  libelleDeclaration: 'Déclaration 2026 — Revenus 2025',
};

// ── Barème kilométrique (valable 2025) ───────────────────────
const BAREME_KM: Record<string, Record<string, { jusqu5k: number; de5kA20k: [number, number]; plus20k: number }>> = {
  voiture: {
    '3cv':     { jusqu5k: 0.529, de5kA20k: [0.316, 1065], plus20k: 0.370 },
    '4cv':     { jusqu5k: 0.606, de5kA20k: [0.340, 1330], plus20k: 0.407 },
    '5cv':     { jusqu5k: 0.636, de5kA20k: [0.357, 1395], plus20k: 0.427 },
    '6cv':     { jusqu5k: 0.665, de5kA20k: [0.374, 1457], plus20k: 0.447 },
    '7cv_plus':{ jusqu5k: 0.697, de5kA20k: [0.394, 1515], plus20k: 0.470 },
  },
};

export function calculerFraisKm(km: number, typeVehicule: string, cylindree: string): number {
  if (typeVehicule === 'velo') return km * 0.25;
  if (typeVehicule === 'moto') return km <= 3000 ? km * 0.395 : km <= 6000 ? km * 0.099 + 891 : km * 0.248;
  const t = BAREME_KM.voiture[cylindree] || BAREME_KM.voiture['5cv'];
  if (km <= 5000) return km * t.jusqu5k;
  if (km <= 20000) return km * t.de5kA20k[0] + t.de5kA20k[1];
  return km * t.plus20k;
}

// ── État effectif : les modules décochés ne comptent pas ─────
// Un module décoché dans le profil masque ses écrans ; ses données
// éventuellement saisies auparavant ne doivent donc plus entrer dans le calcul.
export function etatEffectif(state: TaxState): TaxState {
  const m = state.modules;
  return {
    ...state,
    revenusSalariaux: m.salaires ? state.revenusSalariaux : initialState.revenusSalariaux,
    revenusRemplacement: m.retraite ? state.revenusRemplacement : initialState.revenusRemplacement,
    revenusIndependant: m.independant ? state.revenusIndependant : initialState.revenusIndependant,
    revenusFonciers: m.locationNue ? state.revenusFonciers : initialState.revenusFonciers,
    revenusLMNP: m.locationMeublee ? state.revenusLMNP : initialState.revenusLMNP,
    revenusSCI: m.sci ? state.revenusSCI : initialState.revenusSCI,
    revenusPatrimoine: m.patrimoinefinancier || m.plusValues ? state.revenusPatrimoine : initialState.revenusPatrimoine,
    chargesDeductibles: m.chargesDeductibles ? state.chargesDeductibles : initialState.chargesDeductibles,
    reductionsCreditImpot: m.chargesDeductibles ? state.reductionsCreditImpot : initialState.reductionsCreditImpot,
  };
}

// ── Frais professionnels ────────────────────────────────────
export function calculerFraisReels(state: TaxState, qui: 'declarant' | 'conjoint'): number {
  const d = state.revenusSalariaux[qui];
  const km = calculerFraisKm(d.fraisReels.km, d.fraisReels.typeVehicule, d.fraisReels.cylindree);
  return km + d.fraisReels.repas + d.fraisReels.formation + d.fraisReels.doubleResidence + d.fraisReels.autresFrais;
}

export function calculerFraisForfait(salaire: number): number {
  return Math.min(salaire * 0.10, PARAMS.plafondFraisPro);
}

// Traitements et salaires au sens fiscal : salaires, avantages en nature,
// part imposable des indemnités de licenciement, allocations chômage et
// indemnités journalières. Tous ouvrent droit à la déduction de 10 % ou aux frais réels.
export function traitementsBruts(state: TaxState, qui: 'declarant' | 'conjoint'): number {
  const sal = state.revenusSalariaux[qui];
  const rep = state.revenusRemplacement[qui];
  return sal.salaires + sal.avantagesNature + rep.indemLicenciement + rep.chomage + rep.indemMaladie;
}

export function choisirFraisPro(state: TaxState, qui: 'declarant' | 'conjoint'): { montant: number; type: string } {
  const d = state.revenusSalariaux[qui];
  if (d.fraisPro === 'forfait') {
    return { montant: calculerFraisForfait(traitementsBruts(state, qui)), type: 'forfait' };
  }
  return { montant: calculerFraisReels(state, qui), type: 'reel' };
}

// ── Quotient familial ───────────────────────────────────────
export function calculerParts(state: TaxState): number {
  const { situationPersonnelle: sp } = state;
  const estCouple = sp.situationMaritale === 'marie_pacse';
  let parts = estCouple ? 2 : 1;

  const enfantsExclusifs = sp.enfants.filter(e => !e.gardeAlternee).length;
  const enfantsAlternee = sp.enfants.length - enfantsExclusifs;

  // Les enfants en garde exclusive sont décomptés en premier. Rangs 1 et 2 :
  // une demi-part ; à partir du rang 3 : une part. Moitié en garde alternée.
  for (let rang = 1; rang <= sp.enfants.length; rang++) {
    const partEntiere = rang <= 2 ? 0.5 : 1;
    parts += rang <= enfantsExclusifs ? partEntiere : partEntiere / 2;
  }

  // Parent isolé (case T)
  if (sp.parentIsole && !estCouple) {
    if (enfantsExclusifs > 0) parts += 0.5;
    else if (enfantsAlternee >= 2) parts += 0.5;
    else if (enfantsAlternee === 1) parts += 0.25;
  }

  // Invalide déclarant (+0.5)
  if (sp.invalide) parts += 0.5;
  // Ancien combattant (+0.5 si plus de 74 ans)
  if (sp.ancienCombattant) {
    const age = PARAMS.anneeRevenus - parseInt(sp.anneeNaissanceDeclarant || '1950');
    if (age > 74) parts += 0.5;
  }
  // Invalide conjoint
  if (sp.invalideConjoint && estCouple) parts += 0.5;

  return parts;
}

// ── Revenu foncier : calcul du déficit ─────────────────────
export function calculerFoncier(stateBrut: TaxState): FoncierCalc {
  const state = etatEffectif(stateBrut);
  const f = state.revenusFonciers;

  // Location directe
  let recettes = 0;
  let interets = 0;
  let autresCharges = 0;

  if (f.regime === 'micro') {
    recettes = f.microFoncierCA;
    autresCharges = recettes * 0.30;
  } else if (f.regime === 'reel') {
    const c = f.charges;
    recettes = f.recettes.loyersNus + f.recettes.chargesRecuperees + f.recettes.subventionsANAH;
    interets = c.interetsEmprunt;
    // Seule la TEOM récupérée sur le locataire n'est pas déductible, pas toute la taxe foncière
    const teomNonDeductible = c.teomRecuperee ? Math.min(c.teomMontant, c.taxeFonciere) : 0;
    autresCharges =
      Math.max(0, c.chargesCopro - c.chargesRecupereesSurLocataire) +
      c.assuranceADI +
      c.fraisGarantie +
      c.mainleveeHypotheque +
      c.assurancePNO +
      c.assuranceGLI +
      (c.taxeFonciere - teomNonDeductible) +
      c.fraisGestionAgence +
      c.fraisGestionDirect +
      c.fraisGestionDirectNbLocaux * 20 + // forfait de 20 € par local
      c.fraisProcedure +
      c.travauxEntretien +
      c.travauxAmelioration;
  }

  const totalCharges = interets + autresCharges;
  const resultatNet = recettes - totalCharges;

  // Quote-part de SCI à l'IR : un bénéfice s'ajoute aux recettes, un déficit
  // est traité comme une charge autre que des intérêts (détail inconnu ici).
  let recettesTotales = recettes;
  let autresChargesTotales = autresCharges;
  if (state.revenusSCI.typeSCI === 'ir') {
    recettesTotales += state.revenusSCI.quotePartResultat;
    autresChargesTotales += state.revenusSCI.quotePartDeficit;
  }

  const resultatGlobal = recettesTotales - interets - autresChargesTotales;
  const deficitsAnterieurs = f.deficitAnterieurs + state.chargesDeductibles.deficitFoncierAnterieur;

  let case4BA = 0;
  let deficitImputableGlobal = 0;
  let deficitReportable = 0;

  if (resultatGlobal >= 0) {
    // Les déficits antérieurs s'imputent sur le bénéfice foncier de l'année
    case4BA = Math.max(0, resultatGlobal - deficitsAnterieurs);
  } else {
    const deficit = -resultatGlobal;
    // Les intérêts s'imputent en priorité sur les recettes : seule la fraction
    // des intérêts qui dépasse les recettes est exclue de l'imputation sur le revenu global.
    const deficitDuAuxInterets = Math.max(0, interets - recettesTotales);
    const deficitAutresCharges = deficit - deficitDuAuxInterets;
    deficitImputableGlobal = Math.min(deficitAutresCharges, PARAMS.plafondDeficitFoncier);
    deficitReportable = deficit - deficitImputableGlobal;
  }

  return {
    totalRecettes: recettes,
    totalCharges,
    resultatNet,
    deficitImputableGlobal,
    deficitReportable,
    case4BA,
    case4BB: 0,
    case4BC: deficitImputableGlobal,
    case4BD: deficitReportable,
  };
}

// ── Barème IR ────────────────────────────────────────────────
export function calculerImpotBrut(revenuParPart: number): number {
  const { tranches } = PARAMS;
  let prev = 0;
  for (const [seuil, taux, base] of tranches) {
    if (revenuParPart <= seuil) {
      return base + (revenuParPart - prev) * taux;
    }
    prev = seuil;
  }
  return 0;
}

function plafonnementQF(impotSansParts: number, impotAvecParts: number, parts: number, estCouple: boolean): number {
  const partsBase = estCouple ? 2 : 1;
  const demisPartsSupp = (parts - partsBase) * 2;
  const gainMax = demisPartsSupp * PARAMS.plafondDemiPart;
  const gainReel = impotSansParts - impotAvecParts;
  if (gainReel > gainMax) return impotSansParts - gainMax;
  return impotAvecParts;
}

// ── Rente viagère : fraction imposable ─────────────────────
function fractionRenteViagere(age: number): number {
  if (age < 50) return 0.70;
  if (age < 60) return 0.50;
  if (age < 70) return 0.40;
  return 0.30;
}

// ── IFI ─────────────────────────────────────────────────────
export function calculerIFI(state: TaxState): number {
  if (!state.ifi.assujetti) return 0;
  const net = state.ifi.valeurBrute - state.ifi.passifDeductible;
  if (net < 1_300_000) return 0;
  const tranches: [number, number][] = [
    [800_000, 0],
    [1_300_000, 0.005],
    [2_570_000, 0.007],
    [5_000_000, 0.01],
    [10_000_000, 0.0125],
    [Infinity, 0.015],
  ];
  let ifi = 0;
  let prev = 0;
  for (const [seuil, taux] of tranches) {
    if (net > prev) ifi += (Math.min(net, seuil) - prev) * taux;
    prev = seuil;
  }
  // Décote entre 1,3 M€ et 1,4 M€
  if (net < 1_400_000) ifi -= 17_500 - 0.0125 * net;
  return Math.max(0, ifi);
}

// ── Plafond PER ─────────────────────────────────────────────
export function calculerPlafondPER(stateBrut: TaxState): number {
  const state = etatEffectif(stateBrut);
  const salD = state.revenusSalariaux.declarant.salaires + state.revenusSalariaux.declarant.avantagesNature;
  const salC = state.revenusSalariaux.conjoint.salaires + state.revenusSalariaux.conjoint.avantagesNature;
  return Math.max(Math.min((salD + salC) * 0.10, PARAMS.plafondPER), PARAMS.minPER);
}

// ── Calcul complet ──────────────────────────────────────────
export function calculerImpot(stateBrut: TaxState): TaxCalculation {
  const state = etatEffectif(stateBrut);
  const params = PARAMS;
  const parts = calculerParts(state);
  const estCouple = state.situationPersonnelle.situationMaritale === 'marie_pacse';

  // --- Traitements et salaires (y compris chômage, IJ, licenciement imposable) ---
  // Les heures supplémentaires exonérées (1GH) ne sont pas imposées.
  const traitD = traitementsBruts(state, 'declarant');
  const traitC = traitementsBruts(state, 'conjoint');
  const revSalNet =
    Math.max(0, traitD - choisirFraisPro(state, 'declarant').montant) +
    Math.max(0, traitC - choisirFraisPro(state, 'conjoint').montant);

  // --- Pensions (retraite + invalidité) : abattement de 10 % plafonné par foyer ---
  const repD = state.revenusRemplacement.declarant;
  const repC = state.revenusRemplacement.conjoint;
  const pensions = repD.retraite + repC.retraite + repD.invalidite + repC.invalidite;
  const abattPensions = Math.min(pensions * 0.10, params.plafondAbattRetraite);

  const rentes =
    repD.renteViagere * fractionRenteViagere(repD.ageRenteViagere) +
    repC.renteViagere * fractionRenteViagere(repC.ageRenteViagere);

  const revRemplacement = pensions - abattPensions + rentes;

  // --- Indépendant ---
  let revIndependant = 0;
  const ind = state.revenusIndependant;
  if (ind.microEntreprise.actif && !ind.microEntreprise.versementLiberatoire) {
    const ca = ind.microEntreprise.chiffreAffaires;
    const type = ind.microEntreprise.typeActivite;
    if (type === 'vente') revIndependant += ca * (1 - 0.71);
    else if (type === 'services_bic') revIndependant += ca * (1 - 0.50);
    else if (type === 'services_bnc') revIndependant += ca * (1 - 0.34);
  }
  if (ind.reel.actif) revIndependant += ind.reel.resultatNet - ind.reel.deficit;
  if (ind.gerantSarl.actif) {
    const remun = ind.gerantSarl.remuneration;
    if (ind.gerantSarl.fraisPro === 'forfait') revIndependant += Math.max(0, remun - Math.min(remun * 0.1, params.plafondFraisPro));
    else revIndependant += remun;
  }

  // --- Foncier ---
  const foncierCalc = calculerFoncier(state);

  // --- Location meublée ---
  let revLMNP = 0;
  const lmnp = state.revenusLMNP;
  if (lmnp.regime === 'micro') {
    revLMNP = lmnp.recettes * 0.50;
  } else if (lmnp.regime === 'reel') {
    const chargesLMNP = Object.values(lmnp.charges).reduce((a, b) => a + b, 0);
    revLMNP = Math.max(0, lmnp.recettes - chargesLMNP);
  }

  // --- Patrimoine financier ---
  // PFU (par défaut) : 12,8 % d'impôt sur intérêts, dividendes et plus-values.
  // Option barème (2OP) : globale, tout passe au barème avec abattement de 40 % sur les dividendes.
  const pat = state.revenusPatrimoine;
  const pvMob = Math.max(0, pat.plusValuesMobilieres - pat.moinsValuesMobilieres);
  const revenusMobiliers = pat.interets + pat.dividendes + pat.revenusDistribuesFCP;
  // Assurance-vie : abattement annuel sur les contrats de plus de 8 ans
  const avPlus8 = Math.max(0, pat.assuranceVieCt8ans - (estCouple ? 9200 : 4600));
  const avMoins8 = pat.assuranceVieMt8ans;

  let revPatrimoineBareme = 0;
  let impotForfaitaire = 0;
  if (pat.optionBarem) {
    revPatrimoineBareme = pat.interets + pat.dividendes * 0.60 + pat.revenusDistribuesFCP + pvMob + avPlus8 + avMoins8;
  } else {
    impotForfaitaire = (revenusMobiliers + pvMob + avMoins8) * params.tauxPFU + avPlus8 * 0.075;
  }

  // --- Revenu brut global ---
  const revenuBrutGlobal =
    revSalNet +
    revRemplacement +
    revIndependant +
    foncierCalc.case4BA +
    revLMNP +
    revPatrimoineBareme;

  // --- Charges déductibles ---
  const ch = state.chargesDeductibles;
  const pensionAlim = ch.pensionEnfantMajeur + ch.pensionExConjoint + ch.pensionParents;
  const epargneRetraite = Math.min(ch.versementsPER + ch.versementsPERP + ch.versementsMadelin, calculerPlafondPER(state));
  const chargesDeductiblesTotal = pensionAlim + epargneRetraite + ch.csgDeductible + foncierCalc.case4BC;

  // --- Revenu net global ---
  const revenuNetGlobal = Math.max(0, revenuBrutGlobal - chargesDeductiblesTotal);

  // --- Calcul IR ---
  const partsBase = estCouple ? 2 : 1;
  const impotSansParts = calculerImpotBrut(revenuNetGlobal / partsBase) * partsBase;
  const quotientTotal = revenuNetGlobal / parts;
  const impotAvecParts = calculerImpotBrut(quotientTotal) * parts;
  const impotApresQFBrut = plafonnementQF(impotSansParts, impotAvecParts, parts, estCouple);

  const [seuilDecote, montantDecote] = estCouple ? params.decoteCouple : params.decoteCelibataire;
  let decote = 0;
  if (impotApresQFBrut > 0 && impotApresQFBrut <= seuilDecote) {
    decote = Math.min(impotApresQFBrut, Math.max(0, montantDecote - impotApresQFBrut * 0.4525));
  }
  const impotApresDecote = impotApresQFBrut - decote;

  // --- Réductions d'impôt (non remboursables) ---
  const red = state.reductionsCreditImpot;
  // Dons : 75 % jusqu'à 1 000 €, 66 % au-delà dans la limite de 20 % du revenu imposable
  const donsUrgence75 = Math.min(red.donsUrgence, 1000);
  const dons66 = Math.min(
    red.donsAssociations + (red.donsUrgence - donsUrgence75) + Math.min(red.donsPartis, 15000),
    revenuNetGlobal * 0.20,
  );
  const reductionsHorsPlafond =
    donsUrgence75 * 0.75 +
    dons66 * 0.66 +
    red.enfantsCollege * 61 +
    red.enfantsLycee * 153 +
    red.enfantsSup * 183 +
    Math.min(red.fraisComptabilite * 2 / 3, 915) +
    pat.avoirFiscal;
  let reductionsPlafonnees = red.investPinel * 0.12 + red.investPME * 0.25 + red.investFCPI * 0.18;

  // --- Crédits d'impôt (remboursables) ---
  const plafondEmploi = Math.min(12000 + state.situationPersonnelle.enfants.length * 1500, 15000);
  let creditsPlafonnes =
    Math.min(red.emploiDomicile, plafondEmploi) * 0.50 +
    Math.min(red.gardeEnfant1, 3500) * 0.50 +
    Math.min(red.gardeEnfant2, 3500) * 0.50 +
    Math.min(red.gardeEnfant3, 3500) * 0.50;
  // Cotisations syndicales : 66 % dans la limite de 1 % des salaires et pensions
  const creditSyndical = Math.min(red.cotisationsSyndicales, (traitD + traitC + pensions) * 0.01) * 0.66;

  // Plafonnement global des niches fiscales : 10 000 € par foyer
  const excedentNiches = Math.max(0, reductionsPlafonnees + creditsPlafonnes - 10000);
  const retraitReductions = Math.min(excedentNiches, reductionsPlafonnees);
  reductionsPlafonnees -= retraitReductions;
  creditsPlafonnes -= excedentNiches - retraitReductions;

  // Une réduction ne peut pas dépasser l'impôt ; un crédit est remboursé
  const reductionsTotal = Math.min(reductionsHorsPlafond + reductionsPlafonnees, impotApresDecote);
  const creditsTotal = creditsPlafonnes + creditSyndical;
  const impotBareme = impotApresDecote - reductionsTotal - creditsTotal;

  // --- Prélèvements sociaux ---
  // 17,2 % : revenus fonciers, intérêts et dividendes perçus en 2025.
  // 18,6 % : plus-values mobilières et location meublée non professionnelle (LFSS 2026).
  // LMP : cotisations sociales, pas de prélèvements sociaux. Assurance-vie : prélevés par l'assureur.
  const prelevementsSociaux =
    (foncierCalc.case4BA + revenusMobiliers) * params.tauxPS +
    (pvMob + (lmnp.statut === 'lmnp' ? revLMNP : 0)) * params.tauxPSMajore;

  const impotNet = impotBareme + impotForfaitaire + prelevementsSociaux;

  return {
    revenuBrutGlobal,
    chargesDeductiblesTotal,
    revenuNetGlobal,
    revenuImposable: revenuNetGlobal,
    nombreParts: parts,
    quotientFamilial: quotientTotal,
    impotBrut: impotAvecParts,
    gainQuotient: impotSansParts - impotAvecParts,
    impotApresQF: impotApresQFBrut,
    decote,
    reductionsTotal,
    creditsTotal,
    impotForfaitaire,
    prelevementsSociaux,
    impotNet,
    ifi: calculerIFI(state),
    foncierCalc,
  };
}

// ── Génération des cases fiscales ──────────────────────────
export function genererCases(stateBrut: TaxState, calc: TaxCalculation): CaseFiscale[] {
  const state = etatEffectif(stateBrut);
  const cases: CaseFiscale[] = [];
  const add = (code: string, libelle: string, montant: number, formulaire: string, justificatif: string) => {
    if (montant > 0) cases.push({ code, libelle, montant, formulaire, justificatif });
  };

  // Salaires (les indemnités journalières et la part imposable du licenciement se déclarent avec les salaires)
  const sal = state.revenusSalariaux;
  const repD = state.revenusRemplacement.declarant;
  const repC = state.revenusRemplacement.conjoint;
  add('1AJ', 'Salaires — Vous', sal.declarant.salaires + sal.declarant.avantagesNature + repD.indemMaladie + repD.indemLicenciement, '2042 p.1', 'Bulletins de salaire / attestation CPAM');
  add('1BJ', 'Salaires — Conjoint', sal.conjoint.salaires + sal.conjoint.avantagesNature + repC.indemMaladie + repC.indemLicenciement, '2042 p.1', 'Bulletins de salaire / attestation CPAM');
  if (sal.declarant.fraisPro === 'reel') add('1AK', 'Frais réels — Vous', calculerFraisReels(state, 'declarant'), '2042 p.1', 'Justificatifs de frais (km, repas…)');
  if (sal.conjoint.fraisPro === 'reel') add('1BK', 'Frais réels — Conjoint', calculerFraisReels(state, 'conjoint'), '2042 p.1', 'Justificatifs de frais (km, repas…)');
  add('1GH', 'Heures supplémentaires exonérées — Vous', sal.declarant.heuresSup, '2042 p.1', 'Bulletins de salaire');
  add('1HH', 'Heures supplémentaires exonérées — Conjoint', sal.conjoint.heuresSup, '2042 p.1', 'Bulletins de salaire');

  // Remplacement
  add('1AP', 'Allocations chômage — Vous', repD.chomage, '2042 p.1', 'Relevé France Travail');
  add('1BP', 'Allocations chômage — Conjoint', repC.chomage, '2042 p.1', 'Relevé France Travail');
  add('1AS', 'Pensions de retraite — Vous', repD.retraite, '2042 p.1', 'Attestation de retraite');
  add('1BS', 'Pensions de retraite — Conjoint', repC.retraite, '2042 p.1', 'Attestation de retraite');
  add('1AZ', 'Pensions d\'invalidité — Vous', repD.invalidite, '2042 p.1', 'Attestation CPAM');
  add('1BZ', 'Pensions d\'invalidité — Conjoint', repC.invalidite, '2042 p.1', 'Attestation CPAM');
  add('1AW', 'Rente viagère — Vous', repD.renteViagere, '2042 p.1', 'Attestation crédirentier');
  add('1BW', 'Rente viagère — Conjoint', repC.renteViagere, '2042 p.1', 'Attestation crédirentier');

  // Indépendant
  const ind = state.revenusIndependant;
  if (ind.microEntreprise.actif) {
    const ca = ind.microEntreprise.chiffreAffaires;
    const type = ind.microEntreprise.typeActivite;
    if (ind.microEntreprise.versementLiberatoire) {
      // Avec le versement libératoire, le CA se déclare dans des cases dédiées
      if (type === 'vente') add('5TA', 'Micro-BIC vente — versement libératoire', ca, '2042C PRO', 'Attestation URSSAF');
      if (type === 'services_bic') add('5TB', 'Micro-BIC services — versement libératoire', ca, '2042C PRO', 'Attestation URSSAF');
      if (type === 'services_bnc') add('5TE', 'Micro-BNC — versement libératoire', ca, '2042C PRO', 'Attestation URSSAF');
    } else {
      if (type === 'vente') add('5KO', 'Micro-BIC vente de marchandises', ca, '2042C PRO', 'Livre de recettes auto-entrepreneur');
      if (type === 'services_bic') add('5KP', 'Micro-BIC prestations de services', ca, '2042C PRO', 'Livre de recettes auto-entrepreneur');
      if (type === 'services_bnc') add('5HQ', 'Micro-BNC prestations de services', ca, '2042C PRO', 'Livre de recettes auto-entrepreneur');
    }
  }
  if (ind.reel.actif) {
    if (ind.reel.typeFiscal === 'bnc') add('5QC', 'BNC réel — Bénéfice', ind.reel.resultatNet, '2042C PRO', 'Déclaration 2035');
    else add('5KC', 'BIC réel — Bénéfice', ind.reel.resultatNet, '2042C PRO', 'Déclaration 2031');
  }
  if (ind.gerantSarl.actif) add('1GB', 'Rémunération gérance art. 62', ind.gerantSarl.remuneration, '2042 p.1', 'Bulletin de gérance');

  // Foncier (location directe et quote-part de SCI)
  const fc = calc.foncierCalc;
  if (state.revenusFonciers.regime === 'micro') {
    add('4BE', 'Revenus fonciers micro-foncier', state.revenusFonciers.microFoncierCA, '2042 p.3', 'Aucun justificatif requis (abattement forfaitaire 30%)');
  } else {
    add('4BA', 'Revenus fonciers nets (régime réel)', fc.case4BA, '2042 p.3 + 2044', 'Voir déclaration 2044 / relevé de la SCI');
  }
  add('4BC', 'Déficit foncier imputable sur revenu global', fc.case4BC, '2042 p.3', 'Voir déclaration 2044');
  add('4BD', 'Déficit foncier reportable (10 ans)', fc.case4BD, '2042 p.3', 'Voir déclaration 2044');

  // Location meublée
  const lmnp = state.revenusLMNP;
  if (lmnp.regime === 'micro') add('5ND', 'Location meublée — Micro-BIC', lmnp.recettes, '2042C PRO', 'Aucun justificatif requis (abattement 50%)');
  if (lmnp.regime === 'reel') {
    const benefLMNP = lmnp.recettes - Object.values(lmnp.charges).reduce((a, b) => a + b, 0);
    add('5NA', 'LMNP régime réel — Bénéfice', benefLMNP, '2042C PRO', 'Liasse 2031-SD + expert-comptable');
  }

  // Patrimoine financier
  const pat = state.revenusPatrimoine;
  add('2TR', 'Intérêts et produits de placement', pat.interets, '2042 p.2', 'IFU banque');
  add('2DC', 'Dividendes bruts', pat.dividendes, '2042 p.2', 'IFU banque / courtier');
  add('2TS', 'Revenus distribués SICAV / FCP', pat.revenusDistribuesFCP, '2042 p.2', 'IFU banque / courtier');
  if (pat.optionBarem) add('2OP', 'Option barème progressif (tous revenus et gains mobiliers)', 1, '2042 p.2', 'Case à cocher — pas de montant');
  add('2AB', 'Crédit impôt étranger', pat.avoirFiscal, '2042 p.2', 'IFU courtier');
  add('2BH', 'CSG déductible (pré-remplie)', pat.csgDeductible, '2042 p.2', 'Pré-remplie par l\'administration');
  add('2CH', 'Assurance-vie de plus de 8 ans — produits', pat.assuranceVieCt8ans, '2042 p.2', 'IFU assureur');
  add('3VG', 'Plus-values de cession valeurs mobilières', pat.plusValuesMobilieres, '2042 p.3', 'IFU courtier');
  add('3VH', 'Moins-values imputables', pat.moinsValuesMobilieres, '2042 p.3', 'IFU courtier');
  add('3VZ', 'Plus-value immobilière nette (déjà imposée chez le notaire)', pat.plusValueImmobiliere, '2042 p.3', 'Formulaire 2048 du notaire');

  // Charges déductibles
  const ch = state.chargesDeductibles;
  add('6EL', 'Pensions alimentaires (enfant majeur / parents)', ch.pensionEnfantMajeur + ch.pensionParents, '2042 p.4', 'Justificatifs de paiement ou forfaits officiels');
  add('6GU', 'Pension versée à l\'ex-conjoint', ch.pensionExConjoint, '2042 p.4', 'Décision judiciaire + justificatifs paiement');
  add('6NS', 'Versements PER / PERP / Madelin', ch.versementsPER + ch.versementsPERP + ch.versementsMadelin, '2042 p.4', 'Attestation organisme assureur');
  add('6DE', 'CSG déductible sur revenus du patrimoine', ch.csgDeductible, '2042 p.4', 'Pré-remplie par l\'administration');

  // Réductions / crédits
  const red = state.reductionsCreditImpot;
  add('7UF', 'Dons associations intérêt général', red.donsAssociations, '2042 RICI', 'Reçu fiscal association');
  add('7UD', 'Dons associations aide aux personnes', red.donsUrgence, '2042 RICI', 'Reçu fiscal association');
  add('7UH', 'Dons partis politiques', red.donsPartis, '2042 RICI', 'Reçu fiscal');
  add('7DB', 'Emploi à domicile (dépenses totales)', red.emploiDomicile, '2042 RICI', 'Attestation URSSAF ou relevé CESU');
  add('7GA', 'Garde enfant < 6 ans hors domicile — 1er', red.gardeEnfant1, '2042 RICI', 'Attestation CAF / PAJE / établissement');
  add('7GB', 'Garde enfant < 6 ans hors domicile — 2e', red.gardeEnfant2, '2042 RICI', 'Attestation CAF / PAJE / établissement');
  add('7GC', 'Garde enfant < 6 ans hors domicile — 3e', red.gardeEnfant3, '2042 RICI', 'Attestation CAF / PAJE / établissement');
  add('7EA', 'Enfant(s) au collège', red.enfantsCollege, '2042 RICI', 'Aucun justificatif requis');
  add('7EC', 'Enfant(s) au lycée', red.enfantsLycee, '2042 RICI', 'Aucun justificatif requis');
  add('7EF', 'Enfant(s) dans le supérieur', red.enfantsSup, '2042 RICI', 'Aucun justificatif requis');
  add('7QA', 'Investissement Pinel', red.investPinel, '2042 RICI', 'Attestation gestionnaire patrimoine');
  add('7CF', 'Souscription capital PME', red.investPME, '2042 RICI', 'Attestation PME');
  add('7FQ', 'Souscription FCPI / FIP', red.investFCPI, '2042 RICI', 'Attestation de la société de gestion');
  add('7AC', 'Cotisations syndicales', red.cotisationsSyndicales, '2042 RICI', 'Attestation syndicale');
  add('7FF', 'Frais de comptabilité et d\'adhésion', red.fraisComptabilite, '2042 RICI', 'Factures expert-comptable / organisme agréé');

  return cases;
}
