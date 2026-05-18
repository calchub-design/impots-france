import { ReactNode } from 'react';

interface Props {
  title: string;
  icon?: string;
  children: ReactNode;
  variant?: 'default' | 'warning' | 'info' | 'success';
}

const variants = {
  default: 'border-gray-200 bg-white',
  warning: 'border-amber-300 bg-amber-50',
  info: 'border-blue-300 bg-blue-50',
  success: 'border-green-300 bg-green-50',
};

export function SectionCard({ title, icon, children, variant = 'default' }: Props) {
  return (
    <div className={`rounded-xl border-2 p-5 mb-4 ${variants[variant]}`}>
      <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2 text-base">
        {icon && <span>{icon}</span>}
        {title}
      </h3>
      {children}
    </div>
  );
}

export function AlertBox({ children, variant = 'warning' }: { children: ReactNode; variant?: 'warning' | 'info' | 'success' }) {
  const styles = {
    warning: 'bg-amber-50 border-amber-400 text-amber-800',
    info: 'bg-blue-50 border-blue-400 text-blue-800',
    success: 'bg-green-50 border-green-400 text-green-800',
  };
  return (
    <div className={`border-l-4 rounded-r-lg p-3 mb-3 text-sm ${styles[variant]}`}>
      {children}
    </div>
  );
}
