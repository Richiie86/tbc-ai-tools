import React from 'react';
import { STAGES } from './stages';

/**
 * The 5-tile sub-nav at the top of the Projects tab.
 * Counts come from the parent so the parent stays the single source of truth.
 */
export function ProjectStageNav({ active, counts, onSelect }) {
  return (
    <div
      className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-5"
      data-testid="projects-subnav"
    >
      {STAGES.map((s) => {
        const isActive = active === s.v;
        return (
          <button
            key={s.v}
            data-testid={`projects-stage-${s.v}`}
            onClick={() => onSelect(s.v)}
            className={[
              'group relative overflow-hidden rounded-xl border p-3 text-left transition',
              isActive
                ? 'border-tbc-500/40 bg-ink-900 shadow-[0_0_0_1px_rgba(212,169,58,0.25)]'
                : 'border-tbc-900/60 bg-ink-900/50 hover:border-tbc-700/60 hover:bg-ink-900/80',
            ].join(' ')}
          >
            <div className="flex items-center justify-between">
              <span className={`grid h-8 w-8 place-items-center rounded-lg ${s.tile}`}>
                <s.Icon className="h-4 w-4" />
              </span>
              <span className="text-2xl font-extrabold tracking-tight text-tbc-100">
                {counts[s.v]}
              </span>
            </div>
            <div className={`mt-2 text-[11px] font-bold uppercase tracking-wider ${s.accent}`}>
              {s.short}
            </div>
            <div className="text-[13px] font-medium text-tbc-100 leading-tight">{s.label}</div>
          </button>
        );
      })}
    </div>
  );
}
