import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { toast } from 'sonner';
import {
  Wand2, Loader2, GitBranch, AlertTriangle, FileText, ExternalLink, X, History, ShieldAlert,
  ShieldCheck, ShieldX, Eye,
} from 'lucide-react';

/**
 * Operator-only AI Build tab. Natural-language → PR pipeline.
 *
 * Flow:
 *   1. Operator picks a deploy project + types a prompt.
 *   2. POST /api/operator/ai-build/plan returns {summary, files[], blocked[]}.
 *   3. Operator reviews the diff list — each file shows action/rationale + a
 *      collapsible content preview.
 *   4. "Open PR" calls POST /api/operator/ai-build/open-pr which creates a
 *      branch, commits the files, and opens a PR. We surface the PR URL.
 *
 * Safety guardrails (matching backend BLOCKED_PATH_PATTERNS):
 *   - auth, payments, models.py, .env are NEVER touched.
 *   - Blocked paths the LLM proposed are listed below the plan so the
 *     operator can see what was filtered.
 */
export default function AIBuildTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [planning, setPlanning] = useState(false);
  const [opening, setOpening] = useState(false);
  const [plan, setPlan] = useState(null);
  const [history, setHistory] = useState([]);
  const [expandedFile, setExpandedFile] = useState(null);
  const [sourceErrorId, setSourceErrorId] = useState(null);
  const formRef = useRef(null);

  const loadProjects = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/deploy/projects');
      const list = data?.projects || data || [];
      setProjects(list);
      if (!projectId && list[0]) setProjectId(list[0].id);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load projects');
    }
  }, [projectId]);

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await api.get('/operator/ai-build/history');
      setHistory(data?.entries || []);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { loadProjects(); loadHistory(); }, [loadProjects, loadHistory]);

  /** Consume `?prefill_prompt=…&prefill_error_id=…` (set by the Errors tab
   *  "Generate fix PR" button). We pre-fill once, scroll the form into
   *  view, then strip both params from the URL so a page-refresh doesn't
   *  keep replaying the same prefill. The `tab=ai-build` param stays so
   *  the operator lands here on refresh.
   */
  useEffect(() => {
    const pre = searchParams.get('prefill_prompt');
    const errId = searchParams.get('prefill_error_id');
    if (!pre) return;
    setPrompt(pre);
    if (errId) setSourceErrorId(errId);
    const next = new URLSearchParams(searchParams);
    next.delete('prefill_prompt');
    next.delete('prefill_error_id');
    setSearchParams(next, { replace: true });
    // Scroll after paint so the operator immediately sees the populated form.
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (!projectId) { toast.error('Pick a project first'); return; }
    if (prompt.trim().length < 4) { toast.error('Tell the AI what to build (4+ chars)'); return; }
    setPlanning(true);
    setPlan(null);
    setExpandedFile(null);
    try {
      const { data } = await api.post('/operator/ai-build/plan', {
        project_id: projectId,
        prompt: prompt.trim(),
      });
      setPlan(data);
      if (data.refusal_reason) {
        toast.warning(`AI refused: ${data.refusal_reason}`);
      } else if (!data.files?.length) {
        toast.warning('AI returned no actionable files.');
      } else {
        toast.success(`Plan ready · ${data.files.length} file${data.files.length === 1 ? '' : 's'}`);
      }
    } catch (e) {
      const msg = e?.response?.data?.detail || 'Plan failed';
      // The github_token-missing case is the single most common 503 here;
      // make the toast actionable instead of a dead red message.
      if (/github_token/i.test(String(msg))) {
        toast.error('GitHub token not set — opening Settings…', { duration: 2000 });
        setTimeout(() => { window.location.href = '/operator?tab=settings'; }, 1100);
      } else {
        toast.error(msg);
      }
    } finally {
      setPlanning(false);
    }
  };

  const openPR = async () => {
    if (!plan?.plan_id) return;
    if (!window.confirm(`Open a PR with ${plan.files.length} file change${plan.files.length === 1 ? '' : 's'}?\n\nA new branch will be created and a PR opened against ${projectId}. Nothing ships to production until you merge.`)) return;
    setOpening(true);
    try {
      const { data } = await api.post('/operator/ai-build/open-pr', { plan_id: plan.plan_id });
      toast.success(`PR #${data.pr_number} opened`);
      window.open(data.pr_url, '_blank', 'noopener');
      setPlan(null);
      setPrompt('');
      loadHistory();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'PR creation failed');
    } finally {
      setOpening(false);
    }
  };

  const discard = async () => {
    if (!plan?.plan_id) { setPlan(null); return; }
    try {
      await api.delete(`/operator/ai-build/plan/${plan.plan_id}`);
    } catch { /* swallow */ }
    setPlan(null);
    setPrompt('');
    toast.success('Plan discarded');
  };

  return (
    <div className="space-y-6" data-testid="ai-build-tab">
      {/* SAFETY BANNER */}
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.05] px-4 py-3 text-[12px] text-amber-200/90">
        <ShieldAlert className="mr-1.5 inline h-4 w-4 -mt-0.5" />
        AI Build opens a <strong>Pull Request</strong> — nothing ships to production until you merge.
        Auth, payments, schemas, and <code>.env</code> are server-side blocked.
      </div>

      {/* PROMPT FORM */}
      <section ref={formRef} className="rounded-xl border border-tbc-900/60 bg-ink-900/40 p-5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-tbc-100">
          <Wand2 className="h-4 w-4 text-tbc-300" />
          Describe the change
        </h3>
        {sourceErrorId && (
          <div
            data-testid="ai-build-from-error-banner"
            className="mt-2 rounded border border-emerald-500/30 bg-emerald-500/[0.05] px-3 py-1.5 text-[11px] text-emerald-200"
          >
            Pre-filled from runtime error <code className="font-mono">{sourceErrorId.slice(0, 16)}</code> · review the prompt below, edit if needed, then Plan changes.
          </div>
        )}
        <div className="mt-3 space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-tbc-300">Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              data-testid="ai-build-project-select"
              className="mt-1 block w-full rounded-md border border-tbc-900/60 bg-ink-950 px-3 py-2 text-sm text-tbc-100"
            >
              {projects.length === 0 ? (
                <option value="">No deploy projects — add one in the Projects tab</option>
              ) : (
                projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.projectName} · {p.repo}</option>
                ))
              )}
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-tbc-300">Request</label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Add a public /sitemap.xml route that lists all marketing pages, or add a 'Copy referral link' button to the user dashboard."
              rows={4}
              maxLength={4000}
              data-testid="ai-build-prompt"
              className="mt-1 border-tbc-900/60 bg-ink-950 text-tbc-100"
            />
            <div className="mt-1 flex items-center justify-between text-[10px] text-tbc-200/50">
              <span>Be specific — what to add, where to add it, what it should look like.</span>
              <span>{prompt.length} / 4000</span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={submit}
              disabled={planning || !projectId || prompt.trim().length < 4}
              data-testid="ai-build-plan"
              className="bg-tbc-500 text-ink-950 hover:bg-tbc-400 font-bold"
            >
              {planning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
              {planning ? 'Planning…' : 'Plan changes'}
            </Button>
          </div>
        </div>
      </section>

      {/* PLAN RESULT */}
      {plan && (
        <section
          data-testid="ai-build-plan-result"
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] p-5"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-emerald-200">{plan.summary}</h3>
              <p className="mt-1 text-[11px] text-emerald-200/60">
                Model: {plan.model} · Plan id: <span className="font-mono">{plan.plan_id}</span> · Branch: <span className="font-mono">ai-build/{plan.branch_slug}-…</span>
              </p>
            </div>
            <button
              type="button"
              onClick={discard}
              data-testid="ai-build-discard"
              className="rounded-md p-1 text-tbc-200/60 hover:bg-rose-500/10 hover:text-rose-300"
              aria-label="Discard plan"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {plan.refusal_reason && (
            <div className="mt-3 rounded border border-rose-500/40 bg-rose-500/[0.06] px-3 py-2 text-xs text-rose-200">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5 -mt-0.5" />
              AI refused: {plan.refusal_reason}
            </div>
          )}

          {/* Cross-AI review verdict — a second model (different provider)
              independently audits the patch. Surfaced before "Open PR" so
              the operator can spot hallucinations before they ship. */}
          {plan.review && (
            <ReviewPanel review={plan.review} />
          )}

          {plan.blocked?.length > 0 && (
            <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
              <strong>Blocked paths ({plan.blocked.length}):</strong>
              <ul className="mt-1 space-y-0.5">
                {plan.blocked.map((b) => (
                  <li key={b.path} className="font-mono text-[11px]">{b.path} — {b.reason}</li>
                ))}
              </ul>
            </div>
          )}

          {plan.files?.length > 0 && (
            <ul className="mt-4 space-y-2" data-testid="ai-build-files">
              {plan.files.map((f, i) => (
                <li key={f.path} className="rounded-md border border-tbc-900/60 bg-ink-950 px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <FileText className="h-3.5 w-3.5 text-tbc-300 shrink-0" />
                        <span className="truncate font-mono text-tbc-100">{f.path}</span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase ${f.action === 'create' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-tbc-500/20 text-tbc-300'}`}>
                          {f.action}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-tbc-200/60">{f.rationale}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setExpandedFile(expandedFile === i ? null : i)}
                      data-testid={`ai-build-file-toggle-${i}`}
                      className="shrink-0 text-[10px] text-tbc-300 hover:text-tbc-100"
                    >
                      {expandedFile === i ? 'Hide' : 'View'} ›
                    </button>
                  </div>
                  {expandedFile === i && (
                    <pre className="mt-2 max-h-72 overflow-auto rounded border border-tbc-900/60 bg-ink-950 p-2 text-[10px] leading-relaxed text-tbc-200/80">
                      {f.content}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}

          {plan.files?.length > 0 && (
            <div className="mt-4 flex gap-2">
              <Button
                onClick={openPR}
                disabled={opening}
                data-testid="ai-build-open-pr"
                className="bg-emerald-500 text-ink-950 hover:bg-emerald-400 font-bold"
              >
                {opening ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <GitBranch className="mr-2 h-4 w-4" />}
                {opening ? 'Opening PR…' : 'Open PR'}
              </Button>
              <Button
                variant="outline"
                onClick={discard}
                disabled={opening}
                className="border-tbc-900/60 bg-ink-950 text-tbc-200 hover:bg-ink-900"
              >
                Discard
              </Button>
            </div>
          )}
        </section>
      )}

      {/* HISTORY */}
      <section className="rounded-xl border border-tbc-900/60 bg-ink-900/40 p-5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-tbc-100">
          <History className="h-4 w-4 text-tbc-300" /> Recent requests
        </h3>
        {history.length === 0 ? (
          <p className="mt-2 text-xs text-tbc-200/50">No requests yet. Type something above and click Plan changes.</p>
        ) : (
          <ul className="mt-3 space-y-2" data-testid="ai-build-history">
            {history.map((h) => (
              <li
                key={h.plan_id}
                className="flex items-start justify-between gap-3 rounded-md border border-tbc-900/60 bg-ink-950 px-3 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-tbc-100">{h.summary || h.prompt}</div>
                  <div className="mt-0.5 text-[10px] text-tbc-200/50">
                    {new Date(h.created_at).toLocaleString()} · {h.status}
                    {h.refusal_reason ? ` · refused: ${h.refusal_reason}` : ''}
                  </div>
                </div>
                {h.pr_url ? (
                  <div className="flex shrink-0 items-center gap-3">
                    <PreviewButton planId={h.plan_id} />
                    <a
                      href={h.pr_url}
                      target="_blank"
                      rel="noreferrer"
                      data-testid={`ai-build-history-pr-${h.plan_id}`}
                      className="inline-flex items-center gap-1 text-tbc-300 hover:text-tbc-100"
                    >
                      PR #{h.pr_number} <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                ) : (
                  <span className="shrink-0 text-[10px] uppercase text-tbc-200/40">{h.status}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Cross-AI review verdict surfaced under the plan, before "Open PR". */
function ReviewPanel({ review }) {
  const v = review?.verdict;
  const tone = v === 'ship'
    ? { Icon: ShieldCheck, label: 'Reviewer says ship', cls: 'border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-200', iconCls: 'text-emerald-300' }
    : v === 'ship_with_concerns'
      ? { Icon: AlertTriangle, label: 'Ship with concerns', cls: 'border-amber-500/40 bg-amber-500/[0.06] text-amber-200', iconCls: 'text-amber-300' }
      : v === 'do_not_ship'
        ? { Icon: ShieldX, label: 'Reviewer says do NOT ship', cls: 'border-rose-500/40 bg-rose-500/[0.06] text-rose-200', iconCls: 'text-rose-300' }
        : { Icon: AlertTriangle, label: 'Review skipped', cls: 'border-tbc-900/60 bg-ink-950 text-tbc-200/70', iconCls: 'text-tbc-200/50' };
  const { Icon, label, cls, iconCls } = tone;
  return (
    <div
      data-testid={`ai-build-review-${v || 'unknown'}`}
      className={`mt-3 rounded border px-3 py-2.5 text-xs ${cls}`}
    >
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${iconCls}`} />
        <span className="font-semibold">{label}</span>
        <span className="ml-auto text-[10px] opacity-60">via {review.reviewer_model}</span>
      </div>
      {review.summary && (
        <p className="mt-1 text-[11px] opacity-90">{review.summary}</p>
      )}
      {review.concerns?.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {review.concerns.map((c, i) => (
            <li key={`c-${i}`} className="text-[11px]">• {c}</li>
          ))}
        </ul>
      )}
      {review.missing_imports?.length > 0 && (
        <div className="mt-2 text-[10px] uppercase tracking-wider opacity-60">Possibly missing imports:</div>
      )}
      {review.missing_imports?.map((m, i) => (
        <div key={`mi-${i}`} className="font-mono text-[10px] opacity-90">{m}</div>
      ))}
      {review.security_flags?.length > 0 && (
        <div className="mt-2 text-[10px] uppercase tracking-wider opacity-60">Security flags:</div>
      )}
      {review.security_flags?.map((s, i) => (
        <div key={`sf-${i}`} className="text-[10px] opacity-90">⚠ {s}</div>
      ))}
    </div>
  );
}

/** "Preview" button — polls /api/operator/ai-build/preview-url/{plan_id}
 *  until Vercel has a deployment URL for the branch. Becomes a normal link
 *  once available. Clicks the chip when not yet ready trigger one fetch
 *  rather than auto-polling forever to save bandwidth.
 */
function PreviewButton({ planId }) {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);

  const probe = async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/operator/ai-build/preview-url/${planId}`);
      setStatus(data?.status || null);
      if (data?.url) setUrl(data.url);
      else if (data?.status === 'no_vercel_token') toast.error('Set vercel_token in Operator → Security to enable previews');
      else if (data?.status === 'vercel_error') toast.error('Vercel API error — check token scopes');
      else if (data?.status === 'no_deployment') toast.message('Preview still building — try again in a few seconds');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Preview lookup failed');
    } finally {
      setLoading(false);
    }
  };

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        data-testid={`ai-build-preview-link-${planId}`}
        className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/[0.06] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/[0.12]"
      >
        <Eye className="h-3 w-3" /> Preview
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={probe}
      disabled={loading}
      data-testid={`ai-build-preview-probe-${planId}`}
      title={status === 'no_deployment' ? 'Vercel is still building this preview' : 'Look up the Vercel preview URL for this PR'}
      className="inline-flex items-center gap-1 rounded-full border border-tbc-900/60 bg-ink-900 px-2 py-0.5 text-[10px] uppercase tracking-wider text-tbc-200/70 hover:bg-ink-950"
    >
      {loading
        ? <Loader2 className="h-3 w-3 animate-spin" />
        : <Eye className="h-3 w-3" />}
      Preview{status === 'no_deployment' ? '…' : ''}
    </button>
  );
}
