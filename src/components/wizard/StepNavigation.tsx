'use client';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Props {
  canGoBack: boolean;
  canGoForward: boolean;
  isLast: boolean;
  onBack: () => void;
  onNext: () => void;
  onFinish: () => void;
}

export function StepNavigation({ canGoBack, canGoForward, isLast, onBack, onNext, onFinish }: Props) {
  return (
    <div className="flex justify-between items-center mt-8 pt-6 border-t border-gray-200">
      <button
        onClick={onBack}
        disabled={!canGoBack}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl border-2 border-gray-300 text-gray-700 font-medium hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        <ChevronLeft size={18} />
        Précédent
      </button>
      {isLast ? (
        <button
          onClick={onFinish}
          className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-green-600 text-white font-semibold hover:bg-green-700 shadow-md transition-all"
        >
          Générer le PDF
          <span className="text-lg">📄</span>
        </button>
      ) : (
        <button
          onClick={onNext}
          disabled={!canGoForward}
          className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-700 shadow-md disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          Suivant
          <ChevronRight size={18} />
        </button>
      )}
    </div>
  );
}
