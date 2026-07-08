import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { CheckCircle2, XCircle, Loader2, HeartPulse, ChevronRight } from 'lucide-react';

/**
 * PlatformHealthStrip — an always-visible, compact readout of the four pillars
 * the platform needs to build, edit, and deploy on its own:
 *   GitHub token · AI provider · Vercel token · Vercel team scope
 *
 * It hits the SAME read-only endpoint as the full diagnostics panel
 * (/operator/diagnostics/preflight) so there's a single source of truth — this
 * strip is just the glanceable summary that lives at the top of the console.
 * Clicking it deep-links to the Domains tab where the full panel (with the
 * one-line fixes) lives.
 *
 * Purely additive + fail-soft: any error just hides the strip.
 */
const CRITICAL = ['GitHub token', 'AI provider', 'Vercel token', 'Vercel team scope'];

export default function PlatformHealthStrip({ onOpenDetails }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/diagnostics/preflight');
      setReport(data);
    } catch {
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (loading) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-xl border border-tbc-900/60 bg-ink-900 px-4 py-3 text-sm text-tbc-200/60">
        <Loader2 className="h-4 w-4 animate-spin text-tbc-400" />
        Checking platform health…
      </div>
    );
  }
  if (!report) return null;

  const checks = report.checks || [];
  const pillars = CRITICAL
    .map((name) => checks.find((c) => c.name === name))
    .filter(Boolean);
  const ready = report.ready;

  return (
    <button
      type="button"
      onClick={() => onOpenDetails?.()}
      data-testid="platform-health-strip"
      className={`group mt-4 flex w-full flex-col gap-3 rounded-xl border px-4 py-3 text-left transition-colors sm:flex-row sm:items-center sm:justify-between ${
        ready
          ? 'border-emerald-500/40 bg-emerald-500/[0.07] hover:bg-emerald-500/[0.12]'
          : 'border-amber-500/40 bg-amber-500/[0.07] hover:bg-amber-500/[0.12]'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
            ready ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
          }`}
        >
          <HeartPulse className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${ready ? 'text-emerald-100' : 'text-amber-100'}`}>
            {ready ? 'Platform ready — build, edit & deploy on your own' : 'Platform needs attention'}
          </p>
          <p className="truncate text-xs text-tbc-200/60">{report.summary}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {pillars.map((c) => (
          <span
            key={c.name}
            title={c.ok ? c.detail : `${c.detail} — Fix: ${c.fix}`}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              c.ok
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
            }`}
          >
            {c.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
            {c.name.replace('Vercel ', 'Vercel\u00A0')}
          </span>
        ))}
        <ChevronRight className="h-4 w-4 text-tbc-200/40 transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}
