import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { toast } from 'sonner';
import {
  Stethoscope, Loader2, CheckCircle2, XCircle, RefreshCw, Wand2, Zap,
} from 'lucide-react';

/**
 * DeployDiagnosticsPanel — a self-contained operator card that answers
 * "why won't Deploy / the domain connect?" in one click, and automates the
 * one-time `*.tbctools.org` wildcard setup so every project gets an instant
 * subdomain.
 *
 * Purely additive: it renders inside the Domains tab underneath the existing
 * panels and calls the new /operator/deploy/preflight + /wildcard endpoints.
 */
export default function DeployDiagnosticsPanel() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [wildcard, setWildcard] = useState(null);

  const runPreflight = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/operator/deploy/preflight');
      setReport(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Diagnostics failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWildcard = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/deploy/wildcard/status');
      setWildcard(data);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    runPreflight();
    loadWildcard();
  }, [runPreflight, loadWildcard]);

  const bootstrapWildcard = async () => {
    setBootstrapping(true);
    try {
      const { data } = await api.post('/operator/deploy/wildcard/bootstrap');
      if (data?.ok) {
        toast.success('Wildcard *.tbctools.org DNS is set — every new project '
          + 'gets an instant subdomain.');
      } else if (data?.manual) {
        toast.message('Manual step needed — see the record shown below.');
      } else {
        toast.error(data?.reason || 'Could not set the wildcard DNS.');
      }
      setWildcard((w) => ({ ...(w || {}), last: data }));
      loadWildcard();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Bootstrap failed');
    } finally {
      setBootstrapping(false);
    }
  };

  const checks = report?.checks || [];

  return (
    <div
      className="rounded-xl border border-tbc-500/25 bg-gradient-to-br from-tbc-500/[0.05] via-ink-900/60 to-ink-900/60 p-5"
      data-testid="deploy-diagnostics-panel"
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
            <Stethoscope className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-bold text-tbc-100">Deploy &amp; domain diagnostics</h3>
            <p className="text-xs text-tbc-200/60">
              Checks every setting the Deploy button + domain connect flow needs.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={runPreflight}
          disabled={loading}
          data-testid="run-preflight"
          className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
        >
          {loading
            ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
          Diagnose
        </Button>
      </div>

      {report && (
        <div
          className={`mb-4 flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium ${
            report.ready
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
          }`}
        >
          {report.ready
            ? <CheckCircle2 className="h-4 w-4 shrink-0" />
            : <XCircle className="h-4 w-4 shrink-0" />}
          <span>{report.summary}</span>
        </div>
      )}

      <div className="space-y-2" data-testid="preflight-checks">
        {checks.map((c) => (
          <div
            key={c.name}
            className="rounded-lg border border-tbc-900/60 bg-ink-950/50 px-3 py-2.5"
          >
            <div className="flex items-start gap-2">
              {c.ok
                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
                : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-tbc-100">{c.name}</p>
                <p className="text-xs text-tbc-200/70">{c.detail}</p>
                {!c.ok && c.fix && (
                  <p className="mt-1 text-xs text-amber-200/90">Fix: {c.fix}</p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Wildcard / auto-subdomain automation */}
      <div className="mt-5 rounded-lg border border-sky-500/25 bg-sky-500/[0.05] p-4">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-sky-300" />
          <h4 className="text-sm font-bold text-tbc-100">Instant subdomains</h4>
        </div>
        <p className="mt-1 text-xs text-tbc-200/70">
          One-time setup of <span className="font-mono text-sky-200">*.{wildcard?.platform_domain || 'tbctools.org'}</span>{' '}
          so every new project is instantly live at{' '}
          <span className="font-mono text-sky-200">&lt;slug&gt;.{wildcard?.platform_domain || 'tbctools.org'}</span>.
          {typeof wildcard?.projects_with_subdomain === 'number' && (
            <> Currently {wildcard.projects_with_subdomain} project(s) have a subdomain.</>
          )}
        </p>
        {wildcard?.last?.manual && (
          <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
            Add this DNS record at the registrar holding the root:{' '}
            <span className="font-mono">
              {wildcard.last.record?.type} {wildcard.last.record?.host} → {wildcard.last.record?.value}
            </span>
          </div>
        )}
        <Button
          onClick={bootstrapWildcard}
          disabled={bootstrapping}
          data-testid="wildcard-bootstrap"
          className="mt-3 h-9 bg-sky-500 font-semibold text-ink-950 hover:bg-sky-400"
        >
          {bootstrapping
            ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            : <Wand2 className="mr-1.5 h-4 w-4" />}
          Set up wildcard DNS
        </Button>
      </div>
    </div>
  );
}
