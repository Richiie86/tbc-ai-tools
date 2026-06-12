import React from 'react';
import { fmt } from './format';

/** "Recent payments" table — last completed transactions. */
export function RecentTransactions({ transactions }) {
  return (
    <section>
      <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-tbc-200/60">Recent payments</h4>
      <div className="overflow-hidden rounded-xl border border-tbc-900/60 bg-ink-900/60">
        <table className="w-full text-sm" data-testid="money-recent-table">
          <thead className="bg-ink-950/60 text-[10px] uppercase tracking-wider text-tbc-200/50">
            <tr>
              <th className="px-4 py-2 text-left">When</th>
              <th className="px-4 py-2 text-left">Customer</th>
              <th className="px-4 py-2 text-left">Plan</th>
              <th className="px-4 py-2 text-left">Method</th>
              <th className="px-4 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-tbc-200/50">
                No completed payments yet
              </td></tr>
            )}
            {transactions.map((t) => (
              <tr key={t.id} className="border-t border-tbc-900/40">
                <td className="px-4 py-2 text-xs text-tbc-200/70">
                  {t.paid_at ? new Date(t.paid_at).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-2 text-tbc-100">{t.user_email}</td>
                <td className="px-4 py-2">
                  <span className="rounded bg-tbc-500/10 px-1.5 py-0.5 text-[10px] uppercase text-tbc-300">
                    {t.plan_id}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-tbc-200/70">{t.method}</td>
                <td className="px-4 py-2 text-right font-semibold text-emerald-300">
                  {fmt(t.amount, (t.currency || 'usd').toUpperCase())}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
