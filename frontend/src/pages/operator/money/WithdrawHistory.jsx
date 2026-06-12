import React from 'react';

const kindClass = (k) =>
  k === 'auto'
    ? 'border-violet-500/30 bg-violet-500/10 text-violet-300'
    : 'border-sky-500/30 bg-sky-500/10 text-sky-300';

const statusClass = (s) =>
  s === 'success'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : s === 'failed'
      ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-300';

/** Withdrawal history table — paged into the same Money tab section. */
export function WithdrawHistory({ history }) {
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-tbc-900/60 bg-ink-900/60">
      <div className="border-b border-tbc-900/40 bg-ink-950/60 px-4 py-2 text-[10px] uppercase tracking-wider text-tbc-200/50">
        Withdrawal history
      </div>
      <table className="w-full text-sm" data-testid="withdraw-history-table">
        <thead className="text-[10px] uppercase tracking-wider text-tbc-200/50">
          <tr>
            <th className="px-4 py-2 text-left">When</th>
            <th className="px-4 py-2 text-left">Provider</th>
            <th className="px-4 py-2 text-left">Kind</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-right">Amount</th>
            <th className="px-4 py-2 text-left">Detail</th>
          </tr>
        </thead>
        <tbody>
          {history.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-tbc-200/50">
              No withdrawals yet
            </td></tr>
          )}
          {history.map((w) => (
            <tr key={w.id} className="border-t border-tbc-900/40">
              <td className="px-4 py-2 text-xs text-tbc-200/70">{new Date(w.created_at).toLocaleString()}</td>
              <td className="px-4 py-2 capitalize text-tbc-100">{w.provider}</td>
              <td className="px-4 py-2 text-xs">
                <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase ${kindClass(w.kind)}`}>
                  {w.kind}
                </span>
              </td>
              <td className="px-4 py-2 text-xs">
                <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase ${statusClass(w.status)}`}>
                  {w.status}
                </span>
              </td>
              <td className="px-4 py-2 text-right font-semibold text-tbc-100">
                ${Number(w.amount_usd || 0).toFixed(2)}
              </td>
              <td className="px-4 py-2 text-[11px] text-tbc-200/70">{w.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
