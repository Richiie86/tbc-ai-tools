import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from 'sonner';
import {
  AlertOctagon, Loader2, RefreshCw, Trash2, EyeOff, Wand2, Code2,
  ChevronDown, ChevronRight,
} from 'lucide-react';

/**
 * Operator → Errors tab.
 *
 * Lists every captured runtime error (frontend + backend) grouped by
 * signature, with counts and last-seen. Each row expands to show:
 *   - Full stack trace
 *   - "Run RCA" — asks an LLM for root cause + one-line fix suggestion
 *   - "Open in Sandbox" — deep-link to /operator?tab=sandbox so the
 *     operator can fix it (manual gate — no auto-patch yet)
 *   - "Dismiss" — hides from default view
 */
export default function ErrorsTab() {
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({}); // id -> bool
  const [running, setRunning] = useState(null); // id of error currently running RCA
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null); // error pending delete

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/runtime-errors', {
        params: { include_dismissed: includeDismissed },
      });
      setErrors(data || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load errors');
    } finally {
      setLoading(false);
    }
  }, [includeDismissed]);

  useEffect(() => { load(); }, [load]);

  const runRCA = async (err) => {
    setRunning(err.id);
    try {
      const { data } = await api.post(`/operator/runtime-errors/${err.id}/rca`);
      setErrors((cur) => cur.map((e) => (e.id === err.id ? { ...e, rca: data } : e)));
      setExpanded((cur) => ({ ...cur, [err.id]: true }));
      toast.success('RCA generated');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'RCA failed');
    } finally {
      setRunning(null);
    }
  };

  const dismiss = async (err) => {
    try {
      await api.post(`/operator/runtime-errors/${err.id}/dismiss`);
      setErrors((cur) => cur.filter((e) => e.id !== err.id));
      toast.success('Dismissed');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Dismiss failed');
    }
  };

  const remove = async (err) => {
    try {
      await api.delete(`/operator/runtime-errors/${err.id}`);
      setErrors((cur) => cur.filter((e) => e.id !== err.id));
      toast.success('Deleted');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Delete failed');
    } finally {
      setConfirmDelete(null);
    }
  };

  const openInSandbox = (err) => {
    const path = err.rca?.suggested_file;
    const url = path
      ? `/operator?tab=sandbox&path=${encodeURIComponent(path)}`
      : '/operator?tab=sandbox';
    window.location.href = url;
  };

  return (
    <div className="space-y-4" data-testid="errors-tab">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-bold text-tbc-100">
            <AlertOctagon className="h-4 w-4 text-red-300" />
            Runtime errors — every uncaught exception, grouped
          </h3>
          <p className="mt-1 text-sm text-tbc-200/60">
            Backend exceptions and frontend errors land here automatically. Click any row to expand,
            then <strong>Run RCA</strong> for an LLM-powered root-cause analysis + one-line fix path.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label className="flex items-center gap-1.5 text-[11px] text-tbc-200/60">
            <input
              type="checkbox"
              checked={includeDismissed}
              onChange={(e) => setIncludeDismissed(e.target.checked)}
              data-testid="errors-include-dismissed"
            />
            Show dismissed
          </label>
          <Button
            variant="outline"
            onClick={load}
            data-testid="errors-refresh"
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="grid place-items-center py-12" data-testid="errors-loading">
          <Loader2 className="h-5 w-5 animate-spin text-tbc-400" />
        </div>
      ) : errors.length === 0 ? (
        <div className="rounded-lg border border-dashed border-tbc-900/60 bg-ink-900/30 p-8 text-center text-xs text-tbc-200/50">
          🎉 No errors. The error boundary and global handler are armed — anything that breaks
          will show up here automatically.
        </div>
      ) : (
        <ul className="space-y-2">
          {errors.map((err) => (
            <ErrorRow
              key={err.id}
              err={err}
              expanded={!!expanded[err.id]}
              onToggle={() => setExpanded((cur) => ({ ...cur, [err.id]: !cur[err.id] }))}
              running={running === err.id}
              onRunRCA={() => runRCA(err)}
              onDismiss={() => dismiss(err)}
              onDelete={() => setConfirmDelete(err)}
              onOpenInSandbox={() => openInSandbox(err)}
            />
          ))}
        </ul>
      )}

      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
      >
        <AlertDialogContent
          data-testid="error-delete-dialog"
          className="bg-ink-900 border-tbc-900/60 text-tbc-100"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this error permanently?</AlertDialogTitle>
            <AlertDialogDescription className="text-tbc-200/70">
              This drops it from the database, including any cached RCA. Use <strong>Dismiss</strong> instead
              if you just want to hide it from the default view.
              {confirmDelete && (
                <span className="mt-2 block rounded bg-ink-950 p-2 font-mono text-[11px] text-tbc-100">
                  {confirmDelete.message?.slice(0, 200)}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="error-delete-cancel"
              className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="error-delete-confirm"
              onClick={() => confirmDelete && remove(confirmDelete)}
              className="bg-red-500 text-white hover:bg-red-600 font-bold"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ErrorRow({ err, expanded, onToggle, running, onRunRCA, onDismiss, onDelete, onOpenInSandbox }) {
  const sourceColor =
    err.source === 'backend' ? 'text-violet-300 border-violet-500/30 bg-violet-500/[0.06]' :
    err.source === 'sandbox' ? 'text-amber-300 border-amber-500/30 bg-amber-500/[0.06]' :
    'text-sky-300 border-sky-500/30 bg-sky-500/[0.06]';
  return (
    <li
      data-testid={`error-row-${err.id}`}
      className={`rounded-md border bg-ink-900/40 ${err.dismissed ? 'opacity-50' : ''} ${sourceColor.split(' ')[1]}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-2 p-2.5 text-left"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 mt-0.5 text-tbc-300" />
                  : <ChevronRight className="h-3.5 w-3.5 shrink-0 mt-0.5 text-tbc-300" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${sourceColor}`}>
              {err.source}
            </span>
            <span className="text-[10px] text-tbc-200/40">
              ×{err.count} · last {err.last_seen_at?.slice(0, 19).replace('T', ' ')}
            </span>
          </div>
          <div className="mt-1 truncate text-sm text-tbc-100" title={err.message}>
            {err.message}
          </div>
          {err.url && (
            <div className="truncate text-[10px] text-tbc-200/40">at {err.url}</div>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-tbc-900/60 p-2.5 space-y-3">
          {err.stack && (
            <details>
              <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-tbc-300 hover:text-tbc-100">
                Stack trace
              </summary>
              <pre className="mt-1.5 max-h-64 overflow-auto rounded bg-ink-950 p-2 text-[10px] leading-snug text-tbc-100 whitespace-pre-wrap">
                {err.stack}
              </pre>
            </details>
          )}

          {err.rca && (
            <div data-testid={`error-rca-${err.id}`} className="rounded border border-tbc-500/40 bg-tbc-500/[0.04] p-2.5">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-tbc-300">
                <span>RCA · confidence: {err.rca.confidence || '—'}</span>
                {err.rca.parse_fallback && (
                  <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-300">
                    ⚠️ raw output — LLM didn't return valid JSON
                  </span>
                )}
              </div>
              <div className="mt-1 text-sm text-tbc-100">{err.rca.root_cause}</div>
              {err.rca.suggested_file && (
                <div className="mt-1.5 text-[11px]">
                  <span className="text-tbc-200/50">Suggested file: </span>
                  <code className="text-tbc-100">{err.rca.suggested_file}</code>
                </div>
              )}
              {err.rca.suggested_change && (
                <div className="mt-1 text-[11px] text-tbc-200/80">
                  <span className="text-tbc-200/50">Change: </span>
                  {err.rca.suggested_change}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={onRunRCA}
              disabled={running}
              data-testid={`error-rca-btn-${err.id}`}
              className="h-7 bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-bold"
            >
              {running
                ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" />Analysing…</>
                : <><Wand2 className="mr-1 h-3 w-3" />{err.rca ? 'Re-run RCA' : 'Run RCA'}</>}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onOpenInSandbox}
              data-testid={`error-sandbox-btn-${err.id}`}
              className="h-7 border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            >
              <Code2 className="mr-1 h-3 w-3" />Open in Sandbox
            </Button>
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={onDismiss}
                data-testid={`error-dismiss-${err.id}`}
                className="h-7 text-tbc-200/60 hover:text-tbc-100"
              >
                <EyeOff className="mr-1 h-3 w-3" />Dismiss
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onDelete}
                data-testid={`error-delete-${err.id}`}
                className="h-7 text-red-300/80 hover:text-red-300"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
