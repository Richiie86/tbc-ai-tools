import React, { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import {
  Brain, Loader2, Sparkles, TrendingUp, Network, Bot,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {(maturity?.models || []).map((m) => (
            <ModelCard key={m.model} m={m} />
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
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-tbc-300">
          <Sparkles className="h-3 w-3" /> Skill map · {skills?.total || 0} active learnings
        </div>
        {(skills?.buckets?.length || 0) === 0 ? (
          <div className="rounded-lg border border-dashed border-tbc-900/60 bg-ink-900/30 p-6 text-center text-xs text-tbc-200/50">
            No active learnings yet. Visit the <strong>AI Learnings</strong> tab to add or approve some.
          </div>
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

function ModelCard({ m }) {
  const cfg = MODEL_LABEL[m.model] || MODEL_LABEL.other;
  // Maturity bar = how much of the auto-proposed pool was approved.
  // Visual ceiling capped at 100% by hand to avoid > 100 from edge data.
  const ratio = m.approval_rate != null ? Math.min(1, Math.max(0, m.approval_rate)) : null;
  return (
    <div
      data-testid={`ai-brain-model-${m.model}`}
      className={`rounded-lg border p-3 ${cfg.border} ${cfg.bg}`}
    >
      <div className={`flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider ${cfg.color}`}>
        <span>{cfg.name}</span>
        {m.last_7d_added > 0 && (
          <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] text-emerald-300">
            +{m.last_7d_added} · 7d
          </span>
        )}
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
