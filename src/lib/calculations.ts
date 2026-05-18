import { TaxState, TaxCalculation, FoncierCalc, CaseFiscale } from './types';

// ── Barème kilométrique 2024 ────────────────────────────────
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

// ── Frais professionnels ────────────────────────────────────
export function calculerFraisReels(state: TaxState, qui: 'declarant' | 'conjoint'): number {
  const d = state.revenusSalariaux[qui];
  const km = calculerFraisKm(d.fraisReels.km, d.fraisReels.typeVehicule, d.fraisReels.cylindree);
  return km + d.fraisReels.repas + d.fraisReels.formation + d.fraisReels.doubleResidence + d.fraisReels.autresFrais;
}

export function calculerFraisForfait(salaire: number): number {
  return Math.min(salaire * 0.10, 14696);
}

export function choisirFraisPro(state: TaxState, qui: 'declarant' | 'conjoint'): { montant: number; type: string } {
  const d = state.revenusSalariaux[qui];
  const salaireBrut = d.salaires + d.avantagesNature;
  if (d.fraisPro === 'forfait') {
    return { montant: calculerFraisForfait(salaireBrut), type: 'forfait' };
  }
  const reels = calculerFraisReels(state, qui);
  return { montant: reels, type: 'reel' };
}

// ── Quotient familial ───────────────────────────────────────
export function calculerParts(state: TaxState): number {
  const { situationPersonnelle: sp } = state;
  let parts = sp.situationMaritale === 'marie_pacse' ? 2 : 1;

  let enfantsExclusifs = 0;
  let enfantsAlternee = 0;
  sp.enfants.forEach(e => {
    if (e.gardeAlternee) enfantsAlternee++;
    else enfantsExclusifs++;
  });

  // Calcul parts pour enfants en garde exclusive
  if (enfantsExclusifs >= 1) parts += 0.5;
  if (enfantsExclusifs >= 2) parts += 0.5;
  if (enfantsExclusifs >= 3) parts += (enfantsExclusifs - 2) * 1;

  // Garde alternée : moitié de la demi-part
  parts += enfantsAlternee * 0.25;

  // Parent isolé (+0.5)
  if (sp.parentIsole && sp.situationMaritale !== 'marie_pacse') {
    if (sp.enfants.length > 0) parts += 0.5;
  }

  // Invalide déclarant (+0.5)
  if (sp.invalide) parts += 0.5;
  // Ancien combattant (+0.5 si >75 ans)
  if (sp.ancienCombattant) {
    const age = 2025 - parseInt(sp.anneeNaissanceDeclarant || '1950');
    if (age >= 75) parts += 0.5;
  }
  // Invalide conjoint
  if (sp.invalideConjoint && sp.situationMaritale === 'marie_pacse') parts += 0.5;

  return parts;
}

// ── Revenu foncier : calcul du déficit ─────────────────────
export function calculerFoncier(state: TaxState): FoncierCalc {
  const f = state.revenusFonciers;

  if (f.regime === 'micro') {
    const base = f.microFoncierCA;
    const net = base * 0.70;
    return {
      totalRecettes: base,
      totalCharges: base * 0.30,
      resultatNet: net,
      deficitImputableGlobal: 0,
      deficitReportable: 0,
      case4BA: net > 0 ? net : 0,
      case4BB: 0,
      case4BC: 0,
      case4BD: 0,
    };
  }

  const recettes = f.recettes.loyersNus + f.recettes.chargesRecuperees + f.recettes.subventionsANAH;
  const teomDeductible = f.charges.teomRecuperee ? 0 : 0; // TEOM déjà dans taxe foncière
  const gestionDirect = f.charges.fraisGestionDirectNbLocaux * 20;
  const chargesHorsInterets =
    Math.max(0, f.charges.chargesCopro - f.charges.chargesRecupereesSurLocataire) +
    f.charges.assuranceADI +
    f.charges.fraisGarantie +
    f.charges.mainleveeHypotheque +
    f.charges.assurancePNO +
    f.charges.assuranceGLI +
    (f.charges.teomRecuperee ? 0 : f.charges.taxeFonciere) +
    f.charges.fraisGestionAgence +
    (f.charges.fraisGestionDirect > 0 ? f.charges.fraisGestionDirect : gestionDirect) +
    f.charges.fraisProcedure +
    f.charges.travauxEntretien +
    f.charges.travauxAmelioration;

  const interets = f.charges.interetsEmprunt;
  const totalCharges = chargesHorsInterets + interets;
  const resultatNet = recettes - totalCharges;

  // Règle : les intérêts ne peuvent pas créer de déficit imputable sur revenu global
  const resultatSansInterets = recettes - chargesHorsInterets;

  let case4BA = 0;
  let case4BB = 0;
  let case4BC = 0;
  let case4BD = 0;
  let deficitImputableGlobal = 0;
  let deficitReportable = 0;

  if (resultatNet >= 0) {
    case4BA = resultatNet;
  } else {
    // Déficit total
    if (resultatSansInterets >= 0) {
      // Seuls les intérêts créent le déficit => reportable uniquement
      deficitReportable = Math.abs(resultatNet);
      case4BD = deficitReportable;
    } else {
      // Les charges hors intérêts créent un déficit
      const deficitHorsInterets = Math.abs(resultatSansInterets);
      deficitImputableGlobal = Math.min(deficitHorsInterets, 10700);
      case4BC = deficitImputableGlobal;
      const exces = deficitHorsInterets > 10700 ? deficitHorsInterets - 10700 : 0;
      deficitReportable = exces + interets;
      case4BD = deficitReportable;
    }
  }

  // Quote-part SCI
  if (state.revenusSCI.typeSCI === 'ir') {
    if (state.revenusSCI.quotePartResultat > 0) {
      case4BA += state.revenusSCI.quotePartResultat;
    } else if (state.revenusSCI.quotePartDeficit > 0) {
      const addDeficit = state.revenusSCI.quotePartDeficit;
      deficitImputableGlobal = Math.min(deficitImputableGlobal + addDeficit, 10700);
      case4BC = deficitImputableGlobal;
    }
  }

  return {
    totalRecettes: recettes,
    totalCharges,
    resultatNet,
    deficitImputableGlobal,
    deficitReportable,
    case4BA,
    case4BB,
    case4BC,
    case4BD,
  };
}

// ── Barème IR 2025 (revenus 2025, déclaration 2026) ─────────
// ⚠️ À VÉRIFIER sur impots.gouv.fr — valeurs estimées par indexation ~1,8%
// depuis le barème 2024. Mettre à jour dès publication loi de finances 2026.
export function calculerImpotBrut(revenuParPart: number): number {
  let impot = 0;
  if (revenuParPart <= 11497) return 0;
  if (revenuParPart <= 29315) impot = (revenuParPart - 11497) * 0.11;
  else if (revenuParPart <= 83823) impot = 17818 * 0.11 + (revenuParPart - 29315) * 0.30;
  else if (revenuParPart <= 180294) impot = 17818 * 0.11 + 54508 * 0.30 + (revenuParPart - 83823) * 0.41;
  else impot = 17818 * 0.11 + 54508 * 0.30 + 96471 * 0.41 + (revenuParPart - 180294) * 0.45;
  return impot;
}

function plafonnementQF(impotSansParts: number, impotAvecParts: number, parts: number, estCouple: boolean): number {
  const partsBase = estCouple ? 2 : 1;
  const demisPartsSupp = (parts - partsBase) * 2;
  // ⚠️ Plafond par demi-part 2025 — à vérifier (1 791€ estimé, +1,8% vs 1 759€ en 2024)
  const gainMax = demisPartsSupp * 1791;
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

// ── Calcul complet ──────────────────────────────────────────
export function calculerImpot(state: TaxState): TaxCalculation {
  const parts = calculerParts(state);
  const estCouple = state.situationPersonnelle.situationMaritale === 'marie_pacse';

  // --- Revenus salariaux ---
  const fraisD = choisirFraisPro(state, 'declarant');
  const fraisC = choisirFraisPro(state, 'conjoint');
  const salD = state.revenusSalariaux.declarant.salaires + state.revenusSalariaux.declarant.avantagesNature;
  const salC = state.revenusSalariaux.conjoint.salaires + state.revenusSalariaux.conjoint.avantagesNature;
  const revSalNet = Math.max(0, salD - fraisD.montant) + Math.max(0, salC - fraisC.montant);

  // Heures sup exonérées : non incluses dans 1AJ
  const heuresSupD = state.revenusSalariaux.declarant.heuresSup;
  const heuresSupC = state.revenusSalariaux.conjoint.heuresSup;

  // --- Revenus de remplacement ---
  const repD = state.revenusRemplacement.declarant;
  const repC = state.revenusRemplacement.conjoint;
  // Retraite : abattement 10% plafonné à 4478€/foyer
  const retraiteD = repD.retraite * 0.9;
  const retraiteC = repC.retraite * 0.9;
  const abattRetraite = Math.min((repD.retraite + repC.retraite) * 0.1, 4478);

  const renteD = repD.renteViagere * fractionRenteViagere(repD.ageRenteViagere);
  const renteC = repC.renteViagere * fractionRenteViagere(repC.ageRenteViagere);

  const revRemplacement =
    repD.chomage + repC.chomage +
    repD.indemMaladie + repC.indemMaladie +
    repD.retraite - abattRetraite +
    repD.invalidite + repC.invalidite +
    renteD + renteC;

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
  if (ind.reel.actif) revIndependant += ind.reel.resultatNet;
  if (ind.gerantSarl.actif) {
    const remun = ind.gerantSarl.remuneration;
    if (ind.gerantSarl.fraisPro === 'forfait') revIndependant += Math.max(0, remun - Math.min(remun * 0.1, 14696));
    else revIndependant += remun;
  }

  // --- Foncier ---
  const foncierCalc = calculerFoncier(state);

  // --- LMNP ---
  let revLMNP = 0;
  const lmnp = state.revenusLMNP;
  if (state.modules.locationMeublee) {
    if (lmnp.regime === 'micro') {
      revLMNP = lmnp.recettes * 0.50;
    } else if (lmnp.regime === 'reel') {
      const chargesLMNP = Object.values(lmnp.charges).reduce((a, b) => a + b, 0);
      revLMNP = Math.max(0, lmnp.recettes - chargesLMNP);
    }
  }

  // --- Patrimoine financier ---
  const pat = state.revenusPatrimoine;
  let revPatrimoine = pat.interets;
  if (pat.optionBarem) {
    revPatrimoine += pat.dividendes * 0.60; // après abattement 40%
    revPatrimoine += pat.revenusDistribuesFCP;
  }
  // PV mobilières si barème (sinon PFU)
  const pvMob = Math.max(0, pat.plusValuesMobilieres - pat.moinsValuesMobilieres);

  // --- Revenu brut global ---
  const revenuBrutGlobal =
    revSalNet +
    revRemplacement +
    revIndependant +
    foncierCalc.case4BA +
    revLMNP +
    revPatrimoine;

  // --- Charges déductibles ---
  const ch = state.chargesDeductibles;
  const revN1 = salD + salC;
  const plafondPER = Math.max(Math.min(revN1 * 0.10, 35816), 4478);
  const pensionAlim = ch.pensionEnfantMajeur + ch.pensionExConjoint + ch.pensionParents;
  const epargneRetraite = Math.min(ch.versementsPER + ch.versementsPERP + ch.versementsMadelin, plafondPER);
  const chargesDeductiblesTotal = pensionAlim + epargneRetraite + ch.csgDeductible + foncierCalc.case4BC;

  // --- Revenu net global ---
  const revenuNetGlobal = Math.max(0, revenuBrutGlobal - chargesDeductiblesTotal);

  // --- Calcul IR ---
  const partsBase = estCouple ? 2 : 1;
  const quotientBase = revenuNetGlobal / partsBase;
  const impotSansParts = calculerImpotBrut(quotientBase) * partsBase;

  const quotientTotal = revenuNetGlobal / parts;
  const impotAvecParts = calculerImpotBrut(quotientTotal) * parts;

  const impotApresQFBrut = plafonnementQF(impotSansParts, impotAvecParts, parts, estCouple);

  // Décote 2025 — ⚠️ seuils estimés (+1,8% vs 2024), à vérifier sur impots.gouv.fr
  let decote = 0;
  if (!estCouple && impotApresQFBrut > 0 && impotApresQFBrut <= 1965) {
    decote = Math.max(0, 889 - impotApresQFBrut * 0.4525);
  } else if (estCouple && impotApresQFBrut > 0 && impotApresQFBrut <= 3249) {
    decote = Math.max(0, 1470 - impotApresQFBrut * 0.4525);
  }

  const impotApresDecote = Math.max(0, impotApresQFBrut - decote);

  // --- Réductions d'impôt ---
  const red = state.reductionsCreditImpot;
  let reductionsTotal = 0;
  // Dons urgence 75% (plafond 1000€)
  const donsUrgence1000 = Math.min(red.donsUrgence, 1000);
  const donsUrgenceReste = Math.max(0, red.donsUrgence - 1000);
  reductionsTotal += donsUrgence1000 * 0.75;
  reductionsTotal += (red.donsAssociations + donsUrgenceReste) * 0.66;
  reductionsTotal += red.donsPartis * 0.66;
  // Enseignement scolaire
  reductionsTotal += red.enfantsCollege * 61;
  reductionsTotal += red.enfantsLycee * 153;
  reductionsTotal += red.enfantsSup * 183;
  // Pinel
  reductionsTotal += red.investPinel * 0.12;
  // PME
  reductionsTotal += red.investPME * 0.25;
  reductionsTotal += (red.investFCPI) * 0.18;

  // --- Crédits d'impôt ---
  let creditsTotal = 0;
  // Emploi à domicile
  const plafonEmploi = 12000 + (state.situationPersonnelle.enfants.length * 1500);
  creditsTotal += Math.min(red.emploiDomicile, plafonEmploi) * 0.50;
  // Garde enfant
  creditsTotal += Math.min(red.gardeEnfant1, 3500) * 0.50;
  creditsTotal += Math.min(red.gardeEnfant2, 3500) * 0.50;
  creditsTotal += Math.min(red.gardeEnfant3, 3500) * 0.50;
  // Cotisations syndicales
  creditsTotal += red.cotisationsSyndicales * 0.66;
  // Frais comptabilité
  creditsTotal += Math.min(red.fraisComptabilite, 915) * 0.50;

  const impotApresReductions = Math.max(0, impotApresDecote - reductionsTotal - creditsTotal);

  // --- Prélèvements sociaux (17,2%) sur revenus du patrimoine ---
  const basePS =
    foncierCalc.case4BA +
    revLMNP +
    (pat.optionBarem ? (pat.dividendes + pat.revenusDistribuesFCP) : 0) +
    pat.interets +
    pvMob;
  const prelevementsSociaux = basePS * 0.172;

  // Si PFU : flat tax 30% sur dividendes + PV mobilières
  let pfuTotal = 0;
  if (!pat.optionBarem) {
    pfuTotal = (pat.dividendes + pat.revenusDistribuesFCP + pvMob) * 0.30;
  }

  const impotNet = impotApresReductions + prelevementsSociaux + pfuTotal;

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
    prelevementsSociaux,
    impotNet,
    foncierCalc,
  };
}

// ── Génération des cases fiscales ──────────────────────────
export function genererCases(state: TaxState, calc: TaxCalculation): CaseFiscale[] {
  const cases: CaseFiscale[] = [];
  const add = (code: string, libelle: string, montant: number, formulaire: string, justificatif: string) => {
    if (montant !== 0) cases.push({ code, libelle, montant, formulaire, justificatif });
  };

  // Salaires
  const fraisD = choisirFraisPro(state, 'declarant');
  const fraisC = choisirFraisPro(state, 'conjoint');
  const sal = state.revenusSalariaux;
  if (sal.declarant.salaires > 0) add('1AJ', 'Salaires — Vous', sal.declarant.salaires + sal.declarant.avantagesNature, '2042 p.1', 'Bulletins de salaire / AER employeur');
  if (sal.conjoint.salaires > 0) add('1BJ', 'Salaires — Conjoint', sal.conjoint.salaires + sal.conjoint.avantagesNature, '2042 p.1', 'Bulletins de salaire / AER employeur');
  if (sal.declarant.fraisPro === 'reel' && fraisD.montant > 0) add('1AK', 'Frais réels — Vous', fraisD.montant, '2042 p.1', 'Justificatifs de frais (km, repas…)');
  if (sal.conjoint.fraisPro === 'reel' && fraisC.montant > 0) add('1BK', 'Frais réels — Conjoint', fraisC.montant, '2042 p.1', 'Justificatifs de frais (km, repas…)');
  if (sal.declarant.heuresSup > 0) add('1GH', 'Heures supplémentaires exonérées — Vous', sal.declarant.heuresSup, '2042 p.1', 'Bulletins de salaire');
  if (sal.conjoint.heuresSup > 0) add('1HH', 'Heures supplémentaires exonérées — Conjoint', sal.conjoint.heuresSup, '2042 p.1', 'Bulletins de salaire');

  // Remplacement
  const repD = state.revenusRemplacement.declarant;
  const repC = state.revenusRemplacement.conjoint;
  if (repD.chomage > 0) add('1AP', 'Allocations chômage — Vous', repD.chomage, '2042 p.1', 'Relevé Pôle Emploi');
  if (repC.chomage > 0) add('1BP', 'Allocations chômage — Conjoint', repC.chomage, '2042 p.1', 'Relevé Pôle Emploi');
  if (repD.retraite > 0) add('1AS', 'Pensions de retraite — Vous', repD.retraite, '2042 p.1', 'Attestation de retraite');
  if (repC.retraite > 0) add('1BS', 'Pensions de retraite — Conjoint', repC.retraite, '2042 p.1', 'Attestation de retraite');
  if (repD.indemMaladie > 0) add('1AZ', 'Indemnités maladie/invalidité — Vous', repD.indemMaladie + repD.invalidite, '2042 p.1', 'Attestation CPAM');
  if (repC.indemMaladie > 0) add('1BZ', 'Indemnités maladie/invalidité — Conjoint', repC.indemMaladie + repC.invalidite, '2042 p.1', 'Attestation CPAM');
  if (repD.renteViagere > 0) add('1AW', 'Rente viagère — Vous', repD.renteViagere, '2042 p.1', 'Attestation crédirentier');
  if (repC.renteViagere > 0) add('1BW', 'Rente viagère — Conjoint', repC.renteViagere, '2042 p.1', 'Attestation crédirentier');

  // Indépendant
  const ind = state.revenusIndependant;
  if (ind.microEntreprise.actif) {
    const ca = ind.microEntreprise.chiffreAffaires;
    if (ind.microEntreprise.typeActivite === 'vente') add('5KO', 'Micro-BIC vente de marchandises', ca, '2042C', 'Livre de recettes auto-entrepreneur');
    if (ind.microEntreprise.typeActivite === 'services_bic') add('5KP', 'Micro-BIC prestations de services', ca, '2042C', 'Livre de recettes auto-entrepreneur');
    if (ind.microEntreprise.typeActivite === 'services_bnc') add('5HQ', 'Micro-BNC prestations de services', ca, '2042C', 'Livre de recettes auto-entrepreneur');
    if (ind.microEntreprise.versementLiberatoire) add('5KA', 'Versement libératoire — CA déjà imposé', ca, '2042C', 'Attestation URSSAF');
  }
  if (ind.reel.actif) {
    if (ind.reel.typeFiscal === 'bnc') add('5QC', 'BNC réel — Bénéfice', ind.reel.resultatNet, '2042C', 'Déclaration 2035');
    else add('5KC', 'BIC réel — Bénéfice', ind.reel.resultatNet, '2042C', 'Déclaration 2031');
  }
  if (ind.gerantSarl.actif) add('1GB', 'Rémunération gérance art. 62', ind.gerantSarl.remuneration, '2042 p.1', 'Bulletin de gérance');

  // Foncier
  const fc = calc.foncierCalc;
  if (state.revenusFonciers.regime === 'micro' && fc.resultatNet > 0) add('4BE', 'Revenus fonciers micro-foncier', state.revenusFonciers.microFoncierCA, '2042 p.3', 'Aucun justificatif requis (abattement forfaitaire 30%)');
  if (state.revenusFonciers.regime === 'reel') {
    if (fc.case4BA > 0) add('4BA', 'Revenus fonciers nets (régime réel)', fc.case4BA, '2042 p.3 + 2044', 'Voir déclaration 2044');
    if (fc.case4BC > 0) add('4BC', 'Déficit foncier imputable sur revenu global', fc.case4BC, '2042 p.3', 'Voir déclaration 2044');
    if (fc.case4BD > 0) add('4BD', 'Déficit foncier reportable (10 ans)', fc.case4BD, '2042 p.3', 'Voir déclaration 2044');
  }

  // LMNP
  if (state.modules.locationMeublee) {
    if (state.revenusLMNP.regime === 'micro') add('5ND', 'Location meublée — Micro-BIC', state.revenusLMNP.recettes, '2042C', 'Aucun justificatif requis (abattement 50%)');
    if (state.revenusLMNP.regime === 'reel') {
      const benefLMNP = Math.max(0, state.revenusLMNP.recettes - Object.values(state.revenusLMNP.charges).reduce((a, b) => a + b, 0));
      if (benefLMNP > 0) add('5NA', 'LMNP régime réel — Bénéfice', benefLMNP, '2042C', 'Liasse 2031-SD + expert-comptable');
    }
  }

  // Patrimoine financier
  const pat = state.revenusPatrimoine;
  if (pat.interets > 0) add('2TR', 'Intérêts et produits de placement', pat.interets, '2042 p.2', 'IFU banque');
  if (pat.dividendes > 0) add('2DC', 'Dividendes bruts', pat.dividendes, '2042 p.2', 'IFU banque / courtier');
  if (pat.optionBarem) add('2OP', 'Option barème progressif (dividendes)', 1, '2042 p.2', 'Case à cocher — pas de montant');
  if (pat.avoirFiscal > 0) add('2AB', 'Crédit impôt étranger', pat.avoirFiscal, '2042 p.2', 'IFU courtier');
  if (pat.csgDeductible > 0) add('2BH', 'CSG déductible (pré-remplie)', pat.csgDeductible, '2042 p.2', 'Pré-remplie par l\'administration');
  if (pat.plusValuesMobilieres > 0) add('3VG', 'Plus-values de cession valeurs mobilières', pat.plusValuesMobilieres, '2042 p.3', 'IFU courtier');
  if (pat.moinsValuesMobilieres > 0) add('3VH', 'Moins-values imputables', pat.moinsValuesMobilieres, '2042 p.3', 'IFU courtier');

  // Charges déductibles
  const ch = state.chargesDeductibles;
  if (ch.pensionEnfantMajeur > 0 || ch.pensionParents > 0) add('6EL', 'Pensions alimentaires (enfant majeur / parents)', ch.pensionEnfantMajeur + ch.pensionParents, '2042 p.4', 'Justificatifs de paiement ou forfaits officiels');
  if (ch.pensionExConjoint > 0) add('6GU', 'Pension versée à l\'ex-conjoint', ch.pensionExConjoint, '2042 p.4', 'Décision judiciaire + justificatifs paiement');
  const epargneRetraite = ch.versementsPER + ch.versementsPERP + ch.versementsMadelin;
  if (epargneRetraite > 0) add('6NS', 'Versements PER / PERP / Madelin', epargneRetraite, '2042 p.4', 'Attestation organisme assureur');

  // Réductions / crédits
  const red = state.reductionsCreditImpot;
  if (red.donsAssociations > 0) add('7UF', 'Dons associations intérêt général', red.donsAssociations, '2042 RICI', 'Reçu fiscal association');
  if (red.donsUrgence > 0) add('7UD', 'Dons associations aide aux personnes', red.donsUrgence, '2042 RICI', 'Reçu fiscal association');
  if (red.donsPartis > 0) add('7UH', 'Dons partis politiques', red.donsPartis, '2042 RICI', 'Reçu fiscal');
  if (red.emploiDomicile > 0) add('7DB', 'Emploi à domicile (dépenses totales)', red.emploiDomicile, '2042 RICI', 'Attestation URSSAF ou relevé CESU');
  if (red.gardeEnfant1 > 0) add('7GA', 'Garde enfant < 6 ans hors domicile — 1er', red.gardeEnfant1, '2042 RICI', 'Attestation CAF / PAJE / établissement');
  if (red.gardeEnfant2 > 0) add('7GB', 'Garde enfant < 6 ans hors domicile — 2e', red.gardeEnfant2, '2042 RICI', 'Attestation CAF / PAJE / établissement');
  if (red.gardeEnfant3 > 0) add('7GC', 'Garde enfant < 6 ans hors domicile — 3e', red.gardeEnfant3, '2042 RICI', 'Attestation CAF / PAJE / établissement');
  if (red.enfantsCollege > 0) add('7EA', 'Enfant(s) au collège', red.enfantsCollege, '2042 RICI', 'Aucun justificatif requis');
  if (red.enfantsLycee > 0) add('7EC', 'Enfant(s) au lycée', red.enfantsLycee, '2042 RICI', 'Aucun justificatif requis');
  if (red.enfantsSup > 0) add('7EF', 'Enfant(s) dans le supérieur', red.enfantsSup, '2042 RICI', 'Aucun justificatif requis');
  if (red.investPinel > 0) add('7QA', 'Investissement Pinel', red.investPinel, '2042 RICI', 'Attestation gestionnaire patrimoine');
  if (red.investPME > 0) add('7CF', 'Souscription capital PME', red.investPME, '2042 RICI', 'Attestation PME');
  if (red.cotisationsSyndicales > 0) add('7AC', 'Cotisations syndicales', red.cotisationsSyndicales, '2042 RICI', 'Attestation syndicale');

  return cases;
}

// ── Plafond PER ─────────────────────────────────────────────
export function calculerPlafondPER(state: TaxState): number {
  const salD = state.revenusSalariaux.declarant.salaires;
  const salC = state.revenusSalariaux.conjoint.salaires;
  return Math.max(Math.min((salD + salC) * 0.10, 35816), 4478);
}
