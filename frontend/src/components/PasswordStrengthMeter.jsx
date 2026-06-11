import React from 'react';
import { evaluatePassword } from '../lib/passwordStrength';

const BAR_COLORS = ['bg-rose-500', 'bg-rose-400', 'bg-amber-400', 'bg-tbc-400', 'bg-emerald-400'];

export default function PasswordStrengthMeter({ password, className = '' }) {
  const ev = evaluatePassword(password || '');
  return (
    <div data-testid="password-strength" className={'mt-2 ' + className}>
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={`bar-${i}`}
            className={`h-1 flex-1 rounded-full ${i < ev.score ? BAR_COLORS[ev.score - 1] : 'bg-slate-800'}`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px]">
        <span className={ev.meetsMinimum ? 'text-tbc-300' : 'text-slate-500'} data-testid="password-strength-label">
          {password ? ev.label : ' '}
        </span>
        <span className="text-slate-500" data-testid="password-strength-hint">
          {password ? ev.hint : ''}
        </span>
      </div>
    </div>
  );
}
