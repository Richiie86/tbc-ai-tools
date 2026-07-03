import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import {
  Brain, Loader2, Sparkles, TrendingUp, Network, Bot, GitBranch, LayoutGrid,
  ChevronDown, Circle,
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
  const [loading, setLoading] = useState(true);
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
      const [m, t, s] = await Promise.all([
        api.get('/operator/ai-brain/maturity'),
        api.get('/operator/ai-brain/timeline', { params: { weeks: 12 } }),
        api.get('/operator/ai-brain/skills'),
      ]);
      setMaturity(m.data);
      setTimeline(t.data);
      setSkills(s.data);
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

const MODEL_LABEL = {
  all:    { name: 'All models',  color: 'text-tbc-100',     border: 'border-tbc-500/40', bg: 'bg-tbc-500/[0.08]' },
  claude: { name: 'Claude',      color: 'text-violet-300',  border: 'border-violet-500/30', bg: 'bg-violet-500/[0.06]' },
  gpt:    { name: 'GPT',         color: 'text-emerald-300', border: 'border-emerald-500/30', bg: 'bg-emerald-500/[0.06]' },
  gemini: { name: 'Gemini',      color: 'text-sky-300',     border: 'border-sky-500/30', bg: 'bg-sky-500/[0.06]' },
  other:  { name: 'Other',       color: 'text-tbc-200',     border: 'border-tbc-900/60', bg: 'bg-ink-900/50' },
};

function ModelCard({ m, defaultModel }) {
  const cfg = MODEL_LABEL[m.model] || MODEL_LABEL.other;
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
      <div className="mt-2 text-2xl font-bold text-tbc-100">
        {m.total}
        <span className="ml-1 text-[10px] font-normal text-tbc-200/50">active</span>
      </div>
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

    // Root "Brain" node — centred above the bucket row.
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
