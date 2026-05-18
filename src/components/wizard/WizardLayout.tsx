'use client';
import { useReducer, useEffect, useCallback, useState } from 'react';
import { taxReducer, TaxAction } from '@/lib/taxReducer';
import { initialState } from '@/lib/taxState';
import { TaxState } from '@/lib/types';
import { ProgressBar } from './ProgressBar';
import { SidePanel } from './SidePanel';
import { StepNavigation } from './StepNavigation';
import { Module0Profile } from '@/components/modules/Module0Profile';
import { Module1Situation } from '@/components/modules/Module1Situation';
import { Module2Salaires } from '@/components/modules/Module2Salaires';
import { Module3Remplacement } from '@/components/modules/Module3Remplacement';
import { Module4Independant } from '@/components/modules/Module4Independant';
import { Module5Foncier } from '@/components/modules/Module5Foncier';
import { Module6LMNP } from '@/components/modules/Module6LMNP';
import { Module7SCI } from '@/components/modules/Module7SCI';
import { Module8Patrimoine } from '@/components/modules/Module8Patrimoine';
import { Module9Charges } from '@/components/modules/Module9Charges';
import { Module10Reductions } from '@/components/modules/Module10Reductions';
import { Module11IFI } from '@/components/modules/Module11IFI';
import { Module12Summary } from '@/components/modules/Module12Summary';
import { RotateCcw, Save } from 'lucide-react';

const STORAGE_KEY = 'impots-fr-2025-state';

interface WizardStep {
  id: number;
  title: string;
  shortTitle: string;
  alwaysVisible: boolean;
  moduleKey?: keyof TaxState['modules'];
}

const STEPS: WizardStep[] = [
  { id: 0, title: 'Votre profil', shortTitle: 'Profil', alwaysVisible: true },
  { id: 1, title: 'Situation personnelle', shortTitle: 'Situation', alwaysVisible: true },
  { id: 2, title: 'Revenus salariaux', shortTitle: 'Salaires', alwaysVisible: false, moduleKey: 'salaires' },
  { id: 3, title: 'Retraites & allocations', shortTitle: 'Retraites', alwaysVisible: false, moduleKey: 'retraite' },
  { id: 4, title: 'Activité indépendante', shortTitle: 'Indépendant', alwaysVisible: false, moduleKey: 'independant' },
  { id: 5, title: 'Location nue', shortTitle: 'Foncier', alwaysVisible: false, moduleKey: 'locationNue' },
  { id: 6, title: 'Location meublée', shortTitle: 'LMNP', alwaysVisible: false, moduleKey: 'locationMeublee' },
  { id: 7, title: 'SCI à l\'IR', shortTitle: 'SCI', alwaysVisible: false, moduleKey: 'sci' },
  { id: 8, title: 'Patrimoine financier', shortTitle: 'Patrimoine', alwaysVisible: false, moduleKey: 'patrimoinefinancier' },
  { id: 9, title: 'Charges déductibles', shortTitle: 'Charges', alwaysVisible: false, moduleKey: 'chargesDeductibles' },
  { id: 10, title: 'Réductions & crédits', shortTitle: 'Réductions', alwaysVisible: false, moduleKey: 'chargesDeductibles' },
  { id: 11, title: 'IFI', shortTitle: 'IFI', alwaysVisible: true },
  { id: 12, title: 'Récapitulatif', shortTitle: 'Récap', alwaysVisible: true },
];

function isStepActive(step: WizardStep, modules: TaxState['modules']): boolean {
  if (step.alwaysVisible) return true;
  if (!step.moduleKey) return true;
  return modules[step.moduleKey];
}

export function WizardLayout() {
  const [state, dispatch] = useReducer(taxReducer, initialState);
  const [saved, setSaved] = useState(false);
  const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);

  // Chargement initial depuis localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        dispatch({ type: 'LOAD', payload: parsed });
      }
    } catch (e) {
      // Ignore erreurs de parsing
    }
  }, []);

  // Sauvegarde automatique
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setSaved(true);
      const timer = setTimeout(() => setSaved(false), 2000);
      return () => clearTimeout(timer);
    } catch (e) {
      // Ignore
    }
  }, [state]);

  const activeSteps = STEPS.filter(s => isStepActive(s, state.modules));
  const currentStepIndex = activeSteps.findIndex(s => s.id === state.currentStep);
  const currentStepData = activeSteps[currentStepIndex];

  const goToStep = useCallback((stepId: number) => {
    dispatch({ type: 'SET_STEP', payload: stepId });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const goNext = useCallback(() => {
    if (currentStepIndex < activeSteps.length - 1) {
      goToStep(activeSteps[currentStepIndex + 1].id);
    }
  }, [currentStepIndex, activeSteps, goToStep]);

  const goBack = useCallback(() => {
    if (currentStepIndex > 0) {
      goToStep(activeSteps[currentStepIndex - 1].id);
    }
  }, [currentStepIndex, activeSteps, goToStep]);

  const handleGeneratePDF = async () => {
    setIsGeneratingPDF(true);
    try {
      const { generateTaxPDF } = await import('@/lib/pdfGenerator');
      await generateTaxPDF(state);
    } catch (e) {
      alert('Erreur lors de la génération du PDF. Réessayez.');
    } finally {
      setIsGeneratingPDF(false);
    }
  };

  const handleReset = () => {
    dispatch({ type: 'RESET' });
    localStorage.removeItem(STORAGE_KEY);
    setShowReset(false);
    goToStep(0);
  };

  const renderCurrentModule = () => {
    const p = { state, dispatch };
    switch (state.currentStep) {
      case 0: return <Module0Profile {...p} />;
      case 1: return <Module1Situation {...p} />;
      case 2: return <Module2Salaires {...p} />;
      case 3: return <Module3Remplacement {...p} />;
      case 4: return <Module4Independant {...p} />;
      case 5: return <Module5Foncier {...p} />;
      case 6: return <Module6LMNP {...p} />;
      case 7: return <Module7SCI {...p} />;
      case 8: return <Module8Patrimoine {...p} />;
      case 9: return <Module9Charges {...p} />;
      case 10: return <Module10Reductions {...p} />;
      case 11: return <Module11IFI {...p} />;
      case 12: return <Module12Summary state={state} onGeneratePDF={handleGeneratePDF} />;
      default: return <Module0Profile {...p} />;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
      {/* Header */}
      <header className="bg-blue-900 text-white shadow-lg sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🇫🇷</span>
            <div>
              <h1 className="font-bold text-base leading-tight">Aide Déclaration d'Impôts {state.anneeDeclaration ?? 2026}</h1>
              <p className="text-blue-300 text-xs">Revenus {(state.anneeDeclaration ?? 2026) - 1} — Données 100% locales</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {saved && (
              <span className="flex items-center gap-1 text-green-300 text-xs">
                <Save size={12} />
                Sauvegardé
              </span>
            )}
            {/* Bouton panel mobile */}
            <button
              onClick={() => setSidePanelOpen(!sidePanelOpen)}
              className="lg:hidden bg-blue-700 hover:bg-blue-600 px-3 py-1.5 rounded-lg text-xs font-medium"
            >
              Estimation
            </button>
            <button
              onClick={() => setShowReset(true)}
              className="flex items-center gap-1 bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            >
              <RotateCcw size={12} />
              Recommencer
            </button>
          </div>
        </div>
      </header>

      {/* Bannière stockage local */}
      <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 text-xs text-blue-700 text-center">
        Vos données sont enregistrées localement dans votre navigateur — elles disparaissent si vous videz votre navigateur.
        Zéro donnée envoyée à un serveur.
      </div>

      {/* Panel mobile estimation */}
      {sidePanelOpen && (
        <div className="lg:hidden bg-white border-b border-blue-200 p-4">
          <SidePanel state={state} />
        </div>
      )}

      {/* Layout principal */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">

          {/* Zone principale */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 md:p-8">
            <ProgressBar
              steps={activeSteps.map(s => ({ id: s.id, title: s.shortTitle, active: true }))}
              currentStep={state.currentStep}
              onStepClick={goToStep}
            />

            <div className="min-h-[400px]">
              {renderCurrentModule()}
            </div>

            <StepNavigation
              canGoBack={currentStepIndex > 0}
              canGoForward={currentStepIndex < activeSteps.length - 1}
              isLast={state.currentStep === 12}
              onBack={goBack}
              onNext={goNext}
              onFinish={handleGeneratePDF}
            />
          </div>

          {/* Panneau latéral (desktop uniquement) */}
          <div className="hidden lg:block">
            <SidePanel state={state} />

            {/* Info PDF */}
            <div className="mt-4 bg-white rounded-2xl border border-gray-200 p-4 text-sm text-gray-600 shadow-sm">
              <p className="font-medium text-gray-800 mb-2 flex items-center gap-2">
                <span>📄</span> PDF récapitulatif
              </p>
              <p className="text-xs mb-3">À la fin du parcours, téléchargez un document PDF avec toutes vos cases, montants et justificatifs.</p>
              {state.currentStep === 12 && (
                <button
                  onClick={handleGeneratePDF}
                  disabled={isGeneratingPDF}
                  className="w-full bg-green-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
                >
                  {isGeneratingPDF ? 'Génération...' : 'Générer le PDF'}
                </button>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Modal confirmation reset */}
      {showReset && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <h3 className="font-bold text-gray-900 text-lg mb-2">Recommencer ?</h3>
            <p className="text-gray-600 text-sm mb-5">Toutes vos saisies seront effacées définitivement. Cette action est irréversible.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowReset(false)}
                className="flex-1 border-2 border-gray-300 text-gray-700 py-2 rounded-xl font-medium hover:bg-gray-50 transition-colors"
              >
                Annuler
              </button>
              <button
                onClick={handleReset}
                className="flex-1 bg-red-600 text-white py-2 rounded-xl font-medium hover:bg-red-700 transition-colors"
              >
                Effacer tout
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Overlay PDF */}
      {isGeneratingPDF && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-8 text-center shadow-xl">
            <div className="text-4xl mb-4 animate-bounce">📄</div>
            <p className="font-semibold text-gray-800">Génération du PDF...</p>
            <p className="text-sm text-gray-500 mt-1">Quelques secondes</p>
          </div>
        </div>
      )}
    </div>
  );
}
