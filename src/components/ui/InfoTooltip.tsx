'use client';
import { useState } from 'react';
import { Info, X } from 'lucide-react';

interface Props {
  text: string;
}

export function InfoTooltip({ text }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center ml-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-blue-500 hover:text-blue-700 focus:outline-none"
        aria-label="Information"
      >
        <Info size={15} />
      </button>
      {open && (
        <div className="absolute z-50 left-6 top-0 w-72 bg-white border border-blue-200 rounded-lg shadow-lg p-3 text-sm text-gray-700">
          <button
            onClick={() => setOpen(false)}
            className="absolute top-1 right-1 text-gray-400 hover:text-gray-600"
          >
            <X size={12} />
          </button>
          {text}
        </div>
      )}
    </span>
  );
}
