// Générateur PDF côté client uniquement
// Utilise @react-pdf/renderer

import { TaxState, CaseFiscale, TaxCalculation } from './types';
import { calculerImpot, genererCases, calculerFoncier } from './calculations';

function fmt(n: number) {
  return n.toLocaleString('fr-FR') + ' €';
}

export async function generateTaxPDF(state: TaxState): Promise<void> {
  // Import dynamique pour éviter les problèmes SSR
  const { pdf, Document, Page, Text, View, StyleSheet, Font } = await import('@react-pdf/renderer');

  const calc = calculerImpot(state);
  const cases = genererCases(state, calc);

  const styles = StyleSheet.create({
    page: { padding: 40, fontFamily: 'Helvetica', fontSize: 9, color: '#1e293b' },
    header: { marginBottom: 20, borderBottom: 2, borderBottomColor: '#1e3a8a', paddingBottom: 12 },
    title: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: '#1e3a8a', marginBottom: 4 },
    subtitle: { fontSize: 10, color: '#64748b' },
    disclaimer: { backgroundColor: '#fef2f2', borderLeft: 4, borderLeftColor: '#ef4444', padding: 8, marginBottom: 16, fontSize: 8, color: '#991b1b' },
    sectionTitle: { backgroundColor: '#1e3a8a', color: '#fff', padding: '6 8', fontSize: 10, fontFamily: 'Helvetica-Bold', marginBottom: 0, marginTop: 12 },
    subSectionTitle: { backgroundColor: '#dbeafe', color: '#1e3a8a', padding: '4 8', fontSize: 9, fontFamily: 'Helvetica-Bold', marginBottom: 0 },
    table: { marginBottom: 8 },
    tableRow: { flexDirection: 'row', borderBottom: 1, borderBottomColor: '#e2e8f0', paddingVertical: 4 },
    tableRowAlt: { flexDirection: 'row', borderBottom: 1, borderBottomColor: '#e2e8f0', paddingVertical: 4, backgroundColor: '#f8fafc' },
    codeCell: { width: 50, fontFamily: 'Helvetica-Bold', color: '#1d4ed8', fontSize: 9 },
    labelCell: { flex: 1, color: '#374151' },
    amountCell: { width: 80, textAlign: 'right', fontFamily: 'Helvetica-Bold' },
    justifCell: { width: 160, color: '#64748b', fontSize: 8 },
    calcRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, paddingHorizontal: 8 },
    calcRowBold: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, paddingHorizontal: 8, backgroundColor: '#eff6ff' },
    calcLabel: { flex: 1 },
    calcValue: { width: 100, textAlign: 'right', fontFamily: 'Helvetica-Bold' },
    totalRow: { flexDirection: 'row', justifyContent: 'space-between', padding: 10, backgroundColor: '#1e3a8a', marginTop: 4 },
    totalLabel: { flex: 1, color: '#fff', fontFamily: 'Helvetica-Bold', fontSize: 11 },
    totalValue: { width: 120, textAlign: 'right', color: '#fff', fontFamily: 'Helvetica-Bold', fontSize: 14 },
    justifSection: { marginTop: 16 },
    justifTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#166534', marginBottom: 6 },
    justifItem: { flexDirection: 'row', gap: 6, paddingVertical: 2 },
    justifCheck: { width: 12, color: '#16a34a', fontFamily: 'Helvetica-Bold' },
    justifText: { flex: 1 },
    twoCol: { flexDirection: 'row', gap: 16 },
    col: { flex: 1 },
    foncierBlock: { backgroundColor: '#eff6ff', padding: 10, marginTop: 8, borderLeft: 3, borderLeftColor: '#3b82f6' },
    foncierRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2, fontSize: 9 },
    foncierRowBold: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, borderTop: 1, borderTopColor: '#93c5fd', marginTop: 2 },
    pageNumber: { position: 'absolute', bottom: 20, right: 40, fontSize: 8, color: '#94a3b8' },
  });

  // Grouper cases par formulaire
  const byForm: Record<string, CaseFiscale[]> = {};
  cases.forEach(c => {
    if (!byForm[c.formulaire]) byForm[c.formulaire] = [];
    byForm[c.formulaire].push(c);
  });

  const foncierCalc = calculerFoncier(state);

  const doc = (
    <Document>
      {/* Page 1 — En-tête et tableau principal */}
      <Page size="A4" style={styles.page}>
        {/* En-tête */}
        <View style={styles.header}>
          <Text style={styles.title}>Aide à la déclaration de revenus 2025</Text>
          <Text style={styles.subtitle}>Revenus 2024 — Généré le {new Date().toLocaleDateString('fr-FR')}</Text>
        </View>

        {/* Disclaimer */}
        <View style={styles.disclaimer}>
          <Text>⚠️ AVERTISSEMENT LÉGAL — Ce document est une aide à la déclaration à titre informatif uniquement. Il ne constitue pas un conseil fiscal. Vérifiez toutes les informations sur impots.gouv.fr avant de soumettre votre déclaration. L'auteur décline toute responsabilité en cas d'erreur.</Text>
        </View>

        {/* Tableau des cases par formulaire */}
        <View style={styles.sectionTitle}>
          <Text>CASES À REPORTER DANS VOTRE DÉCLARATION</Text>
        </View>

        {Object.entries(byForm).map(([form, formCases]) => (
          <View key={form}>
            <View style={styles.subSectionTitle}>
              <Text>{form}</Text>
            </View>
            <View style={styles.table}>
              {formCases.map((c, i) => (
                <View key={c.code} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                  <Text style={styles.codeCell}>{c.code}</Text>
                  <Text style={styles.labelCell}>{c.libelle}</Text>
                  <Text style={styles.amountCell}>{fmt(c.montant)}</Text>
                  <Text style={styles.justifCell}>{c.justificatif}</Text>
                </View>
              ))}
            </View>
          </View>
        ))}

        {/* Détail foncier si régime réel */}
        {state.revenusFonciers.regime === 'reel' && foncierCalc.totalRecettes > 0 && (
          <View style={styles.foncierBlock}>
            <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 9, marginBottom: 6, color: '#1e3a8a' }}>
              DÉTAIL DÉCLARATION 2044 — REVENUS FONCIERS
            </Text>
            {[
              ['Loyers nus perçus', state.revenusFonciers.recettes.loyersNus],
              ['+ Charges récupérées locataire', state.revenusFonciers.recettes.chargesRecuperees],
              ['= Total recettes', foncierCalc.totalRecettes],
              ['- Charges copropriété nettes', Math.max(0, state.revenusFonciers.charges.chargesCopro - state.revenusFonciers.charges.chargesRecupereesSurLocataire)],
              ['- Intérêts d\'emprunt', state.revenusFonciers.charges.interetsEmprunt],
              ['- Assurance ADI', state.revenusFonciers.charges.assuranceADI],
              ['- Assurance PNO + GLI', state.revenusFonciers.charges.assurancePNO + state.revenusFonciers.charges.assuranceGLI],
              ['- Taxe foncière', state.revenusFonciers.charges.taxeFonciere],
              ['- Frais de gestion', state.revenusFonciers.charges.fraisGestionAgence + state.revenusFonciers.charges.fraisGestionDirectNbLocaux * 20],
              ['- Travaux', state.revenusFonciers.charges.travauxEntretien + state.revenusFonciers.charges.travauxAmelioration],
              ['= Total charges', foncierCalc.totalCharges],
            ].map(([label, val]) => (
              <View key={String(label)} style={styles.foncierRow}>
                <Text style={{ flex: 1 }}>{label}</Text>
                <Text style={{ width: 80, textAlign: 'right' }}>{fmt(Number(val))}</Text>
              </View>
            ))}
            <View style={styles.foncierRowBold}>
              <Text style={{ flex: 1, fontFamily: 'Helvetica-Bold' }}>Résultat net foncier</Text>
              <Text style={{ width: 80, textAlign: 'right', fontFamily: 'Helvetica-Bold' }}>{fmt(foncierCalc.resultatNet)}</Text>
            </View>
            {foncierCalc.case4BC > 0 && <Text style={{ fontSize: 8, color: '#b45309', marginTop: 3 }}>→ Case 4BC (imputable revenu global) : {fmt(foncierCalc.case4BC)}</Text>}
            {foncierCalc.case4BD > 0 && <Text style={{ fontSize: 8, color: '#b45309' }}>→ Case 4BD (reportable 10 ans) : {fmt(foncierCalc.case4BD)}</Text>}
          </View>
        )}

        <Text style={styles.pageNumber} render={({ pageNumber }) => `Page ${pageNumber}`} fixed />
      </Page>

      {/* Page 2 — Simulation impôt + justificatifs */}
      <Page size="A4" style={styles.page}>
        {/* Simulation */}
        <View style={styles.sectionTitle}>
          <Text>SIMULATION DE L'IMPÔT 2024 (ESTIMATION)</Text>
        </View>

        {[
          { label: 'Revenu brut global', value: calc.revenuBrutGlobal, bold: false },
          { label: '- Charges déductibles du revenu', value: -calc.chargesDeductiblesTotal, bold: false },
          { label: '= Revenu net global imposable', value: calc.revenuNetGlobal, bold: true },
          { label: `Nombre de parts fiscales : ${calc.nombreParts}`, value: null, bold: false },
          { label: `Quotient familial (${fmt(calc.quotientFamilial)}/part)`, value: null, bold: false },
          { label: 'Impôt brut après quotient familial', value: calc.impotApresQF, bold: false },
          ...(calc.decote > 0 ? [{ label: '- Décote', value: -calc.decote, bold: false }] : []),
          ...(calc.reductionsTotal > 0 ? [{ label: '- Réductions d\'impôt', value: -calc.reductionsTotal, bold: false }] : []),
          ...(calc.creditsTotal > 0 ? [{ label: '- Crédits d\'impôt', value: -calc.creditsTotal, bold: false }] : []),
          ...(calc.prelevementsSociaux > 0 ? [{ label: '+ Prélèvements sociaux (17,2%)', value: calc.prelevementsSociaux, bold: false }] : []),
        ].map((l, i) => l.value !== null ? (
          <View key={i} style={l.bold ? styles.calcRowBold : styles.calcRow}>
            <Text style={styles.calcLabel}>{l.label}</Text>
            <Text style={[styles.calcValue, { color: (l.value || 0) < 0 ? '#16a34a' : '#1e293b' }]}>{fmt(l.value || 0)}</Text>
          </View>
        ) : (
          <View key={i} style={styles.calcRow}>
            <Text style={{ ...styles.calcLabel, color: '#64748b', fontStyle: 'italic' }}>{l.label}</Text>
            <Text style={styles.calcValue}></Text>
          </View>
        ))}

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>IMPÔT NET ESTIMÉ</Text>
          <Text style={styles.totalValue}>{fmt(Math.max(0, calc.impotNet))}</Text>
        </View>

        <View style={{ backgroundColor: '#fef2f2', padding: 8, marginTop: 4, marginBottom: 16 }}>
          <Text style={{ fontSize: 8, color: '#991b1b' }}>
            ⚠️ Estimation indicative uniquement. L'administration fiscale peut recalculer votre impôt avec des données différentes. Vérifiez sur impots.gouv.fr avant validation.
          </Text>
        </View>

        {/* Justificatifs */}
        <View style={styles.sectionTitle}>
          <Text>JUSTIFICATIFS À CONSERVER (3 ANS MINIMUM) — NE PAS ENVOYER</Text>
        </View>

        <View style={styles.twoCol}>
          <View style={styles.col}>
            <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 9, color: '#166534', marginVertical: 6 }}>À CONSERVER EN CAS DE CONTRÔLE</Text>
            {[
              'Bulletins de salaire / AER employeur',
              'Tableau d\'amortissement du prêt',
              'Attestation fiscale annuelle banque',
              'Relevé annuel du syndic',
              'Avis de taxe foncière 2024',
              'Attestations assurance PNO et GLI',
              'Attestation assurance emprunt (ADI)',
              'Relevé de gérance agence (si applicable)',
              'Factures travaux artisans',
              'Relevé CESU / attestation URSSAF',
              'Reçus fiscaux associations',
              'IFU banque / courtier',
              'Attestation versements PER / PERP',
              'Attestation syndicale',
            ].map(j => (
              <View key={j} style={{ flexDirection: 'row', gap: 4, paddingVertical: 1.5 }}>
                <Text style={{ color: '#16a34a', width: 10 }}>□</Text>
                <Text style={{ flex: 1, fontSize: 8 }}>{j}</Text>
              </View>
            ))}
          </View>

          <View style={styles.col}>
            <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 9, color: '#1d4ed8', marginVertical: 6 }}>AUCUN JUSTIFICATIF REQUIS</Text>
            {[
              'Forfait frais gestion directe 20€/local',
              'Abattement micro-foncier 30%',
              'Abattement micro-BIC 50%',
              'Abattement micro-BIC 71% (vente)',
              'Abattement micro-BNC 34%',
              'Déduction scolaire (7EA, 7EC, 7EF)',
              'Frais professionnels forfait 10%',
              'Frais kilométriques (barème officiel)',
            ].map(j => (
              <View key={j} style={{ flexDirection: 'row', gap: 4, paddingVertical: 1.5 }}>
                <Text style={{ color: '#2563eb', width: 10 }}>✓</Text>
                <Text style={{ flex: 1, fontSize: 8 }}>{j}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Footer */}
        <View style={{ position: 'absolute', bottom: 30, left: 40, right: 40, borderTop: 1, borderTopColor: '#e2e8f0', paddingTop: 8 }}>
          <Text style={{ fontSize: 7, color: '#94a3b8', textAlign: 'center' }}>
            Généré par l'aide à la déclaration — outil indicatif sans valeur légale — Données stockées uniquement sur votre appareil
          </Text>
        </View>

        <Text style={styles.pageNumber} render={({ pageNumber }) => `Page ${pageNumber}`} fixed />
      </Page>
    </Document>
  );

  const blob = await pdf(doc).toBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `declaration-impots-2024-${new Date().toISOString().slice(0, 10)}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}
