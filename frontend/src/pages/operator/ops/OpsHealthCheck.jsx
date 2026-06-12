import React from 'react';
import { Button } from '../../../components/ui/button';
import {
  Activity, RefreshCw, Loader2, CheckCircle2, AlertCircle, AlertTriangle,
} from 'lucide-react';

/** Tone lookup for the three health levels. Falls back to the legacy `ok`
 *  boolean so older payloads still render correctly during a rolling deploy. */
const TONE = {
  ok:   { dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'border-emerald-500/30 bg-emerald-500/5', Icon: CheckCircle2, iconClass: 'text-emerald-400/70' },
  warn: { dot: 'bg-amber-400',   text: 'text-amber-200',   ring: 'border-amber-500/40 bg-amber-500/5',     Icon: AlertTriangle, iconClass: 'text-amber-400/80' },
  fail: { dot: 'bg-rose-400',    text: 'text-rose-300',    ring: 'border-rose-500/40 bg-rose-500/5',       Icon: AlertCircle,   iconClass: 'text-rose-400/80' },
};

const levelOf = (c) => c.level || (c.ok ? 'ok' : 'fail');

/** Full health-check section: header + status pill + per-check tiles. */
export function OpsHealthCheck({ health, loading, onRefresh }) {
  const failing = health?.summary?.failing ?? 0;
  const warning = health?.summary?.warning ?? 0;
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
            failing > 0
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
              : warning > 0
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          }`}>
            {failing > 0
              ? `${failing} issue${failing > 1 ? 's' : ''} detected`
              : warning > 0
                ? `${warning} warning${warning > 1 ? 's' : ''} — operational`
                : '✓ All systems operational'}
          </div>
          <div className="text-tbc-200/60">
            {health.summary.passing}/{health.summary.total} passing
            {warning > 0 ? ` · ${warning} warn` : ''}
            {' · checked '}{new Date(health.generated_at).toLocaleTimeString()}
          </div>
          <div className="text-tbc-200/40">commit · {health.commit}</div>
        </div>
      )}

      {loading && !health ? (
        <div className="grid place-items-center py-10"><Loader2 className="h-6 w-6 animate-spin text-tbc-400" /></div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="ops-health-grid">
          {(health?.checks || []).map((c) => {
            const t = TONE[levelOf(c)] || TONE.fail;
            return (
              <div
                key={c.key}
                data-testid={`ops-check-${c.key}`}
                data-level={levelOf(c)}
                className={`flex items-start gap-3 rounded-lg border p-3 ${t.ring}`}
              >
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${t.dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-sm font-semibold text-tbc-100">{c.label}</div>
                    {typeof c.latency_ms === 'number' && (
                      <span className="text-[10px] text-tbc-200/50">{c.latency_ms}ms</span>
                    )}
                  </div>
                  <div className={`mt-0.5 truncate text-xs ${t.text}`} title={c.detail}>
                    {c.detail || (levelOf(c) === 'ok' ? 'OK' : levelOf(c) === 'warn' ? 'warning' : 'failing')}
                  </div>
                </div>
                <t.Icon className={`h-4 w-4 shrink-0 ${t.iconClass}`} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
