import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import api from '../../lib/api';
import {
  Brain, Loader2, Sparkles, TrendingUp, Network, Bot, GitBranch, LayoutGrid,
  ChevronDown, Circle, RefreshCw, Check, X, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import ReactFlow, { Background, Controls, MarkerType } from 'reactflow';
import 'reactflow/dist/style.css';

/**
 * AI Brain — three views on top of the shared `ai_learnings` collection.
 *
 *   Maturity bars per model  → /api/operator/ai-brain/maturity
 *   12-week timeline chart   → /api/operator/ai-brain/timeline?weeks=12
 *   Skill buckets            → /api/operator/ai-brain/skills
 *
 * This tab is read-only — to add / approve / disable a learning the
 * operator still goes to the AI Learnings tab. We surface a CTA to that
 * tab next to every skill bucket so the round-trip is one click.
 */
export default function AIBrainTab() {
  const [maturity, setMaturity] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [skills, setSkills] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // Per-proposal + per-AI in-flight ids so buttons can show a spinner and
  // stay disabled without blocking the rest of the queue.
  const [busyIds, setBusyIds] = useState(() => new Set());
  // Toggle between the simple bucket grid (original) and the react-flow
  // "skill tree" graph. Persist in localStorage so the operator's
  // preference survives a refresh.
  const [skillView, setSkillView] = useState(() => {
    try { return localStorage.getItem('ai-brain-skill-view') || 'grid'; }
    catch { return 'grid'; }
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, t, s, ss, p] = await Promise.all([
        api.get('/operator/ai-brain/maturity'),
        api.get('/operator/ai-brain/timeline', { params: { weeks: 12 } }),
        api.get('/operator/ai-brain/skills'),
        api.get('/operator/ai-brain/sync-status'),
        api.get('/operator/ai-brain/proposals'),
      ]);
      setMaturity(m.data);
      setTimeline(t.data);
      setSkills(s.data);
      setSyncStatus(ss.data);
      setProposals(p.data?.proposals || []);
    } catch (e) {
      console.error('AI Brain load failed', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setSkillViewPersisted = useCallback((v) => {
    setSkillView(v);
    try { localStorage.setItem('ai-brain-skill-view', v); } catch { /* private mode */ }
  }, []);

  // Quiet refresh of just the cross-AI data (no full-page spinner) after an
  // approve / skip / sync action.
  const refreshBrain = useCallback(async () => {
    try {
      const [m, ss, p] = await Promise.all([
        api.get('/operator/ai-brain/maturity'),
        api.get('/operator/ai-brain/sync-status'),
        api.get('/operator/ai-brain/proposals'),
      ]);
      setMaturity(m.data);
      setSyncStatus(ss.data);
      setProposals(p.data?.proposals || []);
    } catch (e) {
      console.error('AI Brain refresh failed', e);
    }
  }, []);

  const withBusy = useCallback(async (id, fn) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try { await fn(); }
    finally {
      setBusyIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  }, []);

  const approveProposal = useCallback((id) => withBusy(id, async () => {
    try {
      await api.post(`/operator/ai-brain/proposals/${id}/approve`);
      toast.success('Added — every AI will use it on the next reply.');
      await refreshBrain();
    } catch { toast.error('Could not add that proposal.'); }
  }), [withBusy, refreshBrain]);

  const skipProposal = useCallback((id) => withBusy(id, async () => {
    try {
      await api.post(`/operator/ai-brain/proposals/${id}/skip`);
      toast.message('Skipped — removed from the queue.');
      await refreshBrain();
    } catch { toast.error('Could not skip that proposal.'); }
  }), [withBusy, refreshBrain]);

  const syncAi = useCallback((ai) => withBusy(`ai:${ai}`, async () => {
    try {
      const { data } = await api.post('/operator/ai-brain/sync', { ai });
      toast.success(`${data.approved} update${data.approved === 1 ? '' : 's'} applied.`);
      await refreshBrain();
    } catch { toast.error('Update failed.'); }
  }), [withBusy, refreshBrain]);

  const syncAll = useCallback(async () => {
    setSyncing(true);
    try {
      const { data } = await api.post('/operator/ai-brain/sync', {});
      toast.success(
        data.approved > 0
          ? `All AIs up to date — ${data.approved} update${data.approved === 1 ? '' : 's'} applied.`
          : 'All AIs were already up to date.',
      );
      await refreshBrain();
    } catch {
      toast.error('Sync failed. Try again.');
    } finally {
      setSyncing(false);
    }
  }, [refreshBrain]);

  if (loading) {
    return (
      <div className="grid place-items-center py-16" data-testid="ai-brain-loading">
        <Loader2 className="h-5 w-5 animate-spin text-tbc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="ai-brain-tab">
      <div>
        <h3 className="flex items-center gap-2 text-base font-bold text-tbc-100">
          <Network className="h-4 w-4 text-tbc-300" />
          AI Brain — what your assistants have learned
        </h3>
        <p className="mt-1 text-sm text-tbc-200/60">
          Three views over the same shared learning pool: maturity per model, a 12-week growth
          timeline, and an auto-categorised skill map. New learnings flow in from the AI Learnings
          tab — approve them once and every model picks them up on the next reply.
        </p>
      </div>

      {/* 1. Maturity bars */}
      <section data-testid="ai-brain-maturity">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-tbc-300">
          <Bot className="h-3 w-3" /> Maturity per model
        </div>
        <p className="mb-2 text-[11px] text-tbc-200/40">
          Tip: click any card to see the exact models behind it and which one is active.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {(maturity?.models || []).map((m) => (
            <ModelCard key={m.model} m={m} defaultModel={maturity?.default_model} />
          ))}
        </div>
      </section>

      {/* 1b. Cross-AI learning — sync + proposals review queue */}
      <CrossAiSync
        syncStatus={syncStatus}
        proposals={proposals}
        busyIds={busyIds}
        syncing={syncing}
        onSyncAll={syncAll}
        onSyncAi={syncAi}
        onApprove={approveProposal}
        onSkip={skipProposal}
      />

      {/* 2. Timeline */}
      <section data-testid="ai-brain-timeline">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-tbc-300">
          <TrendingUp className="h-3 w-3" /> Learnings added per week (last 12)
        </div>
        <div className="h-64 rounded-lg border border-tbc-900/60 bg-ink-900/60 p-3">
          {(timeline?.weeks?.length || 0) === 0 ? (
            <div className="grid h-full place-items-center text-xs text-tbc-200/40">
              No data yet — the chart fills in as the auto-learner proposes and you approve.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={(timeline?.weeks || []).map((w) => ({
                  week: w.week.slice(-4), // "Wxx" tail only — keeps axis readable
                  claude: w.counts.claude,
                  gpt: w.counts.gpt,
                  gemini: w.counts.gemini,
                  openrouter: w.counts.openrouter,
                  all: w.counts.all,
                }))}
              >
                <CartesianGrid stroke="#1f1f23" strokeDasharray="3 3" />
                <XAxis dataKey="week" stroke="#9ca3af" fontSize={11} />
                <YAxis stroke="#9ca3af" fontSize={11} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: '#0e0e10', border: '1px solid #2a2a2e', color: '#f5f5f5',
                    fontSize: '11px',
                  }}
                />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Line type="monotone" dataKey="all"    stroke="#f4cf6a" strokeWidth={2} dot={false} name="All" />
                <Line type="monotone" dataKey="claude" stroke="#b48cff" strokeWidth={1.5} dot={false} name="Claude" />
                <Line type="monotone" dataKey="gpt"    stroke="#34d399" strokeWidth={1.5} dot={false} name="GPT" />
                <Line type="monotone" dataKey="gemini" stroke="#60a5fa" strokeWidth={1.5} dot={false} name="Gemini" />
                <Line type="monotone" dataKey="openrouter" stroke="#fb923c" strokeWidth={1.5} dot={false} name="OpenRouter" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* 3. Skill buckets */}
      <section data-testid="ai-brain-skills">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-tbc-300">
            <Sparkles className="h-3 w-3" /> Skill map · {skills?.total || 0} active learnings
          </div>
          {/* View toggle: grid (original) vs. graph (react-flow). */}
          <div className="flex items-center gap-1 rounded-md border border-tbc-900/60 bg-ink-900/60 p-0.5">
            <button
              data-testid="ai-brain-skill-view-grid"
              onClick={() => setSkillViewPersisted('grid')}
              className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition ${
                skillView === 'grid'
                  ? 'bg-tbc-500/20 text-tbc-100'
                  : 'text-tbc-200/60 hover:text-tbc-100'
              }`}
            >
              <LayoutGrid className="h-3 w-3" />
              Grid
            </button>
            <button
              data-testid="ai-brain-skill-view-graph"
              onClick={() => setSkillViewPersisted('graph')}
              className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition ${
                skillView === 'graph'
                  ? 'bg-tbc-500/20 text-tbc-100'
                  : 'text-tbc-200/60 hover:text-tbc-100'
              }`}
            >
              <GitBranch className="h-3 w-3" />
              Graph
            </button>
          </div>
        </div>
        {(skills?.buckets?.length || 0) === 0 ? (
          <div className="rounded-lg border border-dashed border-tbc-900/60 bg-ink-900/30 p-6 text-center text-xs text-tbc-200/50">
            No active learnings yet. Visit the <strong>AI Learnings</strong> tab to add or approve some.
          </div>
        ) : skillView === 'graph' ? (
          <SkillTreeGraph buckets={skills?.buckets || []} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(skills?.buckets || []).map((b) => (
              <SkillBucket key={b.bucket} bucket={b} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* -------------- pieces -------------- */

function _timeAgo(iso) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

// Small badge that colours a proposal by its source AI, reusing MODEL_LABEL.
function AiBadge({ ai, label }) {
  const cfg = MODEL_LABEL[ai] || MODEL_LABEL.other;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cfg.border} ${cfg.bg} ${cfg.color}`}>
      <Circle className="h-2 w-2 fill-current" />
      {label || cfg.name}
    </span>
  );
}

function CrossAiSync({ syncStatus, proposals, busyIds, syncing, onSyncAll, onSyncAi, onApprove, onSkip }) {
  const allUpToDate = syncStatus?.all_up_to_date ?? true;
  const pendingTotal = syncStatus?.pending_total ?? 0;
  const behind = (syncStatus?.ais || []).filter((a) => !a.up_to_date);

  return (
    <section data-testid="ai-brain-sync" className="rounded-xl border border-tbc-900/60 bg-ink-900/40 p-4">
      {/* Header: status + one-press sync */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-tbc-300">
            <Network className="h-3 w-3" /> Cross-AI learning
          </div>
          <p className="mt-1 text-xs text-tbc-200/60">
            Every approved learning is shared with all AIs (Claude, GPT, Gemini, OpenRouter).
            Press sync to bring them up to date, or review each proposal below.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div
              data-testid="ai-brain-sync-pill"
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                allUpToDate
                  ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border border-amber-500/30 bg-amber-500/10 text-amber-200'
              }`}
            >
              {allUpToDate
                ? <><CheckCircle2 className="h-3.5 w-3.5" /> All AIs up to date</>
                : <><AlertTriangle className="h-3.5 w-3.5" /> {pendingTotal} to review</>}
            </div>
            <div className="mt-1 text-[10px] text-tbc-200/40">
              Last synced {_timeAgo(syncStatus?.last_synced_at)}
            </div>
          </div>
          <button
            data-testid="ai-brain-sync-all"
            onClick={onSyncAll}
            disabled={syncing || pendingTotal === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-tbc-500 px-3 py-2 text-sm font-semibold text-ink-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sync all now
          </button>
        </div>
      </div>

      {/* Needs-your-attention field: AIs that are behind + manual update */}
      {behind.length > 0 && (
        <div data-testid="ai-brain-behind" className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-200/80">
            <AlertTriangle className="h-3 w-3" /> Not up to date — update manually
          </div>
          <div className="flex flex-wrap gap-2">
            {behind.map((a) => (
              <div
                key={a.ai}
                className="flex items-center gap-2 rounded-lg border border-tbc-900/60 bg-ink-900/60 px-2.5 py-1.5"
              >
                <AiBadge ai={a.ai} label={a.label} />
                <span className="text-[11px] text-tbc-200/60">{a.pending} pending</span>
                <button
                  data-testid={`ai-brain-update-${a.ai}`}
                  onClick={() => onSyncAi(a.ai)}
                  disabled={busyIds.has(`ai:${a.ai}`)}
                  className="inline-flex items-center gap-1 rounded-md bg-amber-500/20 px-2 py-1 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-500/30 disabled:opacity-50"
                >
                  {busyIds.has(`ai:${a.ai}`) ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Update
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Proposals review queue — read each one, Add or Skip */}
      <div className="mt-4">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-tbc-300">
          <Sparkles className="h-3 w-3" /> Proposals to review
          {proposals.length > 0 && (
            <span className="rounded-full bg-tbc-500/20 px-1.5 py-0.5 text-[10px] text-tbc-100">{proposals.length}</span>
          )}
        </div>
        {proposals.length === 0 ? (
          <div className="rounded-lg border border-dashed border-tbc-900/60 bg-ink-900/30 p-6 text-center text-xs text-tbc-200/50">
            Nothing to review — every AI is up to date. New proposals from any AI will appear here.
          </div>
        ) : (
          <ul className="space-y-2">
            {proposals.map((p) => {
              const busy = busyIds.has(p.id);
              return (
                <li
                  key={p.id}
                  data-testid={`ai-brain-proposal-${p.id}`}
                  className="rounded-lg border border-tbc-900/60 bg-ink-900/60 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <AiBadge ai={p.source_ai} label={p.source_ai_label} />
                    <span className="text-[10px] text-tbc-200/40">{_timeAgo(p.created_at)}</span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-tbc-100">{p.text}</p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      data-testid={`ai-brain-approve-${p.id}`}
                      onClick={() => onApprove(p.id)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-500/30 disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Add
                    </button>
                    <button
                      data-testid={`ai-brain-skip-${p.id}`}
                      onClick={() => onSkip(p.id)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-md border border-tbc-900/60 px-3 py-1.5 text-xs font-semibold text-tbc-200/70 transition hover:bg-ink-900 disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                      Skip
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

const MODEL_LABEL = {
  all:        { name: 'All models',        color: 'text-tbc-100',     border: 'border-tbc-500/40',    bg: 'bg-tbc-500/[0.08]' },
  claude:     { name: 'Claude',            color: 'text-violet-300',  border: 'border-violet-500/30', bg: 'bg-violet-500/[0.06]' },
  gpt:        { name: 'GPT',               color: 'text-emerald-300', border: 'border-emerald-500/30', bg: 'bg-emerald-500/[0.06]' },
  gemini:     { name: 'Gemini',            color: 'text-sky-300',     border: 'border-sky-500/30',    bg: 'bg-sky-500/[0.06]' },
  openrouter: { name: 'OpenRouter',        color: 'text-orange-300',  border: 'border-orange-500/30', bg: 'bg-orange-500/[0.06]' },
  shared:     { name: 'Shared (all AIs)',  color: 'text-amber-200',   border: 'border-amber-500/30',  bg: 'bg-amber-500/[0.06]' },
  other:      { name: 'Other',             color: 'text-tbc-200',     border: 'border-tbc-900/60',    bg: 'bg-ink-900/50' },
};

function ModelCard({ m, defaultModel }) {
  const cfg = MODEL_LABEL[m.model] || { ...MODEL_LABEL.other, name: m.label || m.model };
  // Maturity bar = how much of the auto-proposed pool was approved.
  // Visual ceiling capped at 100% by hand to avoid > 100 from edge data.
  const ratio = m.approval_rate != null ? Math.min(1, Math.max(0, m.approval_rate)) : null;
  const breakdown = m.breakdown || [];
  const hasBreakdown = breakdown.length > 0;
  const [open, setOpen] = useState(false);

  return (
    <div
      data-testid={`ai-brain-model-${m.model}`}
      className={`rounded-lg border p-3 ${cfg.border} ${cfg.bg} ${hasBreakdown ? 'cursor-pointer transition hover:brightness-110' : ''}`}
      onClick={hasBreakdown ? () => setOpen((o) => !o) : undefined}
      role={hasBreakdown ? 'button' : undefined}
      tabIndex={hasBreakdown ? 0 : undefined}
      onKeyDown={hasBreakdown ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } } : undefined}
      aria-expanded={hasBreakdown ? open : undefined}
    >
      <div className={`flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider ${cfg.color}`}>
        <span>{cfg.name}</span>
        <div className="flex items-center gap-1">
          {m.last_7d_added > 0 && (
            <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] text-emerald-300">
              +{m.last_7d_added} · 7d
            </span>
          )}
          {hasBreakdown && (
            <ChevronDown className={`h-3.5 w-3.5 text-tbc-200/50 transition-transform ${open ? 'rotate-180' : ''}`} />
          )}
        </div>
      </div>
      {/* Headline = EFFECTIVE knowledge (own learnings + the shared pool that
          every AI inherits). Falls back to `total` for older API responses. */}
      <div className="mt-2 text-2xl font-bold text-tbc-100">
        {m.effective_total ?? m.total}
        <span className="ml-1 text-[10px] font-normal text-tbc-200/50">active</span>
      </div>
      {m.inherits_shared && m.shared_total > 0 && (
        <div className="mt-0.5 text-[10px] text-tbc-200/50">
          {m.total} taught directly · {m.shared_total} shared with all AIs
        </div>
      )}
      {m.pending > 0 && (
        <div className="mt-0.5 text-[10px] text-amber-300">
          {m.pending} pending auto-proposal{m.pending === 1 ? '' : 's'}
        </div>
      )}
      {/* Approval-rate maturity bar */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-tbc-200/40">
          <span>Approval rate</span>
          <span>{ratio == null ? '—' : `${Math.round(ratio * 100)}%`}</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-950">
          <div
            className="h-full rounded-full bg-gradient-to-r from-tbc-500 to-emerald-400 transition-all"
            style={{ width: `${ratio == null ? 0 : Math.round(ratio * 100)}%` }}
          />
        </div>
      </div>

      {/* Expanded: the exact models behind this card. */}
      {hasBreakdown && open && (
        <ul
          className="mt-3 space-y-1 border-t border-tbc-900/60 pt-2"
          data-testid={`ai-brain-model-breakdown-${m.model}`}
        >
          {breakdown.map((row) => {
            const isActive = defaultModel && row.model === defaultModel;
            return (
              <li
                key={row.model}
                className="flex items-center justify-between gap-2 rounded bg-ink-950/70 px-1.5 py-1 text-[10px]"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <Circle
                    className={`h-2 w-2 shrink-0 ${isActive ? 'fill-emerald-400 text-emerald-400' : 'fill-tbc-200/30 text-tbc-200/30'}`}
                  />
                  <span className="truncate font-mono text-tbc-100" title={row.model}>
                    {row.model}
                  </span>
                  {isActive && (
                    <span className="shrink-0 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-emerald-300">
                      active
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-tbc-200/50">
                  {row.total}
                  {row.pending > 0 && <span className="ml-1 text-amber-300/70">+{row.pending}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SkillBucket({ bucket }) {
  return (
    <div
      data-testid={`ai-brain-skill-${bucket.bucket}`}
      className="rounded-lg border border-tbc-900/60 bg-ink-900/40 p-3"
    >
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-tbc-300">
        <span>{bucket.bucket}</span>
        <span className="rounded-full bg-tbc-500/15 px-1.5 py-0.5 text-tbc-100">{bucket.count}</span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {bucket.items.slice(0, 6).map((it) => (
          <li
            key={it.id}
            className="rounded bg-ink-950 p-1.5 text-[11px] leading-snug text-tbc-100"
            data-testid={`ai-brain-skill-item-${it.id}`}
          >
            {it.text}
            <div className="mt-0.5 text-[9px] text-tbc-200/40">
              {it.model} · {it.created_at?.slice(0, 10) || '—'}
            </div>
          </li>
        ))}
        {bucket.items.length > 6 && (
          <li className="text-[10px] text-tbc-200/40">+ {bucket.items.length - 6} more in this skill</li>
        )}
      </ul>
    </div>
  );
}

/* -------------- Skill-tree graph (react-flow) -------------- */
//
// Layout: a "Brain" root node at the top, with each skill-bucket node
// connected below it, and the top 4 learnings of each bucket arranged
// as a column under their bucket. Pure CSS positioning — no fancy auto-
// layout because the dataset is small (~6 buckets × 4 items = 24 nodes)
// and a deterministic grid reads better than a force-directed sprawl.

const BUCKET_COLORS = {
  deploy:   { border: '#34d399', bg: 'rgba(16,185,129,0.10)' },
  code:     { border: '#f4cf6a', bg: 'rgba(244,207,106,0.10)' },
  voice:    { border: '#b48cff', bg: 'rgba(180,140,255,0.10)' },
  security: { border: '#f87171', bg: 'rgba(248,113,113,0.10)' },
  ux:       { border: '#60a5fa', bg: 'rgba(96,165,250,0.10)' },
  money:    { border: '#fbbf24', bg: 'rgba(251,191,36,0.10)' },
  general:  { border: '#94a3b8', bg: 'rgba(148,163,184,0.10)' },
};

function SkillTreeGraph({ buckets }) {
  // Compute nodes + edges once per `buckets` change. The buckets array
  // is small and stable so a useMemo keyed on its length + total item
  // count is enough — no need for a deep compare.
  const itemCount = useMemo(
    () => buckets.reduce((a, b) => a + (b.items?.length || 0), 0),
    [buckets],
  );

  const { nodes, edges } = useMemo(() => {
    const colW = 220;          // horizontal spacing between bucket columns
    const itemH = 56;          // vertical spacing between items
    const bucketY = 130;
    const firstItemY = bucketY + 90;
    const xStart = 40;

    const n = [];
    const e = [];

    // Root "Brain" node �� centred above the bucket row.
    const rootX = xStart + (buckets.length - 1) * colW / 2;
    n.push({
      id: 'brain',
      data: { label: 'AI Brain' },
      position: { x: rootX, y: 20 },
      style: {
        background: 'rgba(244,207,106,0.12)',
        border: '1px solid #f4cf6a',
        color: '#fef3c7',
        fontWeight: 700,
        fontSize: 12,
        padding: 8,
        borderRadius: 10,
        width: 120,
        textAlign: 'center',
      },
    });

    buckets.forEach((b, bi) => {
      const x = xStart + bi * colW;
      const colour = BUCKET_COLORS[b.bucket] || BUCKET_COLORS.general;
      n.push({
        id: `b-${b.bucket}`,
        data: { label: `${b.bucket.toUpperCase()} · ${b.count}` },
        position: { x, y: bucketY },
        style: {
          background: colour.bg,
          border: `1.5px solid ${colour.border}`,
          color: '#f5f5f5',
          fontSize: 11,
          fontWeight: 700,
          padding: 6,
          borderRadius: 8,
          width: 160,
          textAlign: 'center',
        },
      });
      e.push({
        id: `e-brain-${b.bucket}`,
        source: 'brain',
        target: `b-${b.bucket}`,
        style: { stroke: colour.border, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: colour.border },
      });

      // Top 4 learnings of each bucket — anything beyond shows as
      // "+N more" so the graph never explodes vertically.
      const top = (b.items || []).slice(0, 4);
      top.forEach((it, ii) => {
        n.push({
          id: `i-${b.bucket}-${it.id}`,
          data: {
            label: (
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontSize: 10, color: '#f5f5f5', lineHeight: 1.25 }}>
                  {(it.text || '').slice(0, 64)}{(it.text || '').length > 64 ? '…' : ''}
                </div>
                <div style={{ fontSize: 8, color: '#94a3b8', marginTop: 2 }}>
                  {it.model} · {(it.created_at || '').slice(0, 10)}
                </div>
              </div>
            ),
          },
          position: { x, y: firstItemY + ii * itemH },
          style: {
            background: '#0e0e10',
            border: '1px solid #2a2a2e',
            borderRadius: 6,
            padding: 4,
            width: 160,
          },
        });
        e.push({
          id: `e-${b.bucket}-${it.id}`,
          source: `b-${b.bucket}`,
          target: `i-${b.bucket}-${it.id}`,
          style: { stroke: colour.border, strokeWidth: 1, opacity: 0.65 },
        });
      });

      // "+N more" footer node when the bucket has more than 4 items.
      if ((b.items || []).length > top.length) {
        const moreId = `m-${b.bucket}`;
        n.push({
          id: moreId,
          data: { label: `+ ${b.items.length - top.length} more` },
          position: { x, y: firstItemY + top.length * itemH },
          style: {
            background: 'transparent',
            border: '1px dashed #2a2a2e',
            color: '#94a3b8',
            fontSize: 10,
            padding: 4,
            borderRadius: 6,
            width: 160,
            textAlign: 'center',
          },
        });
        e.push({
          id: `e-${moreId}`,
          source: `b-${b.bucket}`,
          target: moreId,
          style: { stroke: colour.border, strokeWidth: 1, opacity: 0.35, strokeDasharray: '4 4' },
        });
      }
    });

    return { nodes: n, edges: e };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, itemCount]);

  return (
    <div
      data-testid="ai-brain-skill-graph"
      className="h-[600px] w-full overflow-hidden rounded-lg border border-tbc-900/60 bg-ink-950/60"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1f1f23" gap={20} />
        <Controls
          showInteractive={false}
          className="!bg-ink-900 !border-tbc-900/60"
        />
      </ReactFlow>
    </div>
  );
}
