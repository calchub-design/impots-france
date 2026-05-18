'use client';

interface Step {
  id: number;
  title: string;
  active: boolean;
}

interface Props {
  steps: Step[];
  currentStep: number;
  onStepClick: (id: number) => void;
}

export function ProgressBar({ steps, currentStep, onStepClick }: Props) {
  const visibleSteps = steps.filter(s => s.active);
  const currentIndex = visibleSteps.findIndex(s => s.id === currentStep);
  const progress = visibleSteps.length > 1 ? (currentIndex / (visibleSteps.length - 1)) * 100 : 0;

  return (
    <div className="mb-8">
      {/* Barre de progression */}
      <div className="relative mb-4">
        <div className="h-2 bg-gray-200 rounded-full">
          <div
            className="h-2 bg-blue-600 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      {/* Étapes — scroll horizontal sur mobile */}
      <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-hide">
        {visibleSteps.map((step, idx) => {
          const isDone = idx < currentIndex;
          const isCurrent = step.id === currentStep;
          return (
            <button
              key={step.id}
              onClick={() => onStepClick(step.id)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all
                ${isCurrent ? 'bg-blue-600 text-white shadow-md' : ''}
                ${isDone ? 'bg-blue-100 text-blue-700 hover:bg-blue-200' : ''}
                ${!isCurrent && !isDone ? 'bg-gray-100 text-gray-500 hover:bg-gray-200' : ''}
              `}
            >
              {idx + 1}. {step.title}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-gray-500 mt-2 text-right">
        Étape {currentIndex + 1} / {visibleSteps.length}
      </p>
    </div>
  );
}
