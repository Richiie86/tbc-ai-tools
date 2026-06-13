import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { toast } from 'sonner';
import {
  ScrollText, RefreshCw, Loader2, ChevronLeft, ChevronRight, Filter, Download,
} from 'lucide-react';

const PAGE_SIZE = 50;

// Action → human label + tone. Anything not listed renders with neutral tone.
const ACTION_META = {
  'user.pause':           { label: 'Pause user',          tone: 'amber' },
  'user.active':          { label: 'Resume user',         tone: 'emerald' },
  'user.delete':          { label: 'Soft-delete user',    tone: 'rose' },
  'user.credits':         { label: 'Grant credits',       tone: 'tbc' },
  'user.set_plan':        { label: 'Change plan',         tone: 'sky' },
  'user.reset_2fa':       { label: 'Reset 2FA',           tone: 'rose' },
  'user.bulk_pause':      { label: 'Bulk pause',          tone: 'amber' },
  'user.bulk_resume':     { label: 'Bulk resume',         tone: 'emerald' },
  'user.bulk_delete':     { label: 'Bulk delete',         tone: 'rose' },
  'user.bulk_grant_credits': { label: 'Bulk grant credits', tone: 'tbc' },
  'user.bulk_set_plan':   { label: 'Bulk set plan',       tone: 'sky' },
  'withdraw.stripe_manual':       { label: 'Stripe payout',      tone: 'emerald' },
  'withdraw.stripe_manual.failed':{ label: 'Stripe payout fail', tone: 'rose'    },
  'withdraw.crypto_manual':       { label: 'Crypto payout',      tone: 'emerald' },
  'withdraw.crypto_manual.failed':{ label: 'Crypto payout fail', tone: 'rose'    },
  'withdraw.settings_update':     { label: 'Withdraw settings',  tone: 'sky'     },
  'deploy_project.delete':        { label: 'Project deleted',    tone: 'rose'    },
  'deploy_project.create':        { label: 'Project created',    tone: 'emerald' },
};
const TONE_CLASSES = {
  amber:   'border-amber-500/30 bg-amber-500/10 text-amber-300',
  emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  rose:    'border-rose-500/40 bg-rose-500/10 text-rose-300',
  tbc:     'border-tbc-500/30 bg-tbc-500/10 text-tbc-300',
  sky:     'border-sky-500/30 bg-sky-500/10 text-sky-300',
  neutral: 'border-tbc-900/60 bg-ink-950 text-tbc-200/70',
};

export default function AuditTab() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [distinctActions, setDistinctActions] = useState([]);
  const [skip, setSkip] = useState(0);
  const [actionFilter, setActionFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), skip: String(skip) });
      if (actionFilter) params.set('action', actionFilter);
      if (actorFilter) params.set('actor', actorFilter);
      const { data } = await api.get(`/operator/audit?${params}`);
      setRows(data.rows);
      setTotal(data.total);
      setDistinctActions(data.distinct_actions || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, [skip, actionFilter, actorFilter]);

  useEffect(() => { load(); }, [load]);

  const clearFilters = () => {
    setActionFilter('');
    setActorFilter('');
    setSkip(0);
  };

  const exportCsv = () => {
    if (rows.length === 0) {
      toast.error('Nothing to export on this page');
      return;
    }
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['created_at', 'actor_email', 'action', 'target', 'ip', 'details'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        esc(r.created_at),
        esc(r.actor_email),
        esc(r.action),
        esc(r.target || ''),
        esc(r.ip || ''),
        esc(r.details || {}),
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tbc-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} rows`);
  };

  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = !!(actionFilter || actorFilter);

  return (
    <div className="grid gap-4" data-testid="audit-tab">
      {/* HEADER */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-violet-500/15 text-violet-300">
            <ScrollText className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-bold text-tbc-100">Audit log</h3>
            <p className="text-xs text-tbc-200/60">Append-only stream of operator actions · {total.toLocaleString()} total events</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            data-testid="audit-export-csv"
            onClick={exportCsv}
            disabled={loading || rows.length === 0}
            variant="outline"
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            <Download className="mr-2 h-4 w-4" /> Export page
          </Button>
          <Button
            data-testid="audit-refresh"
            onClick={() => { setSkip(0); load(); }}
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
      </div>

      {/* FILTERS */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-tbc-900/60 bg-ink-900/40 p-3">
        <Filter className="h-4 w-4 text-tbc-200/40" />
        <Select value={actionFilter || '__any'} onValueChange={(v) => { setSkip(0); setActionFilter(v === '__any' ? '' : v); }}>
          <SelectTrigger data-testid="audit-action-filter" className="h-9 w-56 border-tbc-900/60 bg-ink-950 text-tbc-100">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent className="border-tbc-900/60 bg-ink-900 text-tbc-100 max-h-64">
            <SelectItem value="__any">All actions</SelectItem>
            {distinctActions.map((a) => (
              <SelectItem key={a} value={a}>{ACTION_META[a]?.label || a}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          data-testid="audit-actor-filter"
          placeholder="Actor email contains…"
          value={actorFilter}
          onChange={(e) => { setSkip(0); setActorFilter(e.target.value); }}
          className="h-9 w-64 border-tbc-900/60 bg-ink-950 text-tbc-100"
        />
        {hasFilters && (
          <Button
            data-testid="audit-clear-filters"
            size="sm"
            variant="ghost"
            onClick={clearFilters}
            className="text-tbc-200/70 hover:bg-ink-900 hover:text-tbc-100"
          >
            Clear
          </Button>
        )}

        {/* Quick filters — one-tap presets for the most common forensic
            questions ("who deleted that project?"). */}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-tbc-200/40">Quick:</span>
          <button
            type="button"
            data-testid="audit-quick-project-deletes"
            onClick={() => { setSkip(0); setActionFilter('deploy_project.delete'); }}
            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition ${
              actionFilter === 'deploy_project.delete'
                ? 'border-rose-500 bg-rose-500/20 text-rose-200'
                : 'border-tbc-900/60 bg-ink-950 text-tbc-200/70 hover:border-rose-500/60 hover:text-rose-200'
            }`}
          >
            Project deletions
          </button>
          <button
            type="button"
            data-testid="audit-quick-user-deletes"
            onClick={() => { setSkip(0); setActionFilter('user.delete'); }}
            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition ${
              actionFilter === 'user.delete'
                ? 'border-rose-500 bg-rose-500/20 text-rose-200'
                : 'border-tbc-900/60 bg-ink-950 text-tbc-200/70 hover:border-rose-500/60 hover:text-rose-200'
            }`}
          >
            User deletions
          </button>
        </div>
      </div>

      {/* TABLE */}
      <div className="overflow-hidden rounded-xl border border-tbc-900/60 bg-ink-900/40">
        <table className="w-full text-sm" data-testid="audit-table">
          <thead className="bg-ink-950/60 text-[10px] uppercase tracking-wider text-tbc-200/50">
            <tr>
              <th className="px-4 py-2 text-left">When</th>
              <th className="px-4 py-2 text-left">Actor</th>
              <th className="px-4 py-2 text-left">Action</th>
              <th className="px-4 py-2 text-left">Target</th>
              <th className="px-4 py-2 text-left">Details</th>
              <th className="px-4 py-2 text-left">IP</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-xs text-tbc-200/50">
                {hasFilters ? 'No events match the current filters.' : 'No audit events yet.'}
              </td></tr>
            )}
            {rows.map((r) => {
              const meta = ACTION_META[r.action] || { label: r.action, tone: 'neutral' };
              return (
                <tr key={r.id} className="border-t border-tbc-900/40 hover:bg-ink-900/30" data-testid={`audit-row-${r.id}`}>
                  <td className="px-4 py-2 text-xs text-tbc-200/70 whitespace-nowrap">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-tbc-100">{r.actor_email}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${TONE_CLASSES[meta.tone]}`}>
                      {meta.label}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-tbc-200/90">{r.target || '—'}</td>
                  <td className="px-4 py-2 text-[11px] text-tbc-200/60 font-mono max-w-md truncate" title={JSON.stringify(r.details || {})}>
                    {Object.keys(r.details || {}).length ? JSON.stringify(r.details) : '—'}
                  </td>
                  <td className="px-4 py-2 text-[11px] text-tbc-200/50 font-mono">{r.ip || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* PAGINATION */}
      <div className="flex items-center justify-between text-xs text-tbc-200/60">
        <div>
          Page {page} of {totalPages} · showing {rows.length} of {total.toLocaleString()}
        </div>
        <div className="flex gap-2">
          <Button
            data-testid="audit-prev"
            size="sm"
            variant="outline"
            disabled={skip === 0 || loading}
            onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            <ChevronLeft className="mr-1 h-3 w-3" /> Prev
          </Button>
          <Button
            data-testid="audit-next"
            size="sm"
            variant="outline"
            disabled={skip + PAGE_SIZE >= total || loading}
            onClick={() => setSkip(skip + PAGE_SIZE)}
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            Next <ChevronRight className="ml-1 h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
