import React from 'react';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import api from '../../lib/api';

/**
 * Compact toolbar shown right under the stat-card grid. Three affordances:
 *   1. "Show JSON" — toggles a side panel rendering the raw stats payload
 *      so the operator can sanity-check what the dashboard is reading.
 *   2. "Self-fix" — POSTs to /api/operator/stats/self-fix which normalizes
 *      obvious data drift (users with no plan, payments with no status,
 *      sessions with no model) and returns the fresh stats. Parent
 *      `onRefresh()` is invoked on success so the on-screen numbers update.
 *   3. "Purge test data" — manually fires the same purge that runs on
 *      operator login. Erases chat sessions/messages for the seeded
 *      preview-user account so the stats reflect real customer activity.
 */
export function StatsToolbar({ stats, onRefresh }) {
  const [showJson, setShowJson] = React.useState(false);
  const [fixing, setFixing] = React.useState(false);
  const [purging, setPurging] = React.useState(false);
  const [lastFix, setLastFix] = React.useState(null);

  const selfFix = async () => {
    setFixing(true);
    try {
      const { data } = await api.post('/operator/stats/self-fix');
      setLastFix(data);
      const fixedTotal = Object.values(data?.fixed || {}).reduce((a, b) => a + b, 0);
      toast.success(
        fixedTotal > 0
          ? `Self-fix applied ${fixedTotal} normalization${fixedTotal === 1 ? '' : 's'}`
          : 'Stats already consistent — nothing to fix',
      );
      onRefresh?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Self-fix failed');
    } finally {
      setFixing(false);
    }
  };

  const purgeTestData = async () => {
    if (!window.confirm('Erase all chat sessions/messages belonging to the seeded preview-user?\n\nReal customer data is NOT affected. This also runs automatically on every operator login.')) {
      return;
    }
    setPurging(true);
    try {
      const { data } = await api.post('/operator/purge-test-data');
      const p = data?.purged || {};
      toast.success(`Purged ${p.sessions || 0} session${p.sessions === 1 ? '' : 's'} · ${p.messages || 0} message${p.messages === 1 ? '' : 's'}`);
      onRefresh?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Purge failed');
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-tbc-900/60 bg-ink-900/40">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <p className="text-[11px] text-tbc-200/60">
          Numbers don&apos;t look right? Open the raw JSON or run a normalization sweep.
        </p>
        <div className="flex gap-2">
          <button
            data-testid="stats-show-json"
            onClick={() => setShowJson((v) => !v)}
            className="rounded-md border border-tbc-900/60 bg-ink-900 px-2.5 py-1 text-[11px] text-tbc-100 hover:bg-ink-950"
          >
            {showJson ? 'Hide' : 'Show'} JSON
          </button>
          <button
            data-testid="stats-purge-test"
            onClick={purgeTestData}
            disabled={purging}
            className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-ink-900 px-2.5 py-1 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
            title="Erase chat sessions/messages from the seeded preview-user account. Also runs on every operator login."
          >
            <Trash2 className="h-3 w-3" />
            {purging ? 'Purging…' : 'Purge test data'}
          </button>
          <button
            data-testid="stats-self-fix"
            onClick={selfFix}
            disabled={fixing}
            className="rounded-md border border-tbc-500/40 bg-ink-900 px-2.5 py-1 text-[11px] font-semibold text-tbc-300 hover:bg-tbc-500/10 disabled:opacity-50"
            title="Normalize missing plan / payment_status / model fields and recompute stats."
          >
            {fixing ? 'Fixing…' : 'Self-fix'}
          </button>
        </div>
      </div>
      {showJson && (
        <div className="border-t border-tbc-900/60 bg-ink-950/80 p-3">
          <pre
            data-testid="stats-json-panel"
            className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-tbc-200"
          >
            {JSON.stringify(stats || {}, null, 2)}
          </pre>
          {lastFix && (
            <pre className="mt-2 rounded border border-emerald-500/30 bg-emerald-500/5 p-2 font-mono text-[10px] text-emerald-200">
              {'Last self-fix:\n'}{JSON.stringify(lastFix.fixed, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
