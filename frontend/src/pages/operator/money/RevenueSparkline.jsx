import React, { useMemo } from 'react';
import { fmt } from './format';

/** Tiny inline 30-day revenue bar chart (no external chart lib needed). */
export function RevenueSparkline({ series }) {
  const max = useMemo(() => Math.max(1, ...series.map((s) => s.revenue)), [series]);
  return (
    <section>
      <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-tbc-200/60">
        Revenue · last 30 days
      </h4>
      <div className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-4" data-testid="money-sparkline">
        <div className="flex h-32 items-end gap-1">
          {series.map((s) => {
            const pct = (s.revenue / max) * 100;
            return (
              <div
                key={s.date}
                className="group relative flex flex-1 flex-col items-center justify-end"
                title={`${s.date} · ${fmt(s.revenue)}`}
              >
                <div
                  className="w-full rounded-t bg-gradient-to-t from-tbc-700/60 to-tbc-400 transition-all"
                  style={{ height: `${Math.max(2, pct)}%` }}
                />
                <div className="pointer-events-none absolute -top-7 whitespace-nowrap rounded bg-ink-950 px-1.5 py-0.5 text-[10px] text-tbc-100 opacity-0 transition group-hover:opacity-100">
                  {fmt(s.revenue)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-tbc-200/50">
          <span>{series[0]?.date}</span>
          <span>{series[series.length - 1]?.date}</span>
        </div>
      </div>
    </section>
  );
}
