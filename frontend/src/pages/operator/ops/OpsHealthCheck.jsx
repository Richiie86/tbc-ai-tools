import React from 'react';
import { Button } from '../../../components/ui/button';
import {
  Activity, RefreshCw, Loader2, CheckCircle2, AlertCircle,
} from 'lucide-react';

const SEV = (ok) => ok
  ? { dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'border-emerald-500/30 bg-emerald-500/5' }
  : { dot: 'bg-rose-400',    text: 'text-rose-300',    ring: 'border-rose-500/40 bg-rose-500/5' };

/** Full health-check section: header + status pill + per-check tiles. */
export function OpsHealthCheck({ health, loading, onRefresh }) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
            <Activity className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-bold text-tbc-100">Health Check</h3>
            <p className="text-xs text-tbc-200/60">Live status across MongoDB, services, environment, and disk.</p>
          </div>
        </div>
        <Button
          data-testid="ops-health-refresh"
          onClick={onRefresh}
          disabled={loading}
          variant="outline"
          className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
        >
          {loading
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            : <RefreshCw className="mr-2 h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {health && (
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
          <div className={`rounded-full border px-3 py-1 ${
            health.summary.failing === 0
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
          }`}>
            {health.summary.failing === 0
              ? '✓ All systems operational'
              : `${health.summary.failing} issue${health.summary.failing > 1 ? 's' : ''} detected`}
          </div>
          <div className="text-tbc-200/60">
            {health.summary.passing}/{health.summary.total} passing · checked {new Date(health.generated_at).toLocaleTimeString()}
          </div>
          <div className="text-tbc-200/40">commit · {health.commit}</div>
        </div>
      )}

      {loading && !health ? (
        <div className="grid place-items-center py-10"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="ops-health-grid">
          {(health?.checks || []).map((c) => {
            const s = SEV(c.ok);
            return (
              <div
                key={c.key}
                data-testid={`ops-check-${c.key}`}
                className={`flex items-start gap-3 rounded-lg border p-3 ${s.ring}`}
              >
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-sm font-semibold text-tbc-100">{c.label}</div>
                    {typeof c.latency_ms === 'number' && (
                      <span className="text-[10px] text-tbc-200/50">{c.latency_ms}ms</span>
                    )}
                  </div>
                  <div className={`mt-0.5 truncate text-xs ${s.text}`} title={c.detail}>
                    {c.detail || (c.ok ? 'OK' : 'failing')}
                  </div>
                </div>
                {c.ok
                  ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400/70" />
                  : <AlertCircle className="h-4 w-4 shrink-0 text-rose-400/80" />}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
