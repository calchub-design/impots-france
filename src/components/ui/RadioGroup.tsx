'use client';

interface Option<T> {
  value: T;
  label: string;
  description?: string;
}

interface Props<T> {
  label?: string;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  tooltip?: string;
}

import { InfoTooltip } from './InfoTooltip';

export function RadioGroup<T extends string>({ label, value, options, onChange, tooltip }: Props<T>) {
  return (
    <div className="flex flex-col gap-2">
      {label && (
        <span className="text-sm font-medium text-gray-700 flex items-center">
          {label}
          {tooltip && <InfoTooltip text={tooltip} />}
        </span>
      )}
      <div className="flex flex-wrap gap-2">
        {options.map(opt => (
          <label
            key={String(opt.value)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg border-2 cursor-pointer transition-all text-sm
              ${value === opt.value
                ? 'border-blue-500 bg-blue-50 text-blue-800 font-medium'
                : 'border-gray-200 bg-white text-gray-700 hover:border-blue-300'
              }`}
          >
            <input
              type="radio"
              className="hidden"
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
            />
            {opt.label}
          </label>
        ))}
      </div>
    </div>
  );
}

export function CheckboxField({ label, checked, onChange, tooltip, disabled }: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  tooltip?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-3 cursor-pointer group ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all
        ${checked ? 'bg-blue-600 border-blue-600' : 'border-gray-300 bg-white group-hover:border-blue-400'}`}>
        {checked && (
          <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <input type="checkbox" className="hidden" checked={checked} onChange={e => !disabled && onChange(e.target.checked)} disabled={disabled} />
      <span className="text-sm text-gray-700 flex items-center">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </span>
    </label>
  );
}
