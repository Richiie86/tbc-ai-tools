import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2, AlertTriangle, XCircle, RefreshCw, Clock, Activity, Database, Brain,
} from 'lucide-react';
import api from '../lib/api';

/**
 * Public status page (`/status`) — no auth required. Pulls one snapshot
 * from `GET /api/status` and renders a clean, link-friendly summary of
 * uptime, AI-model health, and recent incidents. Auto-refreshes every
 * 30s so a tab left open in the corner stays current.
 *
 * Data sources are all things we already capture elsewhere — the page is
 * a read-only surface, not its own data pipeline.
 */
export default function Status() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/status');
      setData(data);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.detail || 'Status check failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="min-h-screen bg-ink-950 text-tbc-100">
      {/* HEADER */}
      <header className="border-b border-tbc-900/60 bg-ink-900/60">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2 text-tbc-100 hover:text-tbc-300">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
              <Activity className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-bold">TBC AI Tools</div>
              <div className="text-[10px] uppercase tracking-wider text-tbc-200/50">System Status</div>
            </div>
          </Link>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            data-testid="status-refresh"
            className="inline-flex items-center gap-1.5 rounded-md border border-tbc-900/60 bg-ink-900 px-3 py-1.5 text-xs text-tbc-200 hover:bg-ink-950 disabled:opacity-60"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8" data-testid="status-page">
        {loading && !data ? (
          <div className="grid place-items-center py-24 text-tbc-200/50">
            <RefreshCw className="h-6 w-6 animate-spin" />
          </div>
        ) : err ? (
          <ErrorPanel message={err} />
        ) : (
          <>
            <OverallBanner overall={data.overall} checkedAt={data.checked_at} />

            <section className="mt-8">
              <SectionTitle>Components</SectionTitle>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <ComponentRow
                  icon={Database}
                  label="Database"
                  state={data.components.database}
                />
                <ComponentRow
                  icon={Brain}
                  label="AI Models"
                  state={data.components.ai_models}
                  hint={`${data.models.length} model${data.models.length === 1 ? '' : 's'} probed`}
                />
              </div>
            </section>

            <section className="mt-8">
              <SectionTitle>AI model health</SectionTitle>
              <div className="mt-3 overflow-hidden rounded-xl border border-tbc-900/60 bg-ink-900/40">
                {data.models.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-tbc-200/50">
                    No probes recorded yet. The nightly cron runs every 24 hours.
                  </div>
                ) : (
                  <table className="w-full text-sm" data-testid="status-models-table">
                    <thead className="bg-ink-950/60 text-[10px] uppercase tracking-wider text-tbc-200/50">
                      <tr>
                        <th className="px-4 py-2 text-left">Model</th>
                        <th className="px-4 py-2 text-left">Status</th>
                        <th className="px-4 py-2 text-left">Latency</th>
                        <th className="px-4 py-2 text-left">Last probed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.models.map((m) => (
                        <tr key={m.model} className="border-t border-tbc-900/40">
                          <td className="px-4 py-2 font-mono text-xs text-tbc-100">{m.model}</td>
                          <td className="px-4 py-2">
                            <StatusPill ok={m.pass} failed={m.probes_failed} />
                          </td>
                          <td className="px-4 py-2 text-xs text-tbc-200/80">
                            {m.avg_latency_ms ? `${m.avg_latency_ms} ms` : '—'}
                          </td>
                          <td className="px-4 py-2 text-xs text-tbc-200/60">
                            {m.checked_at ? <Relative iso={m.checked_at} /> : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            <section className="mt-8 mb-12">
              <SectionTitle>
                Recent incidents
                <span className="ml-2 text-[10px] font-normal text-tbc-200/40">
                  last 7 days · {data.critical_errors_24h} in 24h
                </span>
              </SectionTitle>
              <div className="mt-3 space-y-2">
                {data.incidents.length === 0 ? (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] px-4 py-6 text-center">
                    <CheckCircle2 className="mx-auto h-6 w-6 text-emerald-300" />
                    <p className="mt-2 text-sm text-emerald-200">No incidents in the last 7 days.</p>
                  </div>
                ) : (
                  data.incidents.map((inc) => (
                    <article
                      key={inc.signature}
                      data-testid={`status-incident-${inc.signature}`}
                      className="rounded-xl border border-rose-500/30 bg-rose-500/[0.04] px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-rose-300">
                            {inc.source} · ×{inc.count}
                          </div>
                          <div className="mt-1 font-mono text-xs text-rose-100">{inc.message}</div>
                        </div>
                        <div className="text-right text-[10px] text-tbc-200/60">
                          <div className="flex items-center justify-end gap-1">
                            <Clock className="h-3 w-3" />
                            <Relative iso={inc.last_seen} />
                          </div>
                          <div className="mt-1">first <Relative iso={inc.first_seen} /></div>
                        </div>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>

            <footer className="border-t border-tbc-900/60 pt-4 text-[11px] text-tbc-200/50">
              <p>
                Snapshot taken {data.checked_at && <Relative iso={data.checked_at} />}.
                Page auto-refreshes every 30 seconds.
              </p>
              <p className="mt-1">
                Reporting an outage? <Link to="/contact" className="text-tbc-300 hover:text-tbc-100 underline">Contact support</Link>.
              </p>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <h2 className="text-[11px] font-bold uppercase tracking-wider text-tbc-200/60">{children}</h2>
  );
}

function OverallBanner({ overall, checkedAt }) {
  const cfg = {
    operational: {
      Icon: CheckCircle2,
      label: 'All systems operational',
      cls: 'border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-200',
      iconCls: 'text-emerald-300',
    },
    degraded: {
      Icon: AlertTriangle,
      label: 'Degraded performance',
      cls: 'border-amber-500/40 bg-amber-500/[0.06] text-amber-200',
      iconCls: 'text-amber-300',
    },
    outage: {
      Icon: XCircle,
      label: 'Major outage',
      cls: 'border-rose-500/40 bg-rose-500/[0.06] text-rose-200',
      iconCls: 'text-rose-300',
    },
  }[overall] || {
    Icon: AlertTriangle,
    label: 'Status unknown',
    cls: 'border-tbc-900/60 bg-ink-900/40 text-tbc-200',
    iconCls: 'text-tbc-200/60',
  };
  const { Icon, label, cls, iconCls } = cfg;
  return (
    <section
      data-testid={`status-overall-${overall}`}
      className={`flex items-center gap-4 rounded-2xl border px-6 py-5 ${cls}`}
    >
      <Icon className={`h-10 w-10 ${iconCls}`} strokeWidth={1.5} />
      <div>
        <div className="text-xl font-bold">{label}</div>
        <div className="mt-0.5 text-[11px] opacity-70">
          Updated {checkedAt && <Relative iso={checkedAt} />}
        </div>
      </div>
    </section>
  );
}

function ComponentRow({ icon: Icon, label, state, hint }) {
  const tone = {
    operational: 'border-emerald-500/30 bg-emerald-500/[0.05]',
    degraded:    'border-amber-500/30 bg-amber-500/[0.05]',
    outage:      'border-rose-500/40 bg-rose-500/[0.06]',
    unknown:     'border-tbc-900/60 bg-ink-900/40',
  }[state] || 'border-tbc-900/60 bg-ink-900/40';
  const dot = {
    operational: 'bg-emerald-400',
    degraded:    'bg-amber-400',
    outage:      'bg-rose-400',
    unknown:     'bg-tbc-200/40',
  }[state] || 'bg-tbc-200/40';
  return (
    <div
      data-testid={`status-component-${label.toLowerCase().replace(/\s+/g, '-')}`}
      className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${tone}`}
    >
      <span className="grid h-9 w-9 place-items-center rounded-lg bg-ink-950/60 text-tbc-200">
        <Icon className="h-4 w-4" />
      </span>
      <div className="flex-1">
        <div className="text-sm font-semibold text-tbc-100">{label}</div>
        {hint && <div className="text-[10px] text-tbc-200/50">{hint}</div>}
      </div>
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-tbc-200/80">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {state}
      </span>
    </div>
  );
}

function StatusPill({ ok, failed }) {
  if (ok) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
        <CheckCircle2 className="h-3 w-3" /> Pass
      </span>
    );
  }
  return (
    <span
      title={failed?.length ? `Failed probes: ${failed.join(', ')}` : 'Failing'}
      className="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-300"
    >
      <XCircle className="h-3 w-3" /> Fail
      {failed?.length > 0 && (
        <span className="ml-0.5 rounded-full bg-rose-500/30 px-1.5 text-[9px] text-rose-100">
          {failed.length}
        </span>
      )}
    </span>
  );
}

function ErrorPanel({ message }) {
  return (
    <div className="rounded-xl border border-rose-500/40 bg-rose-500/[0.06] px-6 py-8 text-center">
      <XCircle className="mx-auto h-8 w-8 text-rose-300" />
      <h2 className="mt-3 text-base font-bold text-rose-100">Status check failed</h2>
      <p className="mt-1 text-xs text-rose-200/80">{message}</p>
    </div>
  );
}

/** Compact relative time — "2m ago", "3h ago", "5d ago". Falls back to a
 *  formatted timestamp for older entries.
 */
function Relative({ iso }) {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const s = Math.max(0, Math.floor(diffMs / 1_000));
  let label;
  if (s < 60) label = `${s}s ago`;
  else if (s < 3_600) label = `${Math.floor(s / 60)}m ago`;
  else if (s < 86_400) label = `${Math.floor(s / 3_600)}h ago`;
  else if (s < 7 * 86_400) label = `${Math.floor(s / 86_400)}d ago`;
  else label = d.toLocaleDateString();
  return <span title={d.toLocaleString()}>{label}</span>;
}
