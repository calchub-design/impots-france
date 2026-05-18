'use client';

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
  tooltip?: string;
  suffix?: string;
  disabled?: boolean;
  highlight?: boolean;
}

import { InfoTooltip } from './InfoTooltip';

export function CurrencyInput({ label, value, onChange, tooltip, suffix = '€', disabled, highlight }: Props) {
  return (
    <div className={`flex flex-col gap-1 ${highlight ? 'bg-blue-50 rounded-lg p-2 -mx-2' : ''}`}>
      <label className="text-sm font-medium text-gray-700 flex items-center">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </label>
      <div className="relative">
        <input
          type="number"
          min="0"
          step="1"
          value={value === 0 ? '' : value}
          placeholder="0"
          disabled={disabled}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          className={`w-full border rounded-lg px-3 py-2 pr-8 text-right focus:outline-none focus:ring-2 focus:ring-blue-400 transition
            ${disabled ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-white text-gray-900'}
            ${highlight ? 'border-blue-400' : 'border-gray-300'}`}
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">{suffix}</span>
      </div>
    </div>
  );
}
