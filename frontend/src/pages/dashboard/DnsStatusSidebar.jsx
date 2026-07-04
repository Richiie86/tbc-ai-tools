import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Globe, CheckCircle2, AlertCircle } from 'lucide-react';
import api from '../../lib/api';

/**
 * DnsStatusSidebar — a right-hand rail (desktop only) that shows, at a glance,
 * whether each launched custom domain is actually live on Vercel.
 *
 * Each domain gets a red/green dot sourced from Vercel's authoritative domain
 * config (`misconfigured=false` ⇒ green/ready). A header roll-up tells the
 * operator whether EVERYTHING is ready. Polls every 20s and on window focus so
 * it reflects DNS propagation without a manual refresh.
 *
 * Renders nothing until we have at least one launched domain, so operators who
 * haven't pointed a domain yet don't see an empty rail.
 */
export default function DnsStatusSidebar() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/deploy/dns-status');
      setData(data);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  // Hide the whole rail until there's at least one launched domain to report.
  const domains = data?.domains || [];
  if (!loading && domains.length === 0) return null;

  const allReady = !!data?.ready && domains.length > 0;

  return (
    <aside className="hidden xl:flex w-72 shrink-0 flex-col border-l border-white/10 bg-ink-950/60">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-tbc-300" aria-hidden />
          <h2 className="text-sm font-semibold text-slate-100">DNS status</h2>
        </div>
        <button
          onClick={load}
          className="rounded-md p-1 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
          title="Refresh DNS status"
          aria-label="Refresh DNS status"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </header>

      {/* Overall roll-up */}
      <div className="px-4 py-3">
        <div
          className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium ${
            allReady
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
          }`}
        >
          {allReady ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          )}
          <span>
            {allReady
              ? 'All domains live'
              : `${data?.ready_count ?? 0} of ${data?.total ?? domains.length} ready`}
          </span>
        </div>
      </div>

      {/* Per-domain list */}
      <ul className="flex-1 space-y-1 overflow-y-auto px-2 pb-4">
        {domains.map((d) => (
          <li
            key={d.project_id + d.domain}
            className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-white/5"
          >
            <span
              className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                d.ready
                  ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]'
                  : d.checked
                    ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]'
                    : 'bg-slate-500'
              }`}
              title={d.ready ? 'DNS ready' : d.checked ? 'DNS not ready' : 'Status unknown'}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-100" title={d.domain}>
                {d.domain}
              </p>
              <p className="truncate text-xs text-slate-400" title={d.projectName}>
                {d.ready ? 'Live' : d.checked ? 'Waiting for DNS' : 'Checking…'}
              </p>
            </div>
            <span className="sr-only">
              {d.domain} is {d.ready ? 'ready' : 'not ready'}
            </span>
          </li>
        ))}
      </ul>

      {error && (
        <p className="px-4 pb-3 text-xs text-slate-500">
          Could not refresh — will retry automatically.
        </p>
      )}
    </aside>
  );
}
