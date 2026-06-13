import React from 'react';

/**
 * Compact KPI card used at the top of the Operator console. When `onClick`
 * is provided the card renders as a button so the operator can jump to the
 * relevant tab (e.g. clicking "Total Messages" goes to Contacts). Without
 * it the card is a passive readout.
 */
export function StatCard({ icon: Icon, label, value, onClick, hint }) {
  const interactive = !!onClick;
  const Wrap = interactive ? 'button' : 'div';
  return (
    <Wrap
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      data-testid={interactive ? `stat-card-${label.toLowerCase().replace(/[^a-z]+/g, '-')}` : undefined}
      title={hint}
      className={`w-full text-left rounded-xl border border-tbc-900/60 bg-ink-900/80 p-5 transition ${
        interactive ? 'cursor-pointer hover:bg-ink-900 hover:border-tbc-500/60 hover:shadow-[0_0_18px_rgba(212,160,40,0.15)] focus:outline-none focus:ring-2 focus:ring-tbc-500/40' : ''
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-tbc-200/60">{label}</div>
          <div className="mt-1 text-2xl font-bold text-tbc-100">{value}</div>
          {hint && interactive && (
            <div className="mt-1 text-[10px] text-tbc-200/50">{hint}</div>
          )}
        </div>
        <div className="grid h-10 w-10 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Wrap>
  );
}
