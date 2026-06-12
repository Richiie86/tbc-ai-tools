import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { toast } from 'sonner';
import {
  Activity, RefreshCw, Loader2, CheckCircle2, AlertCircle, Rocket,
  Terminal, RotateCw, ServerCog, GitBranch, ExternalLink, Copy, Check,
  Mail,
} from 'lucide-react';

const SEV = (ok) => ok
  ? { dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'border-emerald-500/30 bg-emerald-500/5' }
  : { dot: 'bg-rose-400',    text: 'text-rose-300',    ring: 'border-rose-500/40 bg-rose-500/5' };

export default function OpsTab() {
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [review, setReview] = useState(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [restartingSvc, setRestartingSvc] = useState(null);
  const [deployInfo, setDeployInfo] = useState(null);
  const [copied, setCopied] = useState(false);
  const [trialRun, setTrialRun] = useState(null);
  const [trialBusy, setTrialBusy] = useState(false);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const { data } = await api.get('/operator/ops/health');
      setHealth(data);
    } catch {
      toast.error('Health check failed');
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const loadDeployInfo = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/ops/deploy-info');
      setDeployInfo(data);
    } catch {
      // silent — non-critical
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadDeployInfo();
  }, [loadHealth, loadDeployInfo]);

  const runReview = async () => {
    setReviewLoading(true);
    setReview(null);
    try {
      const { data } = await api.post('/operator/ops/code-review');
      setReview(data);
      const lintOk = data?.python?.lint?.ok;
      const fmtOk = data?.python?.format?.ok;
      if (lintOk && fmtOk) toast.success('Code review passed ✓');
      else toast.warning('Code review found issues — see report below');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Code review failed');
    } finally {
      setReviewLoading(false);
    }
  };

  const restart = async (service) => {
    if (!window.confirm(`Restart ${service}? Brief downtime (~3s).`)) return;
    setRestartingSvc(service);
    try {
      await api.post(`/operator/ops/restart?service=${service}`);
      toast.success(`${service} restarted`);
      // give services time to come back
      setTimeout(() => loadHealth(), 3500);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Restart failed');
    } finally {
      setRestartingSvc(null);
    }
  };

  const copyCommit = async () => {
    const sha = deployInfo?.commit?.sha;
    if (!sha) return;
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed');
    }
  };

  const runTrialCron = async (dryRun) => {
    setTrialBusy(true);
    setTrialRun(null);
    try {
      const { data } = await api.post(`/operator/cron/trial-reminders?dry_run=${dryRun ? 'true' : 'false'}`);
      setTrialRun(data);
      const total = (data.t3_sent || 0) + (data.expired_sent || 0);
      if (dryRun) toast.message(`Dry-run: ${total} email${total === 1 ? '' : 's'} would be sent`);
      else toast.success(`${total} trial email${total === 1 ? '' : 's'} dispatched`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Trial cron failed');
    } finally {
      setTrialBusy(false);
    }
  };

  return (
    <div className="grid gap-6" data-testid="ops-tab">
      {/* === HEALTH CHECK === */}
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
            onClick={loadHealth}
            disabled={healthLoading}
            variant="outline"
            className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
          >
            {healthLoading
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
        </div>

        {health && (
          <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
            <div className={`rounded-full border px-3 py-1 ${health.summary.failing === 0 ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300'}`}>
              {health.summary.failing === 0 ? '✓ All systems operational' : `${health.summary.failing} issue${health.summary.failing > 1 ? 's' : ''} detected`}
            </div>
            <div className="text-tbc-200/60">
              {health.summary.passing}/{health.summary.total} passing · checked {new Date(health.generated_at).toLocaleTimeString()}
            </div>
            <div className="text-tbc-200/40">commit · {health.commit}</div>
          </div>
        )}

        {healthLoading && !health ? (
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

      {/* === CODE REVIEW === */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-violet-500/15 text-violet-300">
              <Terminal className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-base font-bold text-tbc-100">Code Review</h3>
              <p className="text-xs text-tbc-200/60">Runs ruff (lint + format) across the backend and surfaces issues inline.</p>
            </div>
          </div>
          <Button
            data-testid="ops-review-run"
            onClick={runReview}
            disabled={reviewLoading}
            className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
          >
            {reviewLoading
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Terminal className="mr-2 h-4 w-4" />}
            Run code review
          </Button>
        </div>

        {review && (
          <div className="grid gap-3 lg:grid-cols-2" data-testid="ops-review-output">
            <ReviewBlock title="Backend · ruff check" result={review.python?.lint} />
            <ReviewBlock title="Backend · ruff format" result={review.python?.format} />
            <Card className="border-tbc-900/60 bg-ink-900/60 p-4 lg:col-span-2">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-tbc-200/60">Frontend</div>
              <div className="text-sm text-tbc-100">{review.frontend?.note}</div>
              <div className="mt-1 text-[11px] text-tbc-200/50">JS/JSX files indexed: {review.frontend?.js_file_count || '—'}</div>
            </Card>
          </div>
        )}
      </section>

      {/* === RESTART + DEPLOY === */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="border-tbc-900/60 bg-ink-900/60 p-5">
          <div className="mb-3 flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-amber-500/15 text-amber-300">
              <RotateCw className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-base font-bold text-tbc-100">Restart services</h3>
              <p className="text-xs text-tbc-200/60">In-cluster soft restart. Use this if a service feels stuck.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {['backend', 'frontend', 'all'].map((svc) => (
              <Button
                key={svc}
                data-testid={`ops-restart-${svc}`}
                onClick={() => restart(svc)}
                disabled={restartingSvc !== null}
                variant="outline"
                className="border-tbc-900/60 bg-ink-950 text-tbc-100 hover:bg-ink-900"
              >
                {restartingSvc === svc
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <ServerCog className="mr-2 h-4 w-4" />}
                {svc === 'all' ? 'Restart everything' : `Restart ${svc}`}
              </Button>
            ))}
          </div>
        </Card>

        <Card className="border-tbc-500/30 bg-gradient-to-br from-tbc-500/10 via-ink-900/60 to-ink-900/60 p-5">
          <div className="mb-3 flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/20 text-tbc-300">
              <Rocket className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-base font-bold text-tbc-100">Deploy / Redeploy</h3>
              <p className="text-xs text-tbc-200/60">
                Production deploy is triggered from Emergent's top-right Deploy button.
              </p>
            </div>
          </div>

          {deployInfo && (
            <div className="rounded-lg border border-tbc-900/60 bg-ink-950 p-3">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 text-tbc-200/70">
                  <GitBranch className="h-3.5 w-3.5" />
                  Latest commit
                </div>
                <button
                  data-testid="ops-copy-commit"
                  onClick={copyCommit}
                  className="inline-flex items-center gap-1 rounded border border-tbc-900/60 bg-ink-900 px-2 py-0.5 text-[11px] text-tbc-200 hover:bg-ink-950"
                >
                  {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  {copied ? 'copied' : (deployInfo.commit?.sha || '—')}
                </button>
              </div>
              <div className="mt-1 truncate text-sm font-semibold text-tbc-100" title={deployInfo.commit?.subject}>
                {deployInfo.commit?.subject || '—'}
              </div>
              <div className="mt-1 text-[11px] text-tbc-200/50">
                {deployInfo.commit?.author} · {deployInfo.commit?.date ? new Date(deployInfo.commit.date).toLocaleString() : '—'}
              </div>
            </div>
          )}

          <ol className="mt-3 space-y-1 text-xs text-tbc-200/70">
            <li>1. Click <strong className="text-tbc-100">Deploy</strong> in the Emergent chat panel (top right).</li>
            <li>2. Wait for the green check — your preview & production update together.</li>
            <li>3. Hit <strong className="text-tbc-100">Refresh</strong> on Health Check above to confirm.</li>
          </ol>

          <a
            href="https://app.emergent.sh"
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs text-tbc-300 hover:text-tbc-200"
          >
            Open Emergent <ExternalLink className="h-3 w-3" />
          </a>
        </Card>
      </section>

      {/* === TRIAL EMAIL CRON === */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-sky-500/15 text-sky-300">
              <Mail className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-base font-bold text-tbc-100">Trial reminder emails</h3>
              <p className="text-xs text-tbc-200/60">
                Runs automatically every hour. Sends a T-3 days reminder + a T-0 expired notice per user — idempotently.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              data-testid="ops-trial-dryrun"
              variant="outline"
              onClick={() => runTrialCron(true)}
              disabled={trialBusy}
              className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
            >
              {trialBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Preview (dry-run)
            </Button>
            <Button
              data-testid="ops-trial-run"
              onClick={() => runTrialCron(false)}
              disabled={trialBusy}
              className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-semibold"
            >
              {trialBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
              Send now
            </Button>
          </div>
        </div>

        {trialRun && (
          <div className="rounded-xl border border-tbc-900/60 bg-ink-900/60 p-4" data-testid="ops-trial-output">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-sky-300">
                T-3 sent: <strong>{trialRun.t3_sent}</strong>
              </span>
              <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-rose-300">
                Expired sent: <strong>{trialRun.expired_sent}</strong>
              </span>
              {trialRun.errors > 0 && (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-amber-300">
                  Errors: <strong>{trialRun.errors}</strong>
                </span>
              )}
              {trialRun.dry_run && (
                <span className="rounded-full border border-tbc-900/60 bg-ink-950 px-3 py-1 text-tbc-200/60">
                  dry-run · no emails sent
                </span>
              )}
              <span className="text-tbc-200/40">ran {new Date(trialRun.ran_at).toLocaleTimeString()}</span>
            </div>
            {trialRun.events?.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs">
                {trialRun.events.slice(0, 8).map((ev, idx) => (
                  <li key={idx} className="flex items-center justify-between rounded bg-ink-950 px-2 py-1">
                    <span className="text-tbc-100">{ev.email}</span>
                    <span className={ev.error ? 'text-rose-300' : ev.type === 't3' ? 'text-sky-300' : 'text-rose-200'}>
                      {ev.error ? `error: ${ev.error}` : ev.type === 't3' ? `T-${ev.days_left}` : 'expired'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function ReviewBlock({ title, result }) {
  if (!result) return null;
  const ok = result.ok;
  const out = (result.stdout || result.stderr || '').trim();
  return (
    <Card className={`border p-4 ${ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/40 bg-rose-500/5'}`}>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-tbc-200/60">{title}</div>
        <div className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300'}`}>
          {ok ? 'pass' : 'fail'} · {result.ms}ms
        </div>
      </div>
      <pre className="max-h-64 overflow-auto rounded-md bg-ink-950 p-3 text-[11px] leading-relaxed text-tbc-200/80 whitespace-pre-wrap break-words">
        {out || (ok ? 'No issues.' : `exit ${result.exit_code}`)}
      </pre>
    </Card>
  );
}
